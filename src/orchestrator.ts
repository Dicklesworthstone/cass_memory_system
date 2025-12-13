import { Config, CurationResult, Playbook, PlaybookDelta, DecisionLogEntry } from "./types.js";
import { loadMergedPlaybook, loadPlaybook, savePlaybook, findBullet, mergePlaybooks } from "./playbook.js";
import { ProcessedLog, getProcessedLogPath } from "./tracking.js";
import { findUnprocessedSessions, cassExport } from "./cass.js";
import { generateDiary } from "./diary.js";
import { reflectOnSession } from "./reflect.js";
import { validateDelta } from "./validate.js";
import { curatePlaybook } from "./curate.js";
import { expandPath, log, warn, error, now, fileExists, resolveRepoDir } from "./utils.js";
import { withLock } from "./lock.js";
import path from "node:path";

export interface ReflectionOptions {
  days?: number;
  maxSessions?: number;
  agent?: string;
  workspace?: string;
  session?: string; // Specific session path
  dryRun?: boolean;
}

export interface ReflectionOutcome {
  sessionsProcessed: number;
  deltasGenerated: number;
  globalResult?: CurationResult;
  repoResult?: CurationResult;
  dryRunDeltas?: PlaybookDelta[];
  errors: string[];
}

/**
 * Core logic for the reflection loop.
 * Handles session discovery, LLM reflection, delta validation, splitting, and persistence.
 * Implements fine-grained locking to maximize concurrency.
 */
export async function orchestrateReflection(
  config: Config,
  options: ReflectionOptions
): Promise<ReflectionOutcome> {
  const logPath = expandPath(getProcessedLogPath(options.workspace));
  const globalPath = expandPath(config.playbookPath);
  const repoDir = await resolveRepoDir();
  const repoPath = repoDir ? path.join(repoDir, "playbook.yaml") : null;
  const hasRepo = repoPath ? await fileExists(repoPath) : false;

  // 1. Lock the Workspace Log to serialize reflection for this specific workspace
  return withLock(logPath, async () => {
    const processedLog = new ProcessedLog(logPath);
    await processedLog.load();

    // 2. Snapshot Phase: Load playbook context (without locking playbook yet)
    // We need the playbook to give context to the LLM. 
    // Stale data here is acceptable (LLM might suggest a rule that just got added, curation will dedupe).
    const snapshotPlaybook = await loadMergedPlaybook(config);

    // 3. Discovery Phase
    let sessions: string[] = [];
    const errors: string[] = [];

    if (options.session) {
      sessions = [options.session];
    } else {
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
        errors.push(`Session discovery failed: ${err.message}`);
        return { sessionsProcessed: 0, deltasGenerated: 0, errors };
      }
    }

    const unprocessed = sessions.filter(s => !processedLog.has(s));
    if (unprocessed.length === 0) {
      return { sessionsProcessed: 0, deltasGenerated: 0, errors };
    }

    // 4. Reflection Phase (LLM) - Done WITHOUT holding playbook locks
    const allDeltas: PlaybookDelta[] = [];
    let sessionsProcessed = 0;

    for (const sessionPath of unprocessed) {
      try {
        const diary = await generateDiary(sessionPath, config);
        
        // Quick check for empty sessions to save tokens
        const content = await cassExport(sessionPath, "text", config.cassPath, config) || "";
        if (content.length < 50) {
          // Mark as processed so we don't retry
          await processedLog.append({
            sessionPath,
            processedAt: now(),
            diaryId: diary.id,
            deltasGenerated: 0
          });
          continue; 
        }

        const reflectResult = await reflectOnSession(diary, snapshotPlaybook, config);

        // Validation
        const validatedDeltas: PlaybookDelta[] = [];
        for (const delta of reflectResult.deltas) {
          const validation = await validateDelta(delta, config);
          if (validation.valid) {
            validatedDeltas.push(delta);
          }
        }

        if (validatedDeltas.length > 0) {
          allDeltas.push(...validatedDeltas);
        }

        await processedLog.append({
          sessionPath,
          processedAt: now(),
          diaryId: diary.id,
          deltasGenerated: validatedDeltas.length
        });
        sessionsProcessed++;
        
        // Save log incrementally - removed as append handles persistence
        // await processedLog.save();

      } catch (err: any) {
        errors.push(`Failed to process ${sessionPath}: ${err.message}`);
      }
    }

    if (options.dryRun) {
      return {
        sessionsProcessed,
        deltasGenerated: allDeltas.length,
        dryRunDeltas: allDeltas,
        errors
      };
    }

    if (allDeltas.length === 0) {
      return { sessionsProcessed, deltasGenerated: 0, errors };
    }

    // 5. Merge Phase: Lock Playbooks, Reload, Curate, Save
    // We lock Global first, then Repo (if exists) to prevent deadlocks.
    let globalResult: CurationResult | undefined;
    let repoResult: CurationResult | undefined;

    const performMerge = async () => {
      // Reload fresh playbooks under lock
      const globalPlaybook = await loadPlaybook(globalPath);
      let repoPlaybook: Playbook | null = null;
      if (hasRepo) {
        repoPlaybook = await loadPlaybook(repoPath!);
      }
      
      // Create fresh merged context to ensure deduplication uses up-to-date data
      const freshMerged = mergePlaybooks(globalPlaybook, repoPlaybook);

      // Partition deltas (Routing Logic)
      const globalDeltas: PlaybookDelta[] = [];
      const repoDeltas: PlaybookDelta[] = [];

      for (const delta of allDeltas) {
        let routed = false;
        
        // Feedback/Replace/Delete: Must target existing ID
        if ('bulletId' in delta && delta.bulletId) {
          if (repoPlaybook && findBullet(repoPlaybook, delta.bulletId)) {
            repoDeltas.push(delta);
            routed = true;
          } else if (findBullet(globalPlaybook, delta.bulletId)) {
            globalDeltas.push(delta);
            routed = true;
          }
        }

        // New rules or orphans default to Global
        if (!routed) {
           globalDeltas.push(delta);
        }
      }

      // Apply Curation
      if (globalDeltas.length > 0) {
        globalResult = curatePlaybook(globalPlaybook, globalDeltas, config, freshMerged);
        await savePlaybook(globalResult.playbook, globalPath);
      }

      if (repoDeltas.length > 0 && repoPlaybook) {
        repoResult = curatePlaybook(repoPlaybook, repoDeltas, config, freshMerged);
        await savePlaybook(repoResult.playbook, repoPath!);
      }
    };

    // Execute Merge with Locking
    await withLock(globalPath, async () => {
      if (hasRepo) {
        await withLock(repoPath, performMerge);
      } else {
        await performMerge();
      }
    });

    // Final log save - removed as append handled it
    // await processedLog.save();

    return {
      sessionsProcessed,
      deltasGenerated: allDeltas.length,
      globalResult,
      repoResult,
      errors
    };
  });
}
