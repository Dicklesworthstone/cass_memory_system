import { loadConfig } from "../config.js";
import { loadMergedPlaybook, loadPlaybook, savePlaybook, findBullet } from "../playbook.js";
import { ProcessedLog, getProcessedLogPath } from "../tracking.js";
import { findUnprocessedSessions, cassExport } from "../cass.js";
import { generateDiary } from "../diary.js";
import { reflectOnSession } from "../reflect.js";
import { validateDelta } from "../validate.js";
import { curatePlaybook } from "../curate.js";
import { expandPath, log, warn, error, now, fileExists } from "../utils.js";
import { withLock } from "../lock.js";
import { PlaybookDelta, CurationResult, Playbook } from "../types.js";
import { getUsageStats, formatCostSummary } from "../cost.js";
import chalk from "chalk";

export async function reflectCommand(
  options: {
    days?: number;
    maxSessions?: number;
    agent?: string;
    workspace?: string;
    dryRun?: boolean;
    json?: boolean;
    llm?: boolean;
    session?: string;
  } = {}
): Promise<void> {
  const config = await loadConfig();

  // Track costs before operation
  const statsBefore = await getUsageStats(config);
  
  const globalPath = expandPath(config.playbookPath);
  const repoPath = expandPath(".cass/playbook.yaml");
  const hasRepo = await fileExists(repoPath);
  const logPath = expandPath(getProcessedLogPath(options.workspace));

  // Lock both files sequentially to ensure consistent state across the entire reflection process
  // We lock Global first, then Repo to avoid deadlocks (always lock in same order) 
  
  await withLock(globalPath, async () => {
    const innerOp = async () => {
        const processedLog = new ProcessedLog(logPath);
        await processedLog.load();

        // Load fresh playbook for context
        const initialPlaybook = await loadMergedPlaybook(config);

        let sessions: string[] = [];
    if (options.session) {
      sessions = [options.session];
    } else {
      log("Searching for new sessions...", !options.json);
      try {
        sessions = await findUnprocessedSessions(
          processedLog.getProcessedPaths(),
          {
            days: options.days || config.sessionLookbackDays,
            maxSessions: options.maxSessions || 5,
            agent: options.agent
          },
          config.cassPath
        );
      } catch (err: any) {
        const msg = err?.message || String(err);
        error(`Failed to locate sessions. ${msg.includes("ENOENT") ? "Ensure cass is installed and CASS_PATH is set." : msg}`);
        return;
      }
    }

        const unprocessed = sessions.filter(s => !processedLog.has(s));

        if (unprocessed.length === 0) {
          if (!options.json) console.log(chalk.green("No new sessions to reflect on."));
          return;
        }

        if (!options.json) console.log(chalk.blue(`Found ${unprocessed.length} sessions to process.`));

        const allDeltas: PlaybookDelta[] = [];
        const CONCURRENCY = 1; 
        
        // Helper for processing a single session
        const processSession = async (sessionPath: string) => {
          if (!options.json) console.log(chalk.dim(`Processing ${sessionPath}...`));
          try {
            const diary = await generateDiary(sessionPath, config);
            const content = await cassExport(sessionPath, "text", config.cassPath, config) || "";
            
            if (content.length < 50) {
              warn(`Skipping empty session: ${sessionPath}`);
              return;
            }

            const reflectResult = await reflectOnSession(diary, initialPlaybook, config);

            const validatedDeltas: PlaybookDelta[] = [];
            for (const delta of reflectResult.deltas) {
              const validation = await validateDelta(delta, config);
              if (validation.valid) {
                validatedDeltas.push(delta);
              } else {
                log(`Rejected delta: ${validation.gate?.reason || validation.result?.reason}`, !options.json);
              }
            }

            if (validatedDeltas.length > 0) {
              allDeltas.push(...validatedDeltas);
            }
            
            processedLog.add({
              sessionPath,
              processedAt: now(),
              diaryId: diary.id,
              deltasGenerated: validatedDeltas.length
            });
            
            // Save progress incrementally to prevent re-processing on crash
            await processedLog.save();

          } catch (err: any) {
            error(`Failed to process ${sessionPath}: ${err.message}`);
          }
        };

        for (const session of unprocessed) {
            await processSession(session);
        }

        if (options.dryRun) {
          console.log(JSON.stringify(allDeltas, null, 2));
          return;
        }

        if (allDeltas.length > 0) {
          // Load raw playbooks for writing
          const globalPlaybook = await loadPlaybook(globalPath);
          let repoPlaybook: Playbook | null = null;
          if (hasRepo) {
              repoPlaybook = await loadPlaybook(repoPath);
          }

          // Partition deltas
          const globalDeltas: PlaybookDelta[] = [];
          const repoDeltas: PlaybookDelta[] = [];

          for (const delta of allDeltas) {
              // Logic for routing:
              // 1. If it references an ID, route to where the ID exists.
              // 2. If it's an ADD, route to Global by default, unless specifically flagged? 
              //    For now, new rules go to Global. Feedback goes to source. 
              
              let routed = false;
              if ('bulletId' in delta && delta.bulletId) {
                  if (repoPlaybook && findBullet(repoPlaybook, delta.bulletId)) {
                      repoDeltas.push(delta);
                      routed = true;
                  } else if (findBullet(globalPlaybook, delta.bulletId)) {
                      globalDeltas.push(delta);
                      routed = true;
                  }
              }
              
              if (!routed) {
                  // New rule or ID not found (stale?) -> Default to Global
                  // If ID not found, helpful/harmful will be skipped by curatePlaybook anyway
                  globalDeltas.push(delta);
              }
          }

          // Apply curation
          let globalResults: CurationResult | null = null;
          let repoResults: CurationResult | null = null;

          if (globalDeltas.length > 0) {
              globalResults = curatePlaybook(globalPlaybook, globalDeltas, config, initialPlaybook);
              await savePlaybook(globalResults.playbook, globalPath);
          }

          if (repoDeltas.length > 0 && repoPlaybook) {
              repoResults = curatePlaybook(repoPlaybook, repoDeltas, config, initialPlaybook);
              await savePlaybook(repoResults.playbook, repoPath);
          }
          
          await processedLog.save();

          if (options.json) {
              console.log(JSON.stringify({ global: globalResults, repo: repoResults }, null, 2));
          } else {
              console.log(chalk.green(`\nReflection complete!`));
              
              if (globalResults) {
                  console.log(chalk.bold(`Global Updates:`));
                  console.log(`  Applied: ${globalResults.applied}, Skipped: ${globalResults.skipped}`);
                  if (globalResults.inversions.length > 0) {
                      console.log(chalk.yellow(`  Inverted ${globalResults.inversions.length} harmful rules.`));
                  }
              }
              
              if (repoResults) {
                  console.log(chalk.bold(`Repo Updates:`));
                  console.log(`  Applied: ${repoResults.applied}, Skipped: ${repoResults.skipped}`);
                  if (repoResults.inversions.length > 0) {
                      console.log(chalk.yellow(`  Inverted ${repoResults.inversions.length} harmful rules.`));
                  }
              }

              // Display cost summary
              const statsAfter = await getUsageStats(config);
              const operationCost = statsAfter.today - statsBefore.today;
              if (operationCost > 0) {
                console.log(chalk.dim(formatCostSummary(operationCost, statsAfter)));
              }
          }
        } else {
          await processedLog.save(); // Save progress even if no deltas
          if (!options.json) console.log("No new insights found.");

          // Display cost summary even if no deltas generated
          const statsAfter = await getUsageStats(config);
          const operationCost = statsAfter.today - statsBefore.today;
          if (operationCost > 0 && !options.json) {
            console.log(chalk.dim(formatCostSummary(operationCost, statsAfter)));
          }
        }
    };

    if (hasRepo) {
        await withLock(repoPath, innerOp);
    } else {
        await innerOp();
    }
  });
}
