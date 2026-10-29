import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { formatSessionRecords } from "./cass.js";
import { getSanitizeConfig } from "./config.js";
import { withLock } from "./lock.js";
import { loadPlaybook, resolveRepoPlaybookPath, savePlaybook } from "./playbook.js";
import { sanitize } from "./sanitize.js";
import { calculateMaturityState } from "./scoring.js";
import { containsCmSubprocessPayload } from "./subprocess-tag.js";
import { OutcomeInputSchema, OutcomeRecordSchema, type Config, type DiaryEntry, type FeedbackEvent, type TranscriptRuleEvidence } from "./types.js";
import { normalizeWorkspacePath, resolveProjectRoot } from "./workspace.js";
import {
  canonicalStoragePath,
  ensureDir,
  ensureDurableDirectory,
  expandPath,
  fileExists,
  now,
  resolveGlobalDir,
  resolveRepoDir,
  syncDirectory,
  validateNonEmptyString,
} from "./utils.js";

// --- Types ---

export type OutcomeStatus = "success" | "failure" | "partial" | "mixed"; // added mixed to match CLI
export type Sentiment = "positive" | "negative" | "neutral";

// --- Sentiment Detection ---

const POSITIVE_PATTERNS = [
  /that worked/i,
  /perfect/i,
  /thanks/i,
  /great/i,
  /exactly what i needed/i,
  /solved it/i,
  /\blgtm\b/i,
  /looks good/i,
  /nice work/i,
  /well done/i,
  /ship it/i,
];

