import { loadConfig } from "../config.js";
import { loadMergedPlaybook, loadPlaybook, savePlaybook } from "../playbook.js";
import { ProcessedLog } from "../tracking.js";
import { findUnprocessedSessions, cassExport } from "../cass.js";
import { generateDiary } from "../diary.js";
import { reflectOnSession } from "../reflect.js";
import { validateDelta } from "../validate.js";
import { curatePlaybook } from "../curate.js";
import { expandPath, log, warn, error, now } from "../utils.js";
import { withLock } from "../lock.js";
import { PlaybookDelta } from "../types.js";
import path from "node:path";
import chalk from "chalk";

export async function reflectCommand(
  options: { 
    days?: number;
    maxSessions?: number;
    agent?: string;
    dryRun?: boolean;
    json?: boolean;
  } = {}
): Promise<void> {
  const config = await loadConfig();
  
  const globalPath = expandPath(config.playbookPath);
  const logPath = expandPath(path.join(config.diaryDir, "../reflections/processed.log"));

  // We must lock the entire reflect process to ensure we don't duplicate work 
  // or overwrite the playbook/processed log with stale data.
  // Locking just the save is insufficient if two processes pick up the same "unprocessed" sessions.
  
  // Using globalPath as the lock key for the entire critical section.
  await withLock(globalPath, async () => {
    const processedLog = new ProcessedLog(logPath);
    await processedLog.load();

    // Load fresh playbook for context
    const initialPlaybook = await loadMergedPlaybook(config);

    log("Searching for new sessions...", true);
    
    const sessions = await findUnprocessedSessions(processedLog.getProcessedPaths(), { 
      days: options.days || config.sessionLookbackDays,
      maxSessions: options.maxSessions || 5,
      agent: options.agent
    }, config.cassPath);

    const unprocessed = sessions.filter(s => !processedLog.has(s));

    if (unprocessed.length === 0) {
      console.log(chalk.green("No new sessions to reflect on."));
      return;
    }

    console.log(chalk.blue(`Found ${unprocessed.length} sessions to process.`));

    let allDeltas: PlaybookDelta[] = [];

    for (const sessionPath of unprocessed) {
      console.log(chalk.dim(`Processing ${sessionPath}...`));
      
      try {
        const diary = await generateDiary(sessionPath, config);
        const content = await cassExport(sessionPath, "text", config.cassPath) || "";
        
        if (content.length < 50) {
          warn(`Skipping empty session: ${sessionPath}`);
          continue;
        }

        const deltas = await reflectOnSession(diary, initialPlaybook, config);
        
        const validatedDeltas: PlaybookDelta[] = [];
        for (const delta of deltas) {
          const validation = await validateDelta(delta, config);
          if (validation.valid) {
            validatedDeltas.push(delta);
          } else {
            log(`Rejected delta: ${validation.gate?.reason || validation.result?.reason}`, true);
          }
        }

        allDeltas.push(...validatedDeltas);
        
        processedLog.add({
          sessionPath,
          processedAt: now(),
          diaryId: diary.id,
          deltasGenerated: validatedDeltas.length
        });

      } catch (err: any) {
        error(`Failed to process ${sessionPath}: ${err.message}`);
      }
    }

    if (options.dryRun) {
      console.log(JSON.stringify(allDeltas, null, 2));
      return;
    }

    if (allDeltas.length > 0) {
      // Reload fresh playbook again just in case, though we hold the lock so it should be safe unless external edits happen
      const freshPlaybook = await loadPlaybook(globalPath);
      
      // Pass freshPlaybook as target (mutable), initialPlaybook as context (readonly, merged)
      const curation = curatePlaybook(freshPlaybook, allDeltas, config, initialPlaybook);
      await savePlaybook(curation.playbook, globalPath);
      
      await processedLog.save();

      console.log(chalk.green(`\nReflection complete!`));
      console.log(`Applied ${curation.applied} changes.`);
      console.log(`Skipped ${curation.skipped} (duplicates/conflicts).`);
      
      if (curation.inversions.length > 0) {
        console.log(chalk.yellow(`\nInverted ${curation.inversions.length} harmful rules:`));
        curation.inversions.forEach(inv => {
          console.log(`  ${inv.originalContent.slice(0,40)}... -> ANTI-PATTERN`);
        });
      }
    } else {
      await processedLog.save(); // Save progress (sessions marked as processed even if no deltas)
      console.log("No new insights found.");
    }
  });
}