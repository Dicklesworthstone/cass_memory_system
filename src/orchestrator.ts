import fs from "node:fs";
import path from "node:path";
import {
  cassExport,
  cassExportRecords,
  type DiscoveredSession,
  extractSessionWorkspace,
  findUnprocessedSessions,
  formatSessionRecords,
} from "./cass.js";
import { HOOK_ACTIVE_ENV } from "./commands/hook.js";
import { getSanitizeConfig, loadConfig } from "./config.js";
import { curatePlaybook, directivesDisagree, splitDirectiveClauses, validateMergeSources } from "./curate.js";
import { generateDiary, generateDiaryFromContent } from "./diary.js";
import type { LLMIO } from "./llm.js";
import { withLock } from "./lock.js";
import {
  applyOutcomeFeedback,
  classifySessionOutcome,
  extractRuleIdsFromTranscript,
  type OutcomeInput,
  prepareOutcome,
  persistOutcomeRecord,
} from "./outcome.js";
import {
  findBullet,
  loadMergedPlaybook,
  loadPlaybook,
  mergePlaybooks,
  recordReflectionRun,
  savePlaybook,
} from "./playbook.js";
import { reflectOnSession } from "./reflect.js";
import { buildSemanticDedupIndex, type SemanticDedupIndex } from "./semantic.js";
import { containsCmSubprocessPayload, stripCmSubprocessPayloads } from "./subprocess-tag.js";
import {
  classifySessionForReflection,
  getProcessedLogPath,
  ProcessedLog,
  type SessionRetryPolicy,
} from "./tracking.js";
import {
  type Config,
  type CurationResult,
  DecisionLogEntry,
  type Playbook,
  type PlaybookBullet,
  type PlaybookDelta,
  type ProcessedEntry,
} from "./types.js";
import {
  ensureDir,
  error,
  expandPath,
  fileExists,
  generateBulletId,
  hashContent,
  jaccardSimilarity,
  log,
  now,
  inlineFeedbackToDeltas,
  parseInlineFeedback,
  resolveRepoDir,
  warn,
} from "./utils.js";
import { validateDelta } from "./validate.js";
import { normalizeWorkspacePath, resolveProjectRoot, sameRuleScope } from "./workspace.js";

/** Hook-mode wait for the reflection lock: up to 30 minutes, polled every second. */
export const HOOK_REFLECTION_LOCK_WAIT = { retries: 1800, delay: 1000 };

export interface ReflectionOptions {
  days?: number;
  maxSessions?: number;
  agent?: string;
  workspace?: string;
  session?: string; // Specific session path
  /**
   * With `session`: reflect the whole transcript again even if it was
   * processed before (and ignore any retry cooldown). Only rule changes are
   * taken from the already-reflected part; helpful/harmful feedback and
   * outcome grading still come only from turns added since the last pass, so
   * nothing is counted twice (#85).
   */
  force?: boolean;
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
  /** Project rules routed to other repositories' `.cass/playbook.yaml` (#81, "repo" mode). */
  projectResults?: Array<{ playbookPath: string; result: CurationResult }>;
  dryRunDeltas?: PlaybookDelta[];
  errors: string[];
  /** Auto-recorded rule outcomes from processed sessions */
  autoOutcome?: {
    outcomesRecorded: number;
    feedbackApplied: number;
    missingRules: string[];
    inlineFeedbackDeltas: number;
  };
}

export type ReflectionProgressEvent =
  | { phase: "discovery"; totalSessions: number }
  | { phase: "session_start"; index: number; totalSessions: number; sessionPath: string }
  | {
      phase: "session_skip";
      index: number;
      totalSessions: number;
      sessionPath: string;
      reason: string;
    }
  | {
      phase: "session_done";
      index: number;
      totalSessions: number;
      sessionPath: string;
      deltasGenerated: number;
    }
  | {
      phase: "session_error";
      index: number;
      totalSessions: number;
      sessionPath: string;
      error: string;
    };

function statSizeSync(sessionPath: string): number | undefined {
  try {
    return fs.statSync(expandPath(sessionPath)).size;
  } catch {
    return undefined;
  }
}

function hashRecord(record: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(record) ?? String(record);
  } catch {
    serialized = String(record);
  }
  return hashContent(serialized);
}

function watermarkFor(records: unknown[]): Pick<ProcessedEntry, "recordCount" | "lastRecordHash"> {
  return records.length > 0
    ? { recordCount: records.length, lastRecordHash: hashRecord(records[records.length - 1]) }
    : { recordCount: 0 };
}

/** Repo playbook that project rules for `projectRoot` go to in "repo" mode, if the repo opted in. */
function repoPlaybookTargetFor(projectRoot: string): string | null {
  const cassDir = path.join(projectRoot, ".cass");
  try {
    if (!fs.statSync(cassDir).isDirectory()) return null;
    fs.accessSync(cassDir, fs.constants.W_OK);
  } catch {
    return null;
  }
  return path.join(cassDir, "playbook.yaml");
}

function samePlaybookPath(a: string, b: string): boolean {
  return normalizeWorkspacePath(a) === normalizeWorkspacePath(b);
}

function isActiveBullet(bullet: PlaybookBullet): boolean {
  return !bullet.deprecated && bullet.maturity !== "deprecated" && bullet.state !== "retired";
}

function findFirstHashMatch(
  playbook: Playbook,
  content: string,
  eligible: (bullet: PlaybookBullet) => boolean,
): PlaybookBullet | undefined {
  const h = hashContent(content);
  return playbook.bullets.find((b) => eligible(b) && hashContent(b.content) === h);
}

function findBestActiveSimilarBullet(
  playbook: Playbook,
  content: string,
  threshold: number,
  eligible: (bullet: PlaybookBullet) => boolean,
): PlaybookBullet | undefined {
  let best: { bullet: PlaybookBullet; score: number } | undefined;
  const clauses = splitDirectiveClauses(content);
  for (const b of playbook.bullets) {
    if (!isActiveBullet(b) || !eligible(b)) continue;
    if (directivesDisagree(clauses, splitDirectiveClauses(b.content))) continue;
    const score = jaccardSimilarity(content, b.content);
    if (score < threshold) continue;
    if (!best || score > best.score) best = { bullet: b, score };
  }
  return best?.bullet;
}

function accumulateCurationResult(
  previous: CurationResult | undefined,
  next: CurationResult,
): CurationResult {
  if (!previous) return next;
  return {
    playbook: next.playbook,
    applied: previous.applied + next.applied,
    skipped: previous.skipped + next.skipped,
    conflicts: [...previous.conflicts, ...next.conflicts],
    promotions: [...previous.promotions, ...next.promotions],
    inversions: [...previous.inversions, ...next.inversions],
    pruned: previous.pruned + next.pruned,
    decisionLog: [...(previous.decisionLog ?? []), ...(next.decisionLog ?? [])],
  };
}

/**
 * Core logic for the reflection loop.
 * Handles session discovery, LLM reflection, delta validation, splitting, and persistence.
 * Implements fine-grained locking to maximize concurrency.
 */
