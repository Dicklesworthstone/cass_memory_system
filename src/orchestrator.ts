import { Config, CurationResult, Playbook, PlaybookDelta, DecisionLogEntry, PlaybookBullet, ProcessedEntry } from "./types.js";
import { loadMergedPlaybook, loadPlaybook, savePlaybook, findBullet, mergePlaybooks } from "./playbook.js";
import { ProcessedLog, getProcessedLogPath } from "./tracking.js";
import { findUnprocessedSessions, cassExport } from "./cass.js";
import { generateDiary } from "./diary.js";
import { reflectOnSession } from "./reflect.js";
import { validateDelta } from "./validate.js";
import type { LLMIO } from "./llm.js";
import { curatePlaybook } from "./curate.js";
import { expandPath, log, warn, error, now, fileExists, resolveRepoDir, generateBulletId, hashContent, jaccardSimilarity, ensureDir } from "./utils.js";
import { withLock } from "./lock.js";
import path from "node:path";

export interface ReflectionOptions {
  days?: number;
  maxSessions?: number;
  agent?: string;
  workspace?: string;
  session?: string; // Specific session path
  dryRun?: boolean;
  onProgress?: (event: ReflectionProgressEvent) => void;
  /** Optional LLMIO for testing - bypasses env-based stubs when provided */
  io?: LLMIO;
}

export interface ReflectionOutcome {
  sessionsProcessed: number;
  deltasGenerated: number;
  globalResult?: CurationResult;
  repoResult?: CurationResult;
  dryRunDeltas?: PlaybookDelta[];
  errors: string[];
}

export type ReflectionProgressEvent =
  | { phase: "discovery"; totalSessions: number }
  | { phase: "session_start"; index: number; totalSessions: number; sessionPath: string }
  | { phase: "session_skip"; index: number; totalSessions: number; sessionPath: string; reason: string }
  | { phase: "session_done"; index: number; totalSessions: number; sessionPath: string; deltasGenerated: number }
  | { phase: "session_error"; index: number; totalSessions: number; sessionPath: string; error: string };

function isActiveBullet(bullet: PlaybookBullet): boolean {
  return !bullet.deprecated && bullet.maturity !== "deprecated" && bullet.state !== "retired";
}

function findFirstHashMatch(playbook: Playbook, content: string): PlaybookBullet | undefined {
  const h = hashContent(content);
  return playbook.bullets.find((b) => hashContent(b.content) === h);
}

