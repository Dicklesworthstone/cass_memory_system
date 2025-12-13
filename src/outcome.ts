import fs from "node:fs/promises";
import path from "node:path";
import { Config, FeedbackEvent } from "./types.js";
import { expandPath, ensureDir, fileExists, now, resolveRepoDir } from "./utils.js";
import { sanitize } from "./sanitize.js";
import { getSanitizeConfig } from "./config.js";
import { loadPlaybook, savePlaybook, findBullet } from "./playbook.js";
import { calculateMaturityState } from "./scoring.js";
import { withLock } from "./lock.js";

// --- Types ---

export type OutcomeStatus = "success" | "failure" | "partial" | "mixed"; // added mixed to match CLI
export type Sentiment = "positive" | "negative" | "neutral";

export interface OutcomeInput {
  sessionId: string;
  outcome: OutcomeStatus;
  rulesUsed?: string[];
  notes?: string;
  durationSec?: number;
  task?: string;
  errorCount?: number;
  hadRetries?: boolean;
  sentiment?: Sentiment;
}

export interface OutcomeRecord extends OutcomeInput {
  recordedAt: string;
  path: string;
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
    if (signals.durationSec > 0 && signals.durationSec < FAST_THRESHOLD_SECONDS && signals.outcome !== "failure") {
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

  if (helpfulFinal >= harmfulFinal) {
    return {
      type: "helpful",
      decayedValue: Math.min(2, Math.max(0.1, helpfulFinal)),
      context: reasons.join(", "),
    };
  }

  return {
    type: "harmful",
    decayedValue: Math.min(2, Math.max(0.1, harmfulFinal)),
    context: reasons.join(", "),
  };
}

// --- Persistence ---

export async function resolveOutcomeLogPath(): Promise<string> {
  const repoDir = await resolveRepoDir();
  const useRepoLog = repoDir ? await fileExists(repoDir) : false;
  if (useRepoLog) return path.join(repoDir!, "outcomes.jsonl");

  return expandPath("~/.cass-memory/outcomes.jsonl");
}

async function resolveContextLogPath(): Promise<string> {
  const repoDir = await resolveRepoDir();
  const useRepoLog = repoDir ? await fileExists(repoDir) : false;
  if (useRepoLog) return path.join(repoDir!, "context-log.jsonl");
  return expandPath("~/.cass-memory/context-log.jsonl");
}

export async function recordOutcome(
  input: OutcomeInput,
  config: Config
): Promise<OutcomeRecord> {
  const targetPath = await resolveOutcomeLogPath();
  const sanitizeConfig = getSanitizeConfig(config);
  
  // Sanitize user input fields
  const cleanedNotes = input.notes
    ? sanitize(input.notes, sanitizeConfig)
    : undefined;
  const cleanedTask = input.task
    ? sanitize(input.task, sanitizeConfig)
    : undefined;

  const record: OutcomeRecord = {
    ...input,
    notes: cleanedNotes,
    task: cleanedTask,
    rulesUsed: input.rulesUsed || [],
    recordedAt: new Date().toISOString(),
    path: targetPath
  };

  await ensureDir(path.dirname(targetPath));
  // Append is atomic for small writes on POSIX
  await fs.appendFile(targetPath, JSON.stringify(record) + "\n", "utf-8");

  return record;
}

export async function loadOutcomes(
  config: Config,
  limit = 100
): Promise<OutcomeRecord[]> {
  const targetPath = await resolveOutcomeLogPath();
  if (!(await fileExists(targetPath))) return [];

  const content = await fs.readFile(targetPath, "utf-8");
  const lines = content.split("\n").filter(Boolean);
  const parsed = lines
    .slice(-limit)
    .map((line) => {
      try {
        return JSON.parse(line) as OutcomeRecord;
      } catch {
        return null;
      }
    })
    .filter((x): x is OutcomeRecord => Boolean(x));

  const sanitizeConfig = getSanitizeConfig(config);

  // Sanitize again on read for defense in depth
  return parsed.map((o) => ({
    ...o,
    notes: o.notes ? sanitize(o.notes, sanitizeConfig) : o.notes,
    task: o.task ? sanitize(o.task, sanitizeConfig) : o.task
  }));
}

// --- Feedback Application (Safe) ---

async function loadContextLog(limit = 200): Promise<ContextLogEntry[]> {
  const logPath = await resolveContextLogPath();
  if (!(await fileExists(logPath))) return [];
  const content = await fs.readFile(logPath, "utf-8");
  const lines = content.split("\n").filter(Boolean);
  return lines
    .slice(-limit)
    .map((line) => {
      try {
        return JSON.parse(line) as ContextLogEntry;
      } catch {
        return null;
      }
    })
    .filter((x): x is ContextLogEntry => Boolean(x));
}

function enrichOutcomeWithContext(outcome: OutcomeRecord, contextLog: ContextLogEntry[]): OutcomeRecord {
  if (outcome.rulesUsed && outcome.rulesUsed.length > 0) return outcome;
  if (!outcome.sessionId) return outcome;

  const match = contextLog
    .filter((e) => e.session === outcome.sessionId && Array.isArray(e.ruleIds) && e.ruleIds.length > 0)
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0];