export async function orchestrateReflection(
  config: Config,
  options: ReflectionOptions,
): Promise<ReflectionOutcome> {
  const runWorkspace = normalizeWorkspacePath(process.cwd());
  const logPath = expandPath(getProcessedLogPath(options.workspace));
  const globalPath = expandPath(config.playbookPath);
  const repoDir = await resolveRepoDir(runWorkspace);
  const repoPath = repoDir ? path.join(repoDir, "playbook.yaml") : null;
  const hasRepo = repoPath ? await fileExists(repoPath) : false;
  const outcomeConfigs = new Map<string, Promise<Config>>([[runWorkspace, Promise.resolve(config)]]);
  const configForOutcomeWorkspace = (workspace?: string): Promise<Config> => {
    const owner = normalizeWorkspacePath(workspace ?? runWorkspace);
    let pending = outcomeConfigs.get(owner);
    if (!pending) {
      pending = loadConfig({ playbookPath: globalPath }, { cwd: owner }).then((targetConfig) => {
        const runSanitization = getSanitizeConfig(config);
        const targetSanitization = getSanitizeConfig(targetConfig);
        return {
          ...targetConfig,
          sanitization: {
            ...targetSanitization,
            enabled: runSanitization.enabled || targetSanitization.enabled,
            extraPatterns: [...new Set([...runSanitization.extraPatterns, ...targetSanitization.extraPatterns])],
          },
        };
      });
      outcomeConfigs.set(owner, pending);
    }
    return pending;
  };

  // 1. Lock the Workspace Log to serialize reflection for this specific workspace
  // Use a specific lock suffix to allow ProcessedLog internal locking to work independently
  const reflectionLockPath = `${logPath}.orchestrator`;

  // Ensure reflections directory exists before lock acquisition (fixes #14)
  // Without this, the lock can fail on fresh installs where ~/.cass-memory/reflections/ doesn't exist
  await ensureDir(path.dirname(reflectionLockPath));

  // A hook-started reflect runs in the background when an agent session ends.
  // Sessions that end together must queue behind the reflect in progress
  // (minutes of LLM calls) instead of failing after the 2 s interactive wait.
  const lockWait = process.env[HOOK_ACTIVE_ENV] === "1" ? HOOK_REFLECTION_LOCK_WAIT : {};
  return withLock(reflectionLockPath, async () => {
    const processedLog = new ProcessedLog(logPath);
    await processedLog.load();
    const errors: string[] = [];
    let autoOutcome: ReflectionOutcome["autoOutcome"] | undefined;
    const outcomeSummary = () => autoOutcome ??= {
      outcomesRecorded: 0,
      feedbackApplied: 0,
      missingRules: [],
      inlineFeedbackDeltas: 0,
    };
    // A failed recovery is retried on the next invocation, not repeatedly
    // during this run when newly reflected sessions are committed below.
    const attemptedOutcomes = new Set<string>();
    const drainPendingOutcomes = async () => {
      const acknowledgements: Array<{ sessionPath: string; outcomeIds: string[] }> = [];
      for (const entry of processedLog.getPendingOutcomeEntries()) {
        const completed = new Set<string>();
        const identity = (record: NonNullable<ProcessedEntry["pendingOutcomes"]>[number]) =>
          record.id ?? JSON.stringify([record.path, record.sessionId, record.recordedAt]);
        for (const pending of entry.pendingOutcomes ?? []) {
          const id = identity(pending);
          if (attemptedOutcomes.has(id)) continue;
          attemptedOutcomes.add(id);
          const summary = outcomeSummary();
          try {
            const outcomeConfig = await configForOutcomeWorkspace(pending.workspace);
            const record = await persistOutcomeRecord(pending, outcomeConfig);
            summary.outcomesRecorded++;
            const feedback = await applyOutcomeFeedback(record, outcomeConfig);
            summary.feedbackApplied += feedback.applied;
            summary.missingRules = [...new Set([...summary.missingRules, ...feedback.missing])];
            completed.add(id);
          } catch (err: any) {
            errors.push(`Auto-outcome recovery failed for ${entry.sessionPath}: ${err?.message || String(err)}`);
          }
        }
        if (completed.size === 0) continue;
        acknowledgements.push({ sessionPath: entry.sessionPath, outcomeIds: [...completed] });
      }
      try {
        await processedLog.acknowledgeOutcomes(acknowledgements);
      } catch (err: any) {
        // The persisted queue still contains the exact same outcome IDs.
        // Replaying after an interrupted acknowledgement is idempotent.
        errors.push(`Auto-outcome acknowledgement failed: ${err?.message || String(err)}`);
      }
    };
    // Recovery must run even when discovery finds no new sessions. A dry run
    // leaves both the pending queue and its outcome/feedback destinations alone.
    if (!options.dryRun) await drainPendingOutcomes();

    // 2. Snapshot Phase: Load playbook context (without locking playbook yet)
    // We need the playbook to give context to the LLM.
    // Stale data here is acceptable (LLM might suggest a rule that just got added, curation will dedupe).
    const snapshotPlaybook = await loadMergedPlaybook(config);

    // 3. Discovery Phase
    let sessions: string[] = [];
    // Agent attribution cass reported per session; the diary uses it as the
    // authoritative provenance instead of re-inferring from the path (#73).
    const agentHints = new Map<string, string>();
    // Everything discovery learned per session (growth signals, workspace).
    const discoveryInfo = new Map<string, DiscoveredSession>();

    const retryPolicy: SessionRetryPolicy = {
      maxFailures: config.sessionRetryMaxFailures ?? 3,
      cooldownMs: (config.sessionRetryCooldownHours ?? 24) * 60 * 60 * 1000,
    };
    const routing = config.projectRuleRouting ?? "off";

    if (options.session) {
      sessions = [options.session];
    } else {
      const nowMs = Date.now();
      try {
        const discovered = await findUnprocessedSessions(
          processedLog.getProcessedPaths(),
          {
            days: options.days || config.sessionLookbackDays,
            maxSessions: options.maxSessions || 5,
            agent: options.agent,
            workspace: options.workspace,
            excludePatterns: config.sessionExcludePatterns,
            includeAll: config.sessionIncludeAll,
            cliSubprocessCwd: config.cliSubprocessCwd,
            timelineTimeoutSeconds: config.cassTimelineTimeoutSeconds,
            // #85: a processed session that has grown since, or a failed one
            // whose retry is due, is selected again.
            classify: (s) => {
              const entry = processedLog.get(s.path);
              const canResume =
                entry !== undefined && entry.status !== "failed" && entry.recordCount !== undefined;
              return classifySessionForReflection(
                entry,
                {
                  messageCount: s.messageCount,
                  endedAt: s.endedAt,
                  sizeBytes: canResume ? statSizeSync(s.path) : undefined,
                },
                retryPolicy,
                nowMs,
              );
            },
          },
          config.cassPath,
        );
        sessions = discovered.map((s) => s.path);
        for (const s of discovered) {
          if (s.agent) agentHints.set(s.path, s.agent);
          discoveryInfo.set(s.path, s);
        }
      } catch (err: any) {
        errors.push(`Session discovery failed: ${err.message}`);
        return { sessionsProcessed: 0, deltasGenerated: 0, errors, autoOutcome };
      }
    }

    // An explicitly named session that was processed before is re-examined
    // only when it can be resumed from a watermark (new turns), or with
    // --force. A failed one is retried regardless of any cooldown.
    const unprocessed = sessions.filter((s) => {
      if (!options.session) return true;
      const entry = processedLog.get(s);
      if (!entry || entry.status === "failed" || options.force) return true;
      return entry.recordCount !== undefined;
    });
    if (unprocessed.length === 0) {
      return { sessionsProcessed: 0, deltasGenerated: 0, errors, autoOutcome };
    }

    options.onProgress?.({ phase: "discovery", totalSessions: unprocessed.length });

    // 4. Reflection Phase (LLM) - Done WITHOUT holding playbook locks
    const allDeltas: PlaybookDelta[] = [];
    const pendingProcessedEntries: ProcessedEntry[] = [];
    // Log updates that do not count as a reflected session: growth that added
    // no new records (refreshes the growth signals so discovery stops picking
    // the session), and failed attempts (bounded retry, #85).
    const pendingRefreshEntries: ProcessedEntry[] = [];
    const pendingFailureEntries: ProcessedEntry[] = [];
    // "repo" routing (#81): add deltas bound for another repo's playbook.
    const projectTargets = new Map<PlaybookDelta, { playbookPath: string; projectRoot: string }>();
    const pendingOutcomes = new Map<string, OutcomeInput[]>();
    let sessionsProcessed = 0;
    let inlineFeedbackDeltaCount = 0;

    for (let i = 0; i < unprocessed.length; i++) {
      const sessionPath = unprocessed[i]!;
      options.onProgress?.({
        phase: "session_start",
        index: i + 1,
        totalSessions: unprocessed.length,
        sessionPath,
      });

      const prior = processedLog.get(sessionPath);
      const priorDone = prior !== undefined && prior.status !== "failed";
      const watermark = prior?.recordCount;
      // Turns before the watermark (or, without one, a processed session's
      // whole transcript) were graded by an earlier pass.
      const previouslyGraded = priorDone || watermark !== undefined;
      const discovered = discoveryInfo.get(sessionPath);
      const forceFull = !!options.force && !!options.session;
      // Resume from the watermark: reflect only records added since (#85).
      const incremental = watermark !== undefined && !forceFull;
      // Size is read BEFORE exporting: growth during the export then shows up
      // as growth next time instead of being hidden behind the stored size.
      const growthSignals: Pick<ProcessedEntry, "messageCount" | "endedAt" | "sizeBytes"> = {};
      const messageCount = discovered?.messageCount ?? prior?.messageCount;
      if (messageCount !== undefined) growthSignals.messageCount = messageCount;
      const endedAt = discovered?.endedAt ?? prior?.endedAt;
      if (endedAt) growthSignals.endedAt = endedAt;
      const sizeBytes = statSizeSync(sessionPath);
      if (sizeBytes !== undefined) growthSignals.sizeBytes = sizeBytes;

      try {
        let content: string;
        let records: unknown[] | null;
        let sliceNote = "";
        if (incremental) {
          records = await cassExportRecords(sessionPath, config.cassPath);
          if (records === null) {
            throw new Error(`Failed to export session: ${sessionPath}`);
          }
          const total = records.length;
          const rewritten =
            total < watermark ||
            (watermark > 0 &&
              prior?.lastRecordHash !== undefined &&
              hashRecord(records[watermark - 1]) !== prior.lastRecordHash);
          if (rewritten || total === watermark) {
            // Nothing to reflect. A rewritten transcript cannot be sliced
            // safely, so its current end becomes the new watermark rather than
            // re-reflecting (and re-counting) turns seen before.
            options.onProgress?.({
              phase: "session_skip",
              index: i + 1,
              totalSessions: unprocessed.length,
              sessionPath,
              reason: rewritten
                ? "Transcript was rewritten since it was last reflected; only turns added from now on will be reflected"
                : "No new messages since the last reflection",
            });
            if (!options.session || !priorDone || rewritten) {
              pendingRefreshEntries.push({
                sessionPath,
                processedAt: prior?.processedAt ?? now(),
                ...(prior?.diaryId ? { diaryId: prior.diaryId } : {}),
                deltasGenerated: prior?.deltasGenerated ?? 0,
                pendingOutcomes: prior?.pendingOutcomes,
                ...watermarkFor(records),
                ...growthSignals,
              });
            }
            continue;
          }
          content = formatSessionRecords(records.slice(watermark), config);
          sliceNote = `[Continuation of a session reflected earlier: records ${watermark + 1}-${total} only. Earlier turns were already reflected.]\n\n`;
        } else {
          const exported = await cassExport(sessionPath, "text", config.cassPath, config);
          // A session that could not be exported at all (missing file, cass and
          // the fallback parser both failed) is an error that leaves it
          // unprocessed for retry, not an "empty session" to mark done (#85).
          if (exported === null) {
            throw new Error(`Failed to export session: ${sessionPath}`);
          }
          content = exported;
          // Watermark for the next pass, taken right after the transcript was
          // exported. If records cannot be read the entry has no watermark and
          // the session is simply never resumed (the pre-#85 behaviour).
          records = await cassExportRecords(sessionPath, config.cassPath);
        }
        const watermarkFields = records ? watermarkFor(records) : {};

        // Feedback and outcome grading must only see turns that were never
        // graded before (#85). Only a forced full pass differs from `content`.
        let gradingSource = content;
        if (forceFull && previouslyGraded) {
          gradingSource =
            watermark !== undefined && records && records.length > watermark
              ? formatSessionRecords(records.slice(watermark), config)
              : "";
        }

        // #81: the project the session ran in (cass search hit, else the
        // transcript's own cwd), used to pin workspace-scoped rules.
        const sessionWorkspace =
          discovered?.workspace ?? (records ? extractSessionWorkspace(records) : undefined);
        const projectRoot = sessionWorkspace ? resolveProjectRoot(sessionWorkspace) : undefined;

        // #76: a transcript carrying cm's private payload marker is a recording
        // of one of cm's OWN `claude -p` / codex / gemini calls, not a work
        // session. Reflecting on it feeds cm's reflector prompt back into the
        // playbook and auto-grades every bullet id that prompt embedded.
        //
        // Path exclusion in findUnprocessedSessions is the primary defence;
        // this catches the cases it cannot see — CLI tools that do not key
        // their transcript directory on the cwd (codex, gemini), an explicit
        // `--session <path>`, and transcripts written before the cwd tag
        // existed. Marked processed so it never consumes the discovery budget
        // again, exactly like the empty-session path below.
        //
        // This errs on the safe side on purpose: a genuine session that quotes
        // one of cm's prompts verbatim is skipped too. cm never writes this
        // marker to stdout, a log or a playbook, so that requires someone to
        // paste cm's internal prompt into their own transcript. Losing one
        // session's insights is much cheaper than re-opening the loop, and the
        // skip is reported with an explicit reason rather than silently.
        if (containsCmSubprocessPayload(content)) {
          options.onProgress?.({
            phase: "session_skip",
            index: i + 1,
            totalSessions: unprocessed.length,
            sessionPath,
            reason: "Transcript of cm's own LLM subprocess call",
          });
          pendingProcessedEntries.push({
            sessionPath,
            processedAt: now(),
            deltasGenerated: 0,
            pendingOutcomes: prior?.pendingOutcomes,
            ...watermarkFields,
            ...growthSignals,
          });
          continue;
        }

        // Quick check for empty sessions, BEFORE the diary's LLM call (#85):
        // an empty transcript must not cost a diary generation.
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
            deltasGenerated: 0,
            pendingOutcomes: prior?.pendingOutcomes,
            ...watermarkFields,
            ...growthSignals,
          });
          continue;
        }

        const diaryHint = {
          agent: agentHints.get(sessionPath),
          ...(sessionWorkspace ? { workspace: sessionWorkspace } : {}),
        };
        const diary = incremental
          ? await generateDiaryFromContent(sessionPath, sliceNote + content, config, diaryHint)
          : await generateDiary(sessionPath, config, diaryHint);

        const reflectResult = await reflectOnSession(diary, snapshotPlaybook, config, options.io);
        if (reflectResult.failure !== undefined && reflectResult.deltas.length === 0) {
          // The reflector never produced anything for this session (timeout,
          // provider error, unparseable output). Throwing here keeps the
          // session OUT of the processed log so the next run retries it,
          // instead of recording it as "processed, 0 deltas" forever (#78).
          throw new Error(`Reflector failed: ${reflectResult.failure}`);
        }

        // A forced full pass over an already-reflected transcript cannot tell
        // which turns a reflector helpful/harmful judgement came from, so it
        // contributes rule changes only (#85).
        const reflectedDeltas =
          forceFull && previouslyGraded
            ? reflectResult.deltas.filter((d) => d.type !== "helpful" && d.type !== "harmful")
            : reflectResult.deltas;

        // Validation
        const validatedDeltas: PlaybookDelta[] = [];
        for (const delta of reflectedDeltas) {
          const validation = await validateDelta(delta, config);
          if (validation.valid) {
            // Apply LLM refinement if suggested
            if (validation.result?.refinedRule && delta.type === "add") {
              delta.bullet.content = validation.result.refinedRule;
            }
            validatedDeltas.push(delta);
          }
        }

        // #81: pin workspace-scoped rules to the session's project. The model
        // never supplies the path; a rule whose project is unknown would match
        // no workspace at all, so it stays global instead of vanishing.
        for (const delta of validatedDeltas) {
          if (delta.type !== "add" || delta.bullet.scope !== "workspace") continue;
          if (!projectRoot) {
            delta.bullet.scope = "global";
            delete delta.bullet.workspace;
            continue;
          }
          delta.bullet.workspace = projectRoot;
          if (routing === "repo") {
            const playbookPath = repoPlaybookTargetFor(projectRoot);
            if (playbookPath) projectTargets.set(delta, { playbookPath, projectRoot });
          }
        }

        if (validatedDeltas.length > 0) {
          allDeltas.push(...validatedDeltas);
        }

        // 4b. Auto-outcome: extract rule IDs, inline feedback, and classify session
        //
        // Grading reads a payload-stripped copy (#76). A bullet id or inline
        // feedback comment that only ever appears inside a prompt cm itself
        // wrote was never used or judged by an agent, so it must not earn a
        // helpful/harmful event.
        //
        // Defence in depth: the skip above means no payload should reach this
        // point today. It stays because grading is the step that actually
        // corrupted playbooks in #76 — if the skip is ever narrowed, or a
        // future caller reaches the auto-outcome block another way, cm's own
        // prompts must still be unable to award themselves helpful counts.
        const gradableContent = stripCmSubprocessPayloads(gradingSource);
        if (gradableContent) {
          // Parse inline feedback comments (// [cass: helpful b-xyz] - reason)
          const inlineFeedback = parseInlineFeedback(gradableContent);
          if (inlineFeedback.length > 0) {
            allDeltas.push(...inlineFeedbackToDeltas(inlineFeedback, sessionPath));
            inlineFeedbackDeltaCount += inlineFeedback.length;
          }

          // Extract rule IDs and classify session outcome for auto-recording.
          // Exclude IDs that already have explicit inline feedback to avoid
          // double-counting (they get direct signal from the delta above).
          const inlineFeedbackIds = new Set(inlineFeedback.map((fb) => fb.bulletId.toLowerCase()));
          const ruleIds = extractRuleIdsFromTranscript(gradableContent).filter(
            (id) => !inlineFeedbackIds.has(id),
          );
          if (ruleIds.length > 0) {
            const outcomeInput = classifySessionOutcome(gradableContent, diary, ruleIds);
            if (outcomeInput) {
              pendingOutcomes.set(sessionPath, [
                ...(pendingOutcomes.get(sessionPath) ?? []),
                { ...outcomeInput, workspace: sessionWorkspace ?? options.workspace ?? runWorkspace },
              ]);
            }
          }
        }

        // Defer marking as processed until merge succeeds to prevent data loss
        pendingProcessedEntries.push({
          sessionPath,
          processedAt: now(),
          diaryId: diary.id,
          deltasGenerated: validatedDeltas.length,
          pendingOutcomes: prior?.pendingOutcomes,
          ...watermarkFields,
          ...growthSignals,
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
        // Bounded retry (#85): remember the failure, keeping any watermark from
        // an earlier successful pass, so discovery can back off. A processed
        // session without a watermark (only reachable via --force) keeps its
        // processed entry: marking it failed would let discovery reflect the
        // whole transcript again and re-count its feedback.
        if (!priorDone || watermark !== undefined) pendingFailureEntries.push({
          ...(prior ?? {}),
          sessionPath,
          processedAt: prior?.processedAt ?? now(),
          deltasGenerated: prior?.deltasGenerated ?? 0,
          status: "failed",
          failures: (prior?.status === "failed" ? (prior.failures ?? 1) : 0) + 1,
          lastFailureAt: now(),
          lastError: message.slice(0, 500),
        });
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
        errors,
      };
    }

    if (inlineFeedbackDeltaCount > 0) outcomeSummary().inlineFeedbackDeltas = inlineFeedbackDeltaCount;

    // Freeze sanitized outcome identity and ownership before curation writes
    // anything. A preparation failure leaves the session eligible for retry
    // without having applied its rule changes or feedback.
    for (const entry of pendingProcessedEntries) {
      const inputs = pendingOutcomes.get(entry.sessionPath);
      if (!inputs?.length) continue;
      try {
        const prepared = [];
        for (const input of inputs) {
          prepared.push(await prepareOutcome(input, await configForOutcomeWorkspace(input.workspace)));
        }
        entry.pendingOutcomes = [...(entry.pendingOutcomes ?? []), ...prepared];
      } catch (err: any) {
        errors.push(`Auto-outcome preparation failed for ${entry.sessionPath}: ${err?.message || String(err)}`);
        return { sessionsProcessed: 0, deltasGenerated: 0, errors, autoOutcome };
      }
    }

    if (allDeltas.length === 0 && pendingProcessedEntries.length === 0) {
      // Nothing reflected (every session failed or had nothing new): no
      // playbook change and nothing to count, but retry state and refreshed
      // growth signals are still recorded.
      await processedLog.appendBatch([...pendingRefreshEntries, ...pendingFailureEntries]);
      return { sessionsProcessed, deltasGenerated: 0, errors, autoOutcome };
    }

    // Sessions that will be committed to the processed log by this run. Even
    // when no deltas were generated (empty sessions, no insights) we still
    // mark them processed to avoid infinite loops, and the global playbook's
    // reflection counters advance by exactly this many (#72).
    const committedSessionCount = pendingProcessedEntries.length;

    // 5. Merge Phase: Lock Playbooks, Reload, Curate, Save
    // We lock Global first, then Repo (if exists) to prevent deadlocks.
    let globalResult: CurationResult | undefined;
    let repoResult: CurationResult | undefined;
    const projectResults: Array<{ playbookPath: string; result: CurationResult }> = [];

    // Embeddings for the curator's reworded-duplicate check, computed before
    // taking the merge lock (embedding can be slow). Rules a concurrent writer
    // adds in between simply have no embedding and fall back to word overlap.
    const incomingContents = allDeltas.flatMap((d) =>
      d.type === "add" ? [d.bullet.content] : d.type === "merge" ? [d.mergedContent] : [],
    );
    let semanticIndex: SemanticDedupIndex | undefined;
    if (incomingContents.length > 0) {
      const existing = [
        ...(await loadPlaybook(globalPath)).bullets,
        ...(hasRepo ? (await loadPlaybook(repoPath!)).bullets : []),
      ];
      semanticIndex = await buildSemanticDedupIndex(existing, incomingContents, config);
    }

    const performMerge = async () => {
      // Reload fresh playbooks under lock
      const globalPlaybook = await loadPlaybook(globalPath);
      let repoPlaybook: Playbook | null = null;
      if (hasRepo) {
        repoPlaybook = await loadPlaybook(repoPath!);
      }

      // Create fresh merged context to ensure deduplication uses up-to-date data
      const freshMerged = mergePlaybooks(globalPlaybook, repoPlaybook);

      // Merges must inspect the current sources and successfully establish a
      // replacement before retiring anything. Decomposing all merges up front
      // used stale sources, lost scope, and could retire rules after an add was
      // rejected or deduplicated into an unrelated rule.
      const processedDeltas = allDeltas.filter((delta) => delta.type !== "merge");
      const mergeDeltas = allDeltas.filter((delta) => delta.type === "merge");

      // Partition deltas (Routing Logic)
      const globalDeltas: PlaybookDelta[] = [];
      const repoDeltas: PlaybookDelta[] = [];

      // "repo" routing (#81): project rules for another repository.
      const externalRepoDeltas = new Map<string, PlaybookDelta[]>();

      for (const delta of processedDeltas) {
        let routed = false;

        const target = projectTargets.get(delta);
        if (target && delta.type === "add") {
          if (repoPlaybook && repoPath && samePlaybookPath(target.playbookPath, repoPath)) {
            // A repo playbook is implicitly scoped to its repository; keeping
            // an absolute path would break the rule in other clones.
            delete delta.bullet.workspace;
            repoDeltas.push(delta);
          } else {
            const list = externalRepoDeltas.get(target.playbookPath) ?? [];
            list.push(delta);
            externalRepoDeltas.set(target.playbookPath, list);
          }
          continue;
        }

        // Feedback/Replace/Delete: Must target existing ID
        if ("bulletId" in delta && delta.bulletId) {
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

      // Other repositories first, so a repo that cannot be written falls back
      // to the global playbook (still workspace-scoped) in this same merge.
      // Lock order is always global -> cwd repo -> other repos (sorted), and
      // nothing takes a repo lock before the global one, so this cannot deadlock.
      for (const playbookPath of [...externalRepoDeltas.keys()].sort()) {
        const deltas = externalRepoDeltas.get(playbookPath)!;
        try {
          await withLock(playbookPath, async () => {
            const targetPlaybook = await loadPlaybook(playbookPath);
            const portable = deltas.map((d) => {
              if (d.type !== "add") return d;
              const { workspace: _workspace, ...bullet } = d.bullet;
              return { ...d, bullet };
            });
            const result = curatePlaybook(
              targetPlaybook,
              portable,
              config,
              mergePlaybooks(globalPlaybook, targetPlaybook),
              { semanticIndex, allowImplicitWorkspace: true },
            );
            await savePlaybook(result.playbook, playbookPath, { updateLastReflection: true });
            projectResults.push({ playbookPath, result });
          });
        } catch (err: any) {
          errors.push(
            `Could not write project rules to ${playbookPath} (${err?.message || String(err)}); kept them in the global playbook, scoped to the project`,
          );
          globalDeltas.push(...deltas);
        }
      }

      // Apply Curation
      if (globalDeltas.length > 0) {
        globalResult = curatePlaybook(globalPlaybook, globalDeltas, config, freshMerged, {
          semanticIndex,
        });
      }

      if (repoDeltas.length > 0 && repoPlaybook && repoPath) {
        repoResult = curatePlaybook(repoPlaybook, repoDeltas, config, freshMerged, {
          semanticIndex,
          allowImplicitWorkspace: true,
        });
      }

      const recordResult = (target: Playbook, result: CurationResult) => {
        if (target === repoPlaybook) repoResult = accumulateCurationResult(repoResult, result);
        else globalResult = accumulateCurationResult(globalResult, result);
      };
      const applyToLayer = (target: Playbook, deltas: PlaybookDelta[]) => {
        if (deltas.length === 0) return;
        recordResult(target, curatePlaybook(
          target, deltas, config, mergePlaybooks(globalPlaybook, repoPlaybook),
          { semanticIndex, allowImplicitWorkspace: target === repoPlaybook },
        ));
      };

      if (mergeDeltas.length > 0) {
        // Resolve harmful-rule inversion and retirement before selecting any
        // replacement. Otherwise a rule can look active during selection and
        // be retired by curation immediately after every source points to it.
        recordResult(globalPlaybook, curatePlaybook(
          globalPlaybook, [], config, mergePlaybooks(globalPlaybook, repoPlaybook), { semanticIndex },
        ));
        if (repoPlaybook) recordResult(repoPlaybook, curatePlaybook(
          repoPlaybook, [], config, mergePlaybooks(globalPlaybook, repoPlaybook),
          { semanticIndex, allowImplicitWorkspace: true },
        ));
      }

      for (const delta of mergeDeltas) {
        const repoIds = new Set(repoPlaybook?.bullets.map((bullet) => bullet.id) ?? []);
        const owner = (id: string): Playbook => repoPlaybook && repoIds.has(id) ? repoPlaybook : globalPlaybook;
        const target = repoPlaybook && delta.bulletIds.length > 0 && delta.bulletIds.every(id => repoIds.has(id))
          ? repoPlaybook : globalPlaybook;
        const rejectMerge = (reason: string) => {
          const message = `Cannot merge: ${reason}`;
          warn(`[orchestrator] ${message}`);
          recordResult(target, {
            playbook: target, applied: 0, skipped: 1, conflicts: [], promotions: [], inversions: [], pruned: 0,
            decisionLog: [{ timestamp: now(), phase: "add", action: "rejected", reason: message,
              details: { bulletIds: delta.bulletIds } }],
          });
        };
        const found = delta.bulletIds.map(id => findBullet(owner(id), id));
        if (found.some(bullet => !bullet)) {
          rejectMerge("one or more source rules are missing");
          continue;
        }
        const sources = found as PlaybookBullet[];
        // A pathless workspace rule in the repository has a known owner. Use
        // that path for comparisons, while keeping repository-only writes
        // portable across clones. A cross-layer replacement needs it stored.
        const effectiveScope = (bullet: PlaybookBullet): PlaybookBullet =>
          repoDir && repoIds.has(bullet.id) && bullet.scope === "workspace" && !bullet.workspace?.trim()
            ? { ...bullet, workspace: path.dirname(repoDir) } : bullet;
        const sameLayer = sources.every(bullet => owner(bullet.id) === target);
        const allowImplicitWorkspace = sameLayer && target === repoPlaybook;
        const scopedSources = sources.map(effectiveScope);
        const invalid = validateMergeSources(scopedSources, delta.mergedContent, { allowImplicitWorkspace });
        if (invalid) {
          rejectMerge(invalid);
          continue;
        }
        const first = sources[0];
        const firstScope = scopedSources[0];
        if (!first || !firstScope) continue; // validation requires at least two sources
        const eligible = (bullet: PlaybookBullet) =>
          // Global sources cannot retire into a repository replacement that
          // has not been saved yet. Cross-layer replacements stay global so
          // the global-before-repo write order always persists them first.
          (target !== globalPlaybook || owner(bullet.id) === globalPlaybook) &&
          bullet.type === first.type && bullet.isNegative === first.isNegative &&
          sameRuleScope(firstScope, effectiveScope(bullet), {
            allowImplicitWorkspace: allowImplicitWorkspace && owner(bullet.id) === target,
          });
        const currentContext = mergePlaybooks(globalPlaybook, repoPlaybook);
        const exact = findFirstHashMatch(currentContext, delta.mergedContent, eligible);
        if (exact && !isActiveBullet(exact)) {
          rejectMerge(`replacement text belongs to retired rule ${exact.id}`);
          continue;
        }
        let replacement = exact ?? findBestActiveSimilarBullet(
          currentContext, delta.mergedContent, config.dedupSimilarityThreshold ?? 0.85, eligible,
        );
        if (replacement) {
          const invalidReplacement = validateMergeSources(scopedSources, replacement.content, {
            allowImplicitWorkspace,
          });
          if (invalidReplacement) {
            rejectMerge(invalidReplacement);
            continue;
          }
        }
        if (!replacement) {
          const id = generateBulletId();
          const scope = target === repoPlaybook ? first : firstScope;
          applyToLayer(target, [{
            type: "add",
            bullet: {
              id, content: delta.mergedContent, category: first.category,
              kind: first.kind, type: first.type, isNegative: first.isNegative,
              scope: scope.scope, scopeKey: scope.scopeKey, workspace: scope.workspace,
              tags: [...new Set(sources.flatMap(bullet => bullet.tags))],
            },
            sourceSession: "merged-operation",
            reason: delta.reason || "Merged from existing rules",
          }]);
          replacement = findBullet(target, id);
          if (!replacement || !isActiveBullet(replacement)) {
            rejectMerge("replacement was not retained; original rules were preserved");
            continue;
          }
          replacement.sourceSessions = [];
          replacement.sourceAgents = [];
        }
        replacement.sourceSessions = [...new Set([
          ...replacement.sourceSessions, ...sources.flatMap(bullet => bullet.sourceSessions),
        ])];
        replacement.sourceAgents = [...new Set([
          ...replacement.sourceAgents, ...sources.flatMap(bullet => bullet.sourceAgents),
        ])];
        replacement.tags = [...new Set([...replacement.tags, ...sources.flatMap(bullet => bullet.tags)])];
        replacement.updatedAt = now();
        const deprecations: PlaybookDelta[] = sources
          .filter(bullet => bullet.id !== replacement.id)
          .map(bullet => ({
            type: "deprecate", bulletId: bullet.id,
            reason: `Merged into ${replacement.id}`, replacedBy: replacement.id,
          }));
        applyToLayer(globalPlaybook, deprecations.filter(d => "bulletId" in d && !repoIds.has(d.bulletId)));
        if (repoPlaybook) applyToLayer(repoPlaybook, deprecations.filter(d => "bulletId" in d && repoIds.has(d.bulletId)));
      }

      // The global playbook owns the run-level counters, so it is saved on
      // every committing run, delta or not (#72). Cross-layer replacements
      // live here: persist them before retiring their repository sources.
      const globalToSave = globalResult ? globalResult.playbook : globalPlaybook;
      recordReflectionRun(globalToSave, committedSessionCount);
      await savePlaybook(globalToSave, globalPath, { updateLastReflection: true });
      if (repoResult && repoPath) {
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

    // Persist the watermark and prepared outcome queue together, only after
    // curation succeeds. Losing outcome I/O later cannot lose the retry work.
    await processedLog.appendBatch([
      ...pendingProcessedEntries,
      ...pendingRefreshEntries,
      ...pendingFailureEntries,
    ]);

    // 6. Persist and apply outcomes from their durable queue. Completion is
    // acknowledged only after both operations succeed; replays use their
    // original IDs, timestamps and rule owners without invoking the LLM.
    await drainPendingOutcomes();
    if (autoOutcome?.outcomesRecorded) {
      log(`Auto-recorded ${autoOutcome.outcomesRecorded} outcome(s): ${autoOutcome.feedbackApplied} feedback event(s) applied`);
    }

    return {
      sessionsProcessed,
      deltasGenerated: allDeltas.length,
      globalResult,
      repoResult,
      ...(projectResults.length > 0 ? { projectResults } : {}),
      errors,
      autoOutcome,
    };
  }, lockWait);
}