function findBestActiveSimilarBullet(
  playbook: Playbook,
  content: string,
  threshold: number
): PlaybookBullet | undefined {
  let best: { bullet: PlaybookBullet; score: number } | undefined;
  for (const b of playbook.bullets) {
    if (!isActiveBullet(b)) continue;
    const score = jaccardSimilarity(content, b.content);
    if (score < threshold) continue;
    if (!best || score > best.score) best = { bullet: b, score };
  }
  return best?.bullet;
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
  // Use a specific lock suffix to allow ProcessedLog internal locking to work independently
  const reflectionLockPath = `${logPath}.orchestrator`;

  // Ensure reflections directory exists before lock acquisition (fixes #14)
  // Without this, the lock can fail on fresh installs where ~/.cass-memory/reflections/ doesn't exist
  await ensureDir(path.dirname(reflectionLockPath));

  return withLock(reflectionLockPath, async () => {
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
            agent: options.agent,
            excludePatterns: config.sessionExcludePatterns,
            includeAll: config.sessionIncludeAll
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

    options.onProgress?.({ phase: "discovery", totalSessions: unprocessed.length });

    // 4. Reflection Phase (LLM) - Done WITHOUT holding playbook locks
    const allDeltas: PlaybookDelta[] = [];
    const pendingProcessedEntries: ProcessedEntry[] = [];
    let sessionsProcessed = 0;

    for (let i = 0; i < unprocessed.length; i++) {
      const sessionPath = unprocessed[i]!;
      options.onProgress?.({
        phase: "session_start",
        index: i + 1,
        totalSessions: unprocessed.length,
        sessionPath,
      });

      try {
        const diary = await generateDiary(sessionPath, config);
        
        // Quick check for empty sessions to save tokens
        const content = await cassExport(sessionPath, "text", config.cassPath, config) || "";
        if (content.length < 50) {
          options.onProgress?.({
            phase: "session_skip",
            index: i + 1,
            totalSessions: unprocessed.length,
            sessionPath,
            reason: "Session content too short",
          });

          // Mark as processed so we don't retry (defer via pendingProcessedEntries)
          pendingProcessedEntries.push({
            sessionPath,
            processedAt: now(),
            diaryId: diary.id,
            deltasGenerated: 0
          });
          continue; 
        }

        const reflectResult = await reflectOnSession(diary, snapshotPlaybook, config, options.io);

        // Validation
        const validatedDeltas: PlaybookDelta[] = [];
        for (const delta of reflectResult.deltas) {
          const validation = await validateDelta(delta, config);
          if (validation.valid) {
            // Apply LLM refinement if suggested
            if (validation.result?.refinedRule && delta.type === "add") {
              delta.bullet.content = validation.result.refinedRule;
            }
            validatedDeltas.push(delta);
          }
        }

        if (validatedDeltas.length > 0) {
          allDeltas.push(...validatedDeltas);
        }

        // Defer marking as processed until merge succeeds to prevent data loss
        pendingProcessedEntries.push({
          sessionPath,
          processedAt: now(),
          diaryId: diary.id,
          deltasGenerated: validatedDeltas.length
        });
        sessionsProcessed++;

        options.onProgress?.({
          phase: "session_done",
          index: i + 1,
          totalSessions: unprocessed.length,
          sessionPath,
          deltasGenerated: validatedDeltas.length,
        });
        
      } catch (err: any) {
        const message = err?.message || String(err);
        errors.push(`Failed to process ${sessionPath}: ${message}`);
        options.onProgress?.({
          phase: "session_error",
          index: i + 1,
          totalSessions: unprocessed.length,
          sessionPath,
          error: message,
        });
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
      // Even if no deltas were generated, we should still mark sessions as processed
      // (e.g., empty sessions or sessions with no insights) to avoid infinite loops.
      if (pendingProcessedEntries.length > 0) {
        await processedLog.appendBatch(pendingProcessedEntries);
      }
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

      // Pre-process deltas to decompose 'merge' operations into atomic add/deprecate actions.
      // This allows us to route deprecations to their specific playbooks (Repo vs Global)
      // while adding the new merged rule to the default location (Global).
      const processedDeltas: PlaybookDelta[] = [];
      
      for (const delta of allDeltas) {
        if (delta.type !== "merge") {
          processedDeltas.push(delta);
          continue;
        }

        const mergedContent = delta.mergedContent;
        const threshold = typeof config.dedupSimilarityThreshold === "number" ? config.dedupSimilarityThreshold : 0.85;

        // If the merged content already exists (or is very similar), prefer deprecating into it
        // rather than creating a duplicate replacement that curation might skip.
        const exactMatch = findFirstHashMatch(freshMerged, mergedContent);
        if (exactMatch && !isActiveBullet(exactMatch)) {
          warn(
            `[orchestrator] Skipping merge delta: merged content matches deprecated/blocked bullet ${exactMatch.id}`
          );
          continue;
        }

        const replacement =
          exactMatch && isActiveBullet(exactMatch)
            ? exactMatch
            : findBestActiveSimilarBullet(freshMerged, mergedContent, threshold);

        if (replacement) {
          for (const id of delta.bulletIds) {
            // If one of the merged bullets is already the best replacement, keep it active and only deprecate the others.
            if (id === replacement.id) continue;
            processedDeltas.push({
              type: "deprecate",
              bulletId: id,
              reason: `Merged into existing ${replacement.id}`,
              replacedBy: replacement.id
            });
          }
          continue;
        }

        const newBulletId = generateBulletId();

        // 1. Create the new merged rule
        processedDeltas.push({
          type: "add",
          bullet: {
            id: newBulletId, // Pre-assign ID so deprecate deltas can reference it
            content: mergedContent,
            category: "merged",
            tags: []
          },
          // Merge deltas don't carry sourceSession, so we use a placeholder
          sourceSession: "merged-operation",
          reason: delta.reason || "Merged from existing rules"
        });

        // 2. Deprecate the old rules
        for (const id of delta.bulletIds) {
          processedDeltas.push({
            type: "deprecate",
            bulletId: id,
            reason: `Merged into ${newBulletId}`,
            replacedBy: newBulletId
          });
        }
      }

      // Partition deltas (Routing Logic)
      const globalDeltas: PlaybookDelta[] = [];
      const repoDeltas: PlaybookDelta[] = [];

      for (const delta of processedDeltas) {
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
        await savePlaybook(globalResult.playbook, globalPath, { updateLastReflection: true });
      }

      if (repoDeltas.length > 0 && repoPlaybook && repoPath) {
        repoResult = curatePlaybook(repoPlaybook, repoDeltas, config, freshMerged);
        await savePlaybook(repoResult.playbook, repoPath, { updateLastReflection: true });
      }
    };

    // Execute Merge with Locking
    await withLock(globalPath, async () => {
      if (hasRepo && repoPath) {
        await withLock(repoPath, performMerge);
      } else {
        await performMerge();
      }
    });

    // Final log save - only mark processed AFTER rules are persisted
    if (pendingProcessedEntries.length > 0) {
      await processedLog.appendBatch(pendingProcessedEntries);
    }

    return {
      sessionsProcessed,
      deltasGenerated: allDeltas.length,
      globalResult,
      repoResult,
      errors
    };
  });
}