const NEGATIVE_PATTERNS = [
  /that('s| is) wrong/i,
  /doesn't work/i,
  /broke/i,
  /not what i wanted/i,
  /try again/i,
  /undo/i,
  /\brevert\b/i,
  /don't do that/i,
  /that's not right/i,
  /start over/i,
  /roll\s*back/i,
];

export function detectSentiment(text?: string): Sentiment {
  if (!text) return "neutral";
  const positiveCount = POSITIVE_PATTERNS.filter((p) => p.test(text)).length;
  const negativeCount = NEGATIVE_PATTERNS.filter((p) => p.test(text)).length;
  if (positiveCount > negativeCount) return "positive";
  if (negativeCount > positiveCount) return "negative";
  return "neutral";
}

export interface OutcomeInput {
  sessionId: string;
  outcome: OutcomeStatus;
  rulesUsed?: string[];
  /** Workspace where the rules were retrieved; persisted for later replay. */
  workspace?: string;
  notes?: string;
  durationSec?: number;
  task?: string;
  errorCount?: number;
  hadRetries?: boolean;
  sentiment?: Sentiment;
  /**
   * True when `rulesUsed` was harvested automatically — i.e. it is the set of
   * rules that `cm context` *injected/showed* in the transcript (or was
   * back-filled from the context log), NOT a list the agent deliberately cited.
   * A shown rule cannot be assumed to have *caused* anything, so auto-graded
   * outcomes are held to a stricter attribution policy in
   * `scoreImplicitFeedback` (see #56). Manual `cm outcome` / MCP `cm_outcome`
   * calls leave this unset, so explicit user-provided rule lists are graded
   * normally.
   */
  autoGraded?: boolean;
  /**
   * Original transcript records supporting each automatically extracted rule.
   * Presence opts into source-evidence deduplication; an empty list abstains.
   * Omitted on manual outcomes and legacy records whose evidence is unknown.
   */
  transcriptEvidence?: TranscriptRuleEvidence[];
}

export interface OutcomeRecord extends OutcomeInput {
  id?: string;
  recordedAt: string;
  path: string;
  globalPlaybookPath?: string;
  ruleTargets?: Array<{ ruleId: string; playbookPath: string | null }>;
}

export interface ContextLogEntry {
  task: string;
  ruleIds: string[];
  antiPatternIds: string[];
  workspace?: string;
  session?: string;
  timestamp: string;
  source?: string;
}

// --- Constants & Scoring Logic ---

const FAST_THRESHOLD_SECONDS = 600; // 10 minutes
const SLOW_THRESHOLD_SECONDS = 3600; // 1 hour

/**
 * #56 — Harm-attribution guards.
 *
 * The auto-outcome grader applies a single session-level verdict to *every*
 * rule ID that appears in a transcript. Because `cm context` injects the
 * playbook, that set is the whole shown context, not deliberate citations.
 * Two guards keep a non-success session from condemning rules it merely
 * displayed:
 *
 * 1. HARM_OVERRIDE_MARGIN — on any outcome that is NOT an explicit `failure`
 *    (i.e. `success` / `mixed` / `partial`), incidental negative signals must
 *    not be allowed to *manufacture* harm. Harm is only warranted when the
 *    negative evidence dominates the positive evidence by at least a full
 *    clear-signal's worth (1.0). This still lets an overwhelming pile-up of
 *    negative signals flip a session (the historical "success can become
 *    harmful" behaviour), but a single error (+0.3) in an ambiguous `mixed`
 *    session can no longer flip dozens of rules to harmful — it abstains
 *    instead (neutral / no-op grading).
 *
 * 2. AUTO_GRADE_BLAST_RADIUS — when an *auto-graded* outcome attributes to more
 *    rules than any agent could plausibly have deliberately cited in one
 *    session, the set is the injected context, not citations. We never
 *    manufacture harm across such a set (we cannot tell which shown rule, if
 *    any, contributed). Genuine small-N citations still grade normally.
 */
const HARM_OVERRIDE_MARGIN = 1.0;
const AUTO_GRADE_BLAST_RADIUS = 8;

export function scoreImplicitFeedback(signals: OutcomeInput): {
  type: "helpful" | "harmful";
  decayedValue: number;
  context: string;
} | null {
  let helpfulScore = 0;
  let harmfulScore = 0;
  const reasons: string[] = [];

  if (signals.outcome === "success") {
    helpfulScore += 1;
    reasons.push("success");
  } else if (signals.outcome === "failure") {
    harmfulScore += 1;
    reasons.push("failure");
  } else {
    // mixed/partial
    helpfulScore += 0.1;
    harmfulScore += 0.1;
    reasons.push(signals.outcome);
  }

  if (typeof signals.durationSec === "number") {
    if (
      signals.durationSec > 0 &&
      signals.durationSec < FAST_THRESHOLD_SECONDS &&
      signals.outcome !== "failure"
    ) {
      helpfulScore += 0.5;
      reasons.push("fast");
    } else if (signals.durationSec > SLOW_THRESHOLD_SECONDS) {
      harmfulScore += 0.3;
      reasons.push("slow");
    }
  }

  if (typeof signals.errorCount === "number") {
    if (signals.errorCount >= 2) {
      harmfulScore += 0.7;
      reasons.push("errors>=2");
    } else if (signals.errorCount === 1) {
      harmfulScore += 0.3;
      reasons.push("error");
    }
  }

  if (signals.hadRetries) {
    harmfulScore += 0.5;
    reasons.push("retries");
  }

  if (signals.sentiment === "positive") {
    helpfulScore += 0.3;
    reasons.push("sentiment+");
  } else if (signals.sentiment === "negative") {
    harmfulScore += 0.5;
    reasons.push("sentiment-");
  }

  const helpfulFinal = Math.max(0, helpfulScore);
  const harmfulFinal = Math.max(0, harmfulScore);

  if (helpfulFinal === 0 && harmfulFinal === 0) return null;

  // --- Harm-attribution policy (#56) ---
  //
  // An auto-graded outcome whose rule set is the injected context (too large to
  // be deliberate citations) must never produce harm: we cannot attribute a
  // failure to any specific *shown* rule, so blanket-blaming them is pure noise.
  const isBroadAutoGraded =
    signals.autoGraded === true && (signals.rulesUsed?.length ?? 0) > AUTO_GRADE_BLAST_RADIUS;

  // Harm is only warranted when EITHER the primary outcome is an explicit
  // `failure`, OR the negative evidence dominates the positive evidence by a
  // full clear-signal's margin. A `mixed`/`partial`/`success` session with only
  // weak, incidental negatives (a single error, one retry, one terse phrase)
  // must not condemn the rules it merely displayed. The `- 1e-9` tolerance
  // keeps the margin robust against floating-point accumulation.
  const harmJustified =
    !isBroadAutoGraded &&
    (signals.outcome === "failure"
      ? harmfulFinal >= helpfulFinal
      : harmfulFinal - helpfulFinal >= HARM_OVERRIDE_MARGIN - 1e-9);

  if (harmJustified) {
    return {
      type: "harmful",
      decayedValue: Math.min(2, Math.max(0.1, harmfulFinal)),
      context: reasons.join(", "),
    };
  }

  // Not harmful. Credit `helpful` when there is a net-positive (or tied) lean;
  // otherwise abstain (return null) rather than fabricate a signal on
  // inconclusive evidence — this is the neutral / no-op grading that prevents
  // the corpus-wide false-negative flood.
  if (helpfulFinal >= harmfulFinal) {
    return {
      type: "helpful",
      decayedValue: Math.min(2, Math.max(0.1, helpfulFinal)),
      context: reasons.join(", "),
    };
  }

  return null;
}

// --- Persistence ---

function outcomeWorkspace(workspace?: string): string {
  const checked = validateNonEmptyString(workspace, "workspace", { allowUndefined: true });
  if (!checked.ok) throw new Error(checked.message);
  return normalizeWorkspacePath(checked.value ?? process.cwd());
}

export async function resolveOutcomeLogPath(workspace?: string): Promise<string> {
  const repoPath = await resolveRepoPlaybookPath({ cwd: outcomeWorkspace(workspace) });
  const repoDir = repoPath ? path.dirname(repoPath) : null;
  const useRepoLog = repoDir ? await fileExists(repoDir) : false;
  if (useRepoLog) return path.join(repoDir!, "outcomes.jsonl");

  return path.join(resolveGlobalDir(), "outcomes.jsonl");
}

async function resolveContextLogPath(workspace?: string): Promise<string> {
  const repoPath = await resolveRepoPlaybookPath({ cwd: outcomeWorkspace(workspace) });
  const repoDir = repoPath ? path.dirname(repoPath) : null;
  const useRepoLog = repoDir ? await fileExists(repoDir) : false;
  if (useRepoLog) return path.join(repoDir!, "context-log.jsonl");
  return path.join(resolveGlobalDir(), "context-log.jsonl");
}

/** Locations a recorded workspace may own, including either worktree playbook. */
async function outcomeLocations(workspace: string, config: Config) {
  const repoDir = await resolveRepoDir(workspace);
  const repoDirs = repoDir
    ? [repoDir, path.join(resolveProjectRoot(path.dirname(repoDir)), ".cass")]
    : [];
  return {
    playbooks: new Set([
      normalizeWorkspacePath(config.playbookPath),
      ...repoDirs.map(dir => normalizeWorkspacePath(path.join(dir, "playbook.yaml"))),
    ]),
    logs: new Set([
      normalizeWorkspacePath(path.join(resolveGlobalDir(), "outcomes.jsonl")),
      ...repoDirs.map(dir => normalizeWorkspacePath(path.join(dir, "outcomes.jsonl"))),
    ]),
  };
}

async function targetLookup(workspace: string, config: Config): Promise<Map<string, string>> {
  const targets = new Map<string, string>();
  const globalPath = path.resolve(expandPath(config.playbookPath));
  const repoPath = await resolveRepoPlaybookPath({ cwd: workspace });
  // Read each playbook once, then let repository IDs shadow global IDs.
  // Corrupt files abort attribution instead of redirecting feedback.
  for (const candidate of [globalPath, repoPath]) {
    if (!candidate || !(await fileExists(candidate))) continue;
    // Freeze the configured address, not the final file's symlink target:
    // savePlaybook atomically replaces that address during normal curation.
    // Ownership checks canonicalize paths separately.
    const resolved = path.resolve(expandPath(candidate));
    for (const bullet of (await loadPlaybook(resolved)).bullets) targets.set(bullet.id, resolved);
  }
  return targets;
}

function sanitizeOutcome(record: OutcomeRecord, config: Config): OutcomeRecord {
  const sanitizeConfig = getSanitizeConfig(config);
  return {
    ...record,
    notes: record.notes ? sanitize(record.notes, sanitizeConfig) : record.notes,
    task: record.task ? sanitize(record.task, sanitizeConfig) : record.task,
  };
}

/**
 * Prepare an immutable retry record without mutating the log or playbooks.
 * Callers resolve workspace policy; the supplied Config remains authoritative.
 */
export async function prepareOutcome(input: OutcomeInput, config: Config): Promise<OutcomeRecord> {
  const parsed = OutcomeInputSchema.parse(input);
  const workspace = outcomeWorkspace(parsed.workspace);
  const record = enrichOutcomeWithContext({
    ...parsed,
    workspace,
    globalPlaybookPath: canonicalStoragePath(config.playbookPath),
    id: randomUUID(),
    rulesUsed: [...new Set(parsed.rulesUsed ?? [])],
    recordedAt: new Date().toISOString(),
    path: await resolveOutcomeLogPath(workspace),
  }, await loadContextLog(200, workspace));
  const targets = await targetLookup(workspace, config);
  record.ruleTargets = [...new Set(record.rulesUsed ?? [])].map(ruleId => ({
    ruleId,
    playbookPath: targets.get(ruleId) ?? null,
  }));
  return sanitizeOutcome(record, config);
}

function outcomeIdentity(record: OutcomeRecord): string {
  // Sanitization may become stricter between retries; free text is not the
  // identity of a feedback event. All grading and ownership fields are.
  // Global owner provenance was added later. Its explicit conflicts are
  // checked separately so already-persisted legacy events remain replayable.
  return JSON.stringify({ ...OutcomeRecordSchema.parse(record), notes: undefined,
    task: undefined, globalPlaybookPath: undefined });
}

/** Persist the same prepared event at most once, even after an uncertain write. */
export async function persistOutcomeRecord(record: OutcomeRecord, config: Config): Promise<OutcomeRecord> {
  const parsed = OutcomeRecordSchema.parse(record);
  if (!parsed.id || !parsed.workspace || !parsed.ruleTargets) {
    throw new Error("Outcome persistence requires a prepared record with identity and ownership");
  }
  const cleaned = sanitizeOutcome(parsed, config);
  const locations = await outcomeLocations(parsed.workspace, config);
  if (!locations.logs.has(normalizeWorkspacePath(parsed.path))) {
    throw new Error("Outcome log does not belong to its recorded workspace");
  }
  await ensureDurableDirectory(path.dirname(parsed.path));
  await withLock(parsed.path, async () => {
    let content = "";
    let alreadyRecorded = false;
    try {
      content = await fs.readFile(parsed.path, "utf8");
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
    for (const line of content.split("\n")) {
      let existing: unknown;
      try { existing = JSON.parse(line); } catch { continue; }
      if (existing && typeof existing === "object" && "id" in existing && existing.id === parsed.id) {
        const prior = OutcomeRecordSchema.parse(existing);
        if (prior.globalPlaybookPath && cleaned.globalPlaybookPath
          && canonicalStoragePath(prior.globalPlaybookPath) !== canonicalStoragePath(cleaned.globalPlaybookPath)) {
          throw new Error("Outcome ID already belongs to a different global playbook owner");
        }
        if (outcomeIdentity(prior) !== outcomeIdentity(cleaned)) {
          throw new Error("Outcome ID already belongs to a different event");
        }
        alreadyRecorded = true;
        break;
      }
    }
    // A complete line may be visible after an earlier fsync failed. Reflush
    // that exact record before the caller can acknowledge its durable queue.
    const handle = await fs.open(parsed.path, alreadyRecorded ? "r+" : "a");
    try {
      if (!alreadyRecorded) {
        // Preserve an interrupted tail, but keep it from consuming the next
        // valid JSONL record. Never truncate or silently rewrite the log.
        const separator = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
        await handle.writeFile(separator + JSON.stringify(cleaned) + "\n", "utf8");
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(path.dirname(parsed.path));
  });
  return cleaned;
}

export async function recordOutcome(input: OutcomeInput, config: Config): Promise<OutcomeRecord> {
  return persistOutcomeRecord(await prepareOutcome(input, config), config);
}

export async function loadOutcomes(config: Config, limit = 100, workspace?: string): Promise<OutcomeRecord[]> {
  const targetPath = await resolveOutcomeLogPath(workspace);
  if (!(await fileExists(targetPath))) return [];

  const content = await fs.readFile(targetPath, "utf-8");
  const lines = content.split("\n").filter(Boolean);
  const parsed = lines
    .slice(-limit)
    .map((line) => {
      try {
        const parsed = OutcomeRecordSchema.safeParse(JSON.parse(line));
        return parsed.success ? parsed.data : null;
      } catch {
        return null;
      }
    })
    .filter((x): x is OutcomeRecord => Boolean(x));

  // Sanitize again on read for defense in depth
  return parsed.map(o => sanitizeOutcome(o, config));
}

// --- Feedback Application (Safe) ---

async function loadContextLog(limit = 200, workspace?: string): Promise<ContextLogEntry[]> {
  const logPath = await resolveContextLogPath(workspace);
  if (!(await fileExists(logPath))) return [];
  const content = await fs.readFile(logPath, "utf-8");
  const lines = content.split("\n").filter(Boolean);
  return lines
    .slice(-limit)
    .map((line) => {
      try {
        const value = JSON.parse(line);
        if (!value || typeof value !== "object" || !Array.isArray(value.ruleIds)
          || !value.ruleIds.every((id: unknown) => typeof id === "string" && id.length > 0)
          || typeof value.timestamp !== "string"
          || (value.workspace !== undefined && typeof value.workspace !== "string")) return null;
        return value as ContextLogEntry;
      } catch {
        return null;
      }
    })
    .filter((x): x is ContextLogEntry => Boolean(x));
}

function enrichOutcomeWithContext(
  outcome: OutcomeRecord,
  contextLog: ContextLogEntry[],
): OutcomeRecord {
  if (outcome.rulesUsed && outcome.rulesUsed.length > 0) return outcome;
  if (!outcome.sessionId) return outcome;

  const match = contextLog
    .filter(
      (e) => e.session === outcome.sessionId && Array.isArray(e.ruleIds) && e.ruleIds.length > 0
        && (!e.workspace || !outcome.workspace
          || resolveProjectRoot(e.workspace) === resolveProjectRoot(outcome.workspace)),
    )
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0];

  if (!match) return outcome;
  // The back-filled IDs come straight from the injected context log — these
  // rules were *shown*, not deliberately cited — so mark the outcome auto-graded
  // to apply the stricter harm-attribution policy (#56).
  return { ...outcome, rulesUsed: match.ruleIds, autoGraded: true };
}

export async function applyOutcomeFeedback(
  outcomes: OutcomeRecord | OutcomeRecord[],
  config: Config,
  workspace?: string,
): Promise<{ applied: number; missing: string[] }> {
  const list = Array.isArray(outcomes) ? outcomes : [outcomes];
  const fallbackWorkspace = outcomeWorkspace(workspace);

  let applied = 0;
  const missing: string[] = [];

  // Pre-calculate updates: Map<PlaybookPath, Array<{ bulletId, feedback }>>
  const updates = new Map<string, Array<{ bulletId: string; feedback: FeedbackEvent }>>();
  const contexts = new Map<string, ContextLogEntry[]>();
  const targets = new Map<string, Map<string, string>>();

  for (const raw of list) {
    const outcome = OutcomeRecordSchema.parse(raw);
    const owner = outcomeWorkspace(outcome.workspace ?? fallbackWorkspace);
    let enriched = outcome;
    if (!outcome.ruleTargets) {
      let contextLog = contexts.get(owner);
      if (!contextLog) {
        contextLog = await loadContextLog(200, owner);
        contexts.set(owner, contextLog);
      }
      enriched = enrichOutcomeWithContext({ ...outcome, workspace: owner }, contextLog);
    }
    if (!enriched.rulesUsed || enriched.rulesUsed.length === 0) continue;

    const scored = scoreImplicitFeedback(enriched);
    if (!scored) continue;
    const transcriptEvidence = enriched.transcriptEvidence === undefined
      ? undefined
      : new Map(enriched.transcriptEvidence.map(entry => [entry.ruleId, entry.recordKeys]));

    let lookup: Map<string, string | null>;
    if (enriched.ruleTargets) {
      const allowed = (await outcomeLocations(owner, config)).playbooks;
      lookup = new Map(enriched.ruleTargets.map(target => {
        if (target.playbookPath && !allowed.has(normalizeWorkspacePath(target.playbookPath))) {
          throw new Error("Outcome feedback target does not belong to its recorded workspace");
        }
        return [target.ruleId, target.playbookPath];
      }));
    } else {
      let resolved = targets.get(owner);
      if (!resolved) {
        resolved = await targetLookup(owner, config);
        targets.set(owner, resolved);
      }
      lookup = resolved;
    }

    for (const ruleId of new Set(enriched.rulesUsed)) {
      const recordKeys = transcriptEvidence?.get(ruleId);
      // A transcript-backed outcome cannot attribute a rule to evidence it
      // did not observe. Missing evidence is not the legacy/manual fallback.
      if (transcriptEvidence !== undefined && !recordKeys?.length) continue;
      const targetPath = lookup.get(ruleId);

      if (!targetPath) {
        missing.push(ruleId);
        continue;
      }

      const updateItem = {
        bulletId: ruleId,
        feedback: {
          type: scored.type,
          ...(enriched.id ? { outcomeId: enriched.id } : {}),
          ...(recordKeys ? { transcriptEvidenceKeys: recordKeys } : {}),
          // Use the outcome's recordedAt for stable idempotency across replays of the outcome log.
          timestamp: enriched.recordedAt,
          sessionPath: enriched.sessionId,
          context: scored.context,
          decayedValue: scored.decayedValue,
          // Map harmful reason if applicable
          reason: scored.type === "harmful" ? ("other" as const) : undefined,
        },
      };

      const bucket = updates.get(targetPath);
      if (bucket) bucket.push(updateItem);
      else updates.set(targetPath, [updateItem]);
    }
  }

  // Apply updates with locking, per playbook file
  for (const [targetPath, items] of updates.entries()) {
    await withLock(targetPath, async () => {
      if (!(await fileExists(targetPath))) {
        throw new Error(`Outcome playbook is unavailable: ${targetPath}`);
      }
      const playbook = await loadPlaybook(targetPath);
      const bullets = new Map(playbook.bullets.map(bullet => [bullet.id, bullet]));
      const consumedEvidence = new Map<string, Set<string>>();
      let modified = false;
      let reusedFeedback = false;

      for (const item of items) {
        const bullet = bullets.get(item.bulletId);
        if (!bullet) {
          // Could happen if deleted between check and lock
          missing.push(item.bulletId);
          continue;
        }

        bullet.feedbackEvents = bullet.feedbackEvents || [];
        const alreadyRecorded = bullet.feedbackEvents.some(
          (e) =>
            item.feedback.outcomeId
              ? e.outcomeId === item.feedback.outcomeId
              : !e.outcomeId && e.type === item.feedback.type
                && e.sessionPath === item.feedback.sessionPath
                && e.timestamp === item.feedback.timestamp,
        );
        if (alreadyRecorded) {
          reusedFeedback = true;
          continue;
        }

        let feedback = item.feedback;
        if (feedback.transcriptEvidenceKeys) {
          let consumed = consumedEvidence.get(bullet.id);
          if (!consumed) {
            consumed = new Set(bullet.feedbackEvents.flatMap(event => event.transcriptEvidenceKeys ?? []));
            consumedEvidence.set(bullet.id, consumed);
          }
          const novel = feedback.transcriptEvidenceKeys.filter(key => !consumed.has(key));
          if (novel.length === 0) {
            reusedFeedback = true;
            continue;
          }
          // One event per graded batch with genuinely new evidence. Partial
          // overlaps consume only new keys, regardless of processing order or
          // verdict. UUID replay and evidence consumption share this lock/save.
          feedback = { ...feedback, transcriptEvidenceKeys: novel };
          for (const key of novel) consumed.add(key);
        }
        bullet.feedbackEvents.push(feedback);

        // Update counters
        if (item.feedback.type === "helpful") {
          bullet.helpfulCount = (bullet.helpfulCount || 0) + 1;
        } else {
          bullet.harmfulCount = (bullet.harmfulCount || 0) + 1;
        }

        bullet.updatedAt = now();
        bullet.maturity = calculateMaturityState(bullet, config);
        modified = true;
        applied++;
      }

      if (modified) {
        await savePlaybook(playbook, targetPath);
      } else if (reusedFeedback) {
        // A prior atomic replacement may be visible before its directory
        // flush completed. Preserve any newer marks while establishing the
        // durability of the current image before acknowledging an outcome.
        const handle = await fs.open(targetPath, "r+");
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
        await ensureDurableDirectory(path.dirname(targetPath));
      }
    });
  }

  return { applied, missing };
}

// --- Auto-Outcome: Rule ID Extraction & Session Classification ---

/**
 * Regex to match playbook rule IDs in session transcripts.
 * Requires at least 6 alphanumeric chars after "b-" to avoid short false
 * positives (b-tree, b-tag). A post-filter additionally requires at least
 * one digit, since generated IDs (from Date.now().toString(36)) always
 * contain digits while English words (b-spline, b-factor) do not.
 *
 * The leading negative lookbehind `(?<![0-9a-f])` rejects matches preceded
 * by a hex digit, which prevents false positives inside UUIDs. For example,
 * a session path containing `00b8018e-2cd7-4e0b-9695-acef9cb0bbdc` would
 * otherwise yield a spurious `b-9695-acef9cb0bbdc` extraction because `\b`
 * matches at the boundary between `0` and `b`. The lookbehind blocks that
 * match while still permitting real IDs preceded by whitespace, `:`, `[`,
 * line start, etc. V8/Bun support look-behind so this is safe.
 */
const RULE_ID_PATTERN = /(?<![0-9a-f])b-[a-z0-9]{6,}(?:-[a-z0-9]+)*\b/gi;

/**
 * Extract playbook rule IDs (b-xxx format) from session transcript content.
 *
 * Scans for IDs as they appear in cm context output, inline feedback
 * comments, and general references in conversation. Results are
 * deduplicated and lowercased for consistent matching.
 *
 * Filters out pure-alpha matches (no digits) to exclude common words
 * like "b-spline" or "b-factor" that would otherwise match the pattern.
 */
export function extractRuleIdsFromTranscript(content: string): string[] {
  if (!content) return [];
  const matches = content.match(RULE_ID_PATTERN);
  if (!matches) return [];
  // Real bullet IDs always contain digits (from base36-encoded timestamps).
  // Pure-alpha matches are common English words, not IDs.
  return [...new Set(matches.filter((m) => /\d/.test(m)).map((m) => m.toLowerCase()))];
}

/**
 * Identify original source records independently of reflection batching.
 *
 * Pass the FULL exported record stream even when grading only a suffix. The
 * occurrence number distinguishes genuinely repeated identical records, and
 * must be counted across the earlier prefix too. Moving an unchanged record
 * or changing JSON object-key order does not create new evidence. Original
 * record hashes stay stable across sanitization policies; only sanitized
 * text can attribute a rule to one of those records. As in orchestration, a
 * cm payload marker anywhere excludes the full stream, including payloads
 * whose opening and closing markers are in different records.
 *
 * These keys cannot reconstruct provenance for legacy feedback without them,
 * or equate different export representations of the same original record.
 */
export function buildTranscriptEvidence(
  sessionPath: string,
  records: readonly unknown[],
  config: Config,
  options: { startRecord: number; ruleIds: readonly string[] },
): TranscriptRuleEvidence[] {
  if (!Number.isSafeInteger(options.startRecord) || options.startRecord < 0 || options.startRecord > records.length) {
    throw new Error("Transcript evidence start must be within the full record stream");
  }
  const session = normalizeWorkspacePath(sessionPath);
  const requested = new Set(options.ruleIds);
  const evidence = new Map<string, string[]>();
  const occurrences = new Map<string, number>();
  for (const [index, record] of records.entries()) {
    const serialized = JSON.stringify(record, (_key, value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return value;
      return Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]));
    });
    if (serialized === undefined) throw new Error("Transcript evidence requires JSON source records");
    const fingerprint = createHash("sha256").update(serialized).digest("hex");
    const occurrence = occurrences.get(fingerprint) ?? 0;
    occurrences.set(fingerprint, occurrence + 1);
    const content = formatSessionRecords([record], config);
    if (containsCmSubprocessPayload(content)) return [];
    if (index < options.startRecord) continue;
    const ruleIds = extractRuleIdsFromTranscript(content).filter(id => requested.has(id));
    if (ruleIds.length === 0) continue;
    const key = `te1:${createHash("sha256").update(JSON.stringify([session, fingerprint, occurrence])).digest("hex")}`;
    for (const ruleId of ruleIds) {
      const keys = evidence.get(ruleId);
      if (keys) keys.push(key);
      else evidence.set(ruleId, [key]);
    }
  }
  return [...requested].flatMap(ruleId => {
    const recordKeys = evidence.get(ruleId);
    return recordKeys ? [{ ruleId, recordKeys }] : [];
  });
}