  if (!match) return outcome;
  return { ...outcome, rulesUsed: match.ruleIds };
}

async function resolveTargetPath(
  bulletId: string,
  globalPath: string,
  repoPath: string | null
): Promise<string | null> {
  // Prefer repo
  if (repoPath && (await fileExists(repoPath))) {
    try {
      const repoPlaybook = await loadPlaybook(repoPath);
      if (findBullet(repoPlaybook, bulletId)) {
        return repoPath;
      }
    } catch {
      // Ignore load error, fall back
    }
  }
  // Fallback to global
  if (await fileExists(globalPath)) {
    try {
        const globalPlaybook = await loadPlaybook(globalPath);
        if (findBullet(globalPlaybook, bulletId)) return globalPath;
    } catch {
        // Ignore
    }
  }
  return null;
}

export async function applyOutcomeFeedback(
  outcomes: OutcomeRecord | OutcomeRecord[],
  config: Config
): Promise<{ applied: number; missing: string[] }> {
  const list = Array.isArray(outcomes) ? outcomes : [outcomes];
  
  const globalPath = expandPath(config.playbookPath);
  const repoDir = await resolveRepoDir();
  const repoPath = repoDir ? path.join(repoDir, "playbook.yaml") : null;

  let applied = 0;
  const missing: string[] = [];

  // Pre-calculate updates: Map<PlaybookPath, Array<{ bulletId, feedback }>>
  const updates = new Map<string, Array<{ bulletId: string; feedback: FeedbackEvent }>>();
  const contextLog = await loadContextLog();

  for (const outcome of list) {
    const enriched = enrichOutcomeWithContext(outcome, contextLog);
    if (!enriched.rulesUsed || enriched.rulesUsed.length === 0) continue;
    
    const scored = scoreImplicitFeedback(enriched);
    if (!scored) continue;

    for (const ruleId of enriched.rulesUsed) {
      const targetPath = await resolveTargetPath(ruleId, globalPath, repoPath);
      
      if (!targetPath) {
        missing.push(ruleId);
        continue;
      }

      if (!updates.has(targetPath)) {
        updates.set(targetPath, []);
      }

      updates.get(targetPath)!.push({
        bulletId: ruleId,
        feedback: {
          type: scored.type,
          timestamp: now(),
          sessionPath: enriched.sessionId,
          context: scored.context,
          decayedValue: scored.decayedValue,
          // Map harmful reason if applicable
          reason: scored.type === "harmful" ? "other" : undefined
        }
      });
    }
  }

  // Apply updates with locking, per playbook file
  for (const [targetPath, items] of updates.entries()) {
    await withLock(targetPath, async () => {
      const playbook = await loadPlaybook(targetPath);
      let modified = false;

      for (const item of items) {
        const bullet = findBullet(playbook, item.bulletId);
        if (!bullet) {
          // Could happen if deleted between check and lock
          missing.push(item.bulletId);
          continue;
        }

        bullet.feedbackEvents = bullet.feedbackEvents || [];
        bullet.feedbackEvents.push(item.feedback);
        
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
      }
    });
  }

  return { applied, missing };
}