/**
 * Heuristic patterns for counting error-like signals in transcripts.
 * Each pattern must appear at least twice to count as a signal
 * (single mentions could be discussion rather than actual errors).
 */
const ERROR_SIGNAL_PATTERNS = [
  /\berror\b/gi,
  /\bfailed\b/gi,
  /\bexception\b/gi,
  /\btraceback\b/gi,
  /\bpanic\b/gi,
];

const RETRY_SIGNAL_PATTERNS = [/try again/i, /retrying/i, /let me try/i, /attempt.*again/i];

const REJECTION_SIGNAL_PATTERNS = [
  /user denied/i,
  /permission denied/i,
  /tool.*rejected/i,
  /user.*rejected/i,
];

/**
 * Classify a session outcome from transcript content and diary entry.
 *
 * Uses lightweight heuristics:
 * - diary.status as primary outcome signal
 * - Sentiment detection on the tail of the transcript (more recent = more relevant)
 * - Error pattern frequency
 * - Retry and tool-rejection signals
 *
 * Returns null if no rule IDs are provided (nothing to record against).
 */
export function classifySessionOutcome(
  content: string,
  diary: DiaryEntry,
  ruleIds: string[],
): OutcomeInput | null {
  if (ruleIds.length === 0) return null;

  // Focus sentiment on the last portion of content (more recent = more relevant)
  const tailLength = Math.max(2000, Math.floor(content.length * 0.2));
  const tail = content.slice(-tailLength);
  const sentiment = detectSentiment(tail);

  // Count error-like patterns (require >=2 matches to count as a signal)
  let errorCount = 0;
  for (const p of ERROR_SIGNAL_PATTERNS) {
    p.lastIndex = 0;
    const matches = content.match(p);
    if (matches && matches.length >= 2) errorCount++;
  }

  // Tool rejection signals add to error count
  const rejectionCount = REJECTION_SIGNAL_PATTERNS.filter((p) => p.test(content)).length;
  errorCount += rejectionCount;

  // Retry signals
  const hadRetries = RETRY_SIGNAL_PATTERNS.some((p) => p.test(content));

  // Map diary status to outcome
  const outcome: OutcomeStatus =
    diary.status === "success"
      ? "success"
      : diary.status === "failure"
        ? "failure"
        : diary.status === "mixed"
          ? "mixed"
          : "partial";

  // Use first accomplishment or key learning as task context
  const task = diary.accomplishments?.[0] || diary.keyLearnings?.[0];

  return {
    sessionId: diary.sessionPath,
    outcome,
    rulesUsed: ruleIds,
    sentiment,
    errorCount,
    hadRetries,
    task,
    durationSec: diary.duration ?? undefined,
    // These IDs were scraped from the transcript (largely the rules `cm context`
    // injected), not deliberately cited, so they get the stricter #56 harm
    // policy / blast-radius guard.
    autoGraded: true,
  };
}
