import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { sanitize } from "./sanitize.js";
import type { ProcessedEntry } from "./types.js";
import {
  atomicWrite,
  ensureDir,
  expandPath,
  fileExists,
  now,
  resolveGlobalDir,
  warn,
  withLock,
} from "./utils.js";

// -----------------------------------------------------------------------------
// Usage Analytics Types
// -----------------------------------------------------------------------------

/**
 * Types of events tracked for usage analytics.
 */
export type UsageEventType =
  | "bullet_marked"
  | "command_run"
  | "session_count"
  | "reflection_stats"
  | "playbook_change"
  | "error_occurred";

/**
 * Base interface for all usage events.
 */
export interface UsageEventBase {
  timestamp: string;
  event: UsageEventType;
}

/**
 * Event when a bullet is marked helpful/harmful.
 */
export interface BulletMarkedEvent extends UsageEventBase {
  event: "bullet_marked";
  data: {
    bulletId: string;
    feedback: "helpful" | "harmful";
    reason?: string;
    sessionPath?: string;
  };
}

/**
 * Event when a CLI command is run.
 */
export interface CommandRunEvent extends UsageEventBase {
  event: "command_run";
  data: {
    command: string;
    scope?: string;
    duration_ms: number;
    success: boolean;
    error?: string;
  };
}

/**
 * Event tracking session discovery counts.
 */
export interface SessionCountEvent extends UsageEventBase {
  event: "session_count";
  data: {
    provider: string;
    count: number;
    workspace?: string;
  };
}

/**
 * Event tracking reflection statistics.
 */
export interface ReflectionStatsEvent extends UsageEventBase {
  event: "reflection_stats";
  data: {
    sessionsProcessed: number;
    deltasProposed: number;
    deltasApplied: number;
    workspace?: string;
  };
}

/**
 * Event tracking playbook changes.
 */
export interface PlaybookChangeEvent extends UsageEventBase {
  event: "playbook_change";
  data: {
    action: "add" | "remove" | "deprecate" | "update" | "merge";
    bulletId?: string;
    count?: number;
  };
}

/**
 * Event tracking errors for debugging.
 */
export interface ErrorOccurredEvent extends UsageEventBase {
  event: "error_occurred";
  data: {
    category: string;
    message: string;
    command?: string;
    stack?: string;
  };
}

/**
 * Union of all usage event types.
 */
export type UsageEvent =
  | BulletMarkedEvent
  | CommandRunEvent
  | SessionCountEvent
  | ReflectionStatsEvent
  | PlaybookChangeEvent
  | ErrorOccurredEvent;

// -----------------------------------------------------------------------------
// Usage Analytics Implementation
// -----------------------------------------------------------------------------

const DEFAULT_USAGE_LOG_PATH = () => path.join(resolveGlobalDir(), "usage.jsonl");
let usageLogPathOverride: string | null = null;

/**
 * Get the path to the usage log file.
 */
export function getUsageLogPath(): string {
  return usageLogPathOverride ?? DEFAULT_USAGE_LOG_PATH();
}

/**
 * Set the path to the usage log file (for testing).
 */
export function setUsageLogPath(p: string): void {
  usageLogPathOverride = expandPath(p);
}

/**
 * Track a usage event by appending to the usage log.
 * This is fire-and-forget - errors are logged but don't propagate.
 *
 * @param event - The event type
 * @param data - Event-specific data
 *
 * @example
 * trackEvent("bullet_marked", { bulletId: "b-123", feedback: "helpful" });
 * trackEvent("command_run", { command: "reflect", duration_ms: 2340, success: true });
 */
export async function trackEvent<T extends UsageEventType>(
  event: T,
  data: Extract<UsageEvent, { event: T }>["data"],
): Promise<void> {
  try {
    // Sanitize sensitive fields before logging
    const safeData = { ...data };

    if (event === "command_run") {
      const d = safeData as CommandRunEvent["data"];
      if (d.error) d.error = sanitize(d.error);
    } else if (event === "bullet_marked") {
      const d = safeData as BulletMarkedEvent["data"];
      if (d.reason) d.reason = sanitize(d.reason);
    } else if (event === "error_occurred") {
      const d = safeData as ErrorOccurredEvent["data"];
      if (d.message) d.message = sanitize(d.message);
      if (d.stack) d.stack = sanitize(d.stack);
    }

    const entry: UsageEvent = {
      timestamp: now(),
      event,
      data: safeData,
    } as UsageEvent;

    const logPath = getUsageLogPath();
    await ensureDir(path.dirname(logPath));

    await withLock(logPath, async () => {
      await fs.appendFile(logPath, JSON.stringify(entry) + "\n", "utf-8");
    });
  } catch (error) {
    // Fire-and-forget: log error but don't propagate
    warn(`Failed to track event: ${error}`);
  }
}

/**
 * Track a bullet being marked helpful/harmful.
 */
export async function trackBulletMarked(
  bulletId: string,
  feedback: "helpful" | "harmful",
  options?: { reason?: string; sessionPath?: string },
): Promise<void> {
  await trackEvent("bullet_marked", {
    bulletId,
    feedback,
    ...options,
  });
}

/**
 * Track a CLI command execution.
 */
export async function trackCommandRun(
  command: string,
  duration_ms: number,
  success: boolean,
  options?: { scope?: string; error?: string },
): Promise<void> {
  await trackEvent("command_run", {
    command,
    duration_ms,
    success,
    ...options,
  });
}

/**
 * Track session discovery counts.
 */
export async function trackSessionCount(
  provider: string,
  count: number,
  workspace?: string,
): Promise<void> {
  await trackEvent("session_count", {
    provider,
    count,
    workspace,
  });
}

/**
 * Track reflection statistics.
 */
export async function trackReflectionStats(
  sessionsProcessed: number,
  deltasProposed: number,
  deltasApplied: number,
  workspace?: string,
): Promise<void> {
  await trackEvent("reflection_stats", {
    sessionsProcessed,
    deltasProposed,
    deltasApplied,
    workspace,
  });
}

/**
 * Track playbook changes.
 */
export async function trackPlaybookChange(
  action: "add" | "remove" | "deprecate" | "update" | "merge",
  options?: { bulletId?: string; count?: number },
): Promise<void> {
  await trackEvent("playbook_change", {
    action,
    ...options,
  });
}

/**
 * Track errors for debugging.
 */
export async function trackError(
  category: string,
  message: string,
  options?: { command?: string; stack?: string },
): Promise<void> {
  await trackEvent("error_occurred", {
    category,
    message,
    ...options,
  });
}

/**
 * Load usage events from the log file.
 * Optionally filter by event type and/or time range.
 *
 * @param options - Filter options
 * @returns Array of usage events
 */
export async function loadUsageEvents(options?: {
  eventType?: UsageEventType;
  since?: string;
  limit?: number;
}): Promise<UsageEvent[]> {
  const logPath = getUsageLogPath();
  if (!(await fileExists(logPath))) {
    return [];
  }

  const content = await fs.readFile(logPath, "utf-8");
  const lines = content.split("\n").filter((line) => line.trim());

  let events: UsageEvent[] = [];

  for (const line of lines) {
    try {
      const event = JSON.parse(line) as UsageEvent;
      events.push(event);
    } catch {}
  }

  // Apply filters
  if (options?.eventType) {
    events = events.filter((e) => e.event === options.eventType);
  }

  if (options?.since) {
    const sinceDate = new Date(options.since);
    events = events.filter((e) => new Date(e.timestamp) >= sinceDate);
  }

  // Apply limit (from the end, most recent first)
  if (options?.limit && events.length > options.limit) {
    events = events.slice(-options.limit);
  }

  return events;
}

/**
 * Get usage statistics summary.
 */
export async function getUsageStats(): Promise<{
  totalEvents: number;
  eventCounts: Record<UsageEventType, number>;
  bulletFeedback: { helpful: number; harmful: number };
  commandStats: { total: number; successful: number; failed: number };
  lastActivity?: string;
}> {
  const events = await loadUsageEvents();

  const eventCounts: Record<UsageEventType, number> = {
    bullet_marked: 0,
    command_run: 0,
    session_count: 0,
    reflection_stats: 0,
    playbook_change: 0,
    error_occurred: 0,
  };

  let helpful = 0;
  let harmful = 0;
  let commandTotal = 0;
  let commandSuccess = 0;
  let commandFailed = 0;

  for (const event of events) {
    if (!event || !event.event) continue;
    eventCounts[event.event] = (eventCounts[event.event] || 0) + 1;

    if (event.event === "bullet_marked" && event.data) {
      if (event.data.feedback === "helpful") helpful++;
      else harmful++;
    }

    if (event.event === "command_run" && event.data && typeof event.data === "object") {
      commandTotal++;
      if ("success" in event.data && event.data.success) commandSuccess++;
      else commandFailed++;
    }
  }

  return {
    totalEvents: events.length,
    eventCounts,
    bulletFeedback: { helpful, harmful },
    commandStats: {
      total: commandTotal,
      successful: commandSuccess,
      failed: commandFailed,
    },
    lastActivity: events.length > 0 ? events[events.length - 1].timestamp : undefined,
  };
}

// -----------------------------------------------------------------------------
// Processed log paths
// -----------------------------------------------------------------------------

export function getProcessedLogPath(workspacePath?: string): string {
  const reflectionsDir = path.join(resolveGlobalDir(), "reflections");
  if (!workspacePath) {
    return path.join(reflectionsDir, "global.processed.log");
  }

  const resolved = path.resolve(expandPath(workspacePath));
  const hash = crypto.createHash("sha256").update(resolved).digest("hex").slice(0, 8);
  return path.join(reflectionsDir, `ws-${hash}.processed.log`);
}

function normalizeSessionPathForLog(sessionPath: string): string {
  const trimmed = (sessionPath || "").trim();
  if (!trimmed) return "";
  return path.resolve(expandPath(trimmed));
}

export class ProcessedLog {
  private entries: Map<string, ProcessedEntry> = new Map();
  private logPath: string;

  constructor(logPath: string) {
    this.logPath = logPath;
  }

  async load(): Promise<void> {
    if (!(await fileExists(this.logPath))) return;

    try {
      const content = await fs.readFile(this.logPath, "utf-8");
      const lines = content.split("\n").filter((line) => line.trim() && !line.startsWith("#"));

      for (const line of lines) {
        // Try JSONL first (new format)
        if (line.trim().startsWith("{")) {
          try {
            const entry = JSON.parse(line);
            if (entry.sessionPath) {
              const normalizedSessionPath = normalizeSessionPathForLog(entry.sessionPath);
              if (!normalizedSessionPath) continue;
              this.entries.set(normalizedSessionPath, {
                ...pickIncrementalFields(entry),
                sessionPath: normalizedSessionPath,
                processedAt: entry.processedAt || new Date().toISOString(),
                diaryId: entry.diaryId || entry.id, // Handle both keys for compatibility
                deltasGenerated:
                  typeof entry.deltasGenerated === "number" ? entry.deltasGenerated : 0,
              });
            }
            continue;
          } catch {
            // Fall through to TSV if JSON parse fails (hybrid file?)
          }
        }

        // TSV fallback (legacy format)
        try {
          const parts = line.split("\t");
          if (parts.length < 2) continue;

          const [id, sessionPath, processedAt, deltasProposed] = parts;
          if (sessionPath) {
            const normalizedSessionPath = normalizeSessionPathForLog(sessionPath);
            if (!normalizedSessionPath) continue;
            this.entries.set(normalizedSessionPath, {
              sessionPath: normalizedSessionPath,
              processedAt: processedAt || new Date().toISOString(),
              diaryId: id === "-" ? undefined : id,
              deltasGenerated: parseInt(deltasProposed || "0", 10),
            });
          }
        } catch {}
      }
    } catch (error) {
      warn(`Failed to load processed log: ${error}`);
    }
  }

  async save(): Promise<void> {
    const lines = ['# JSONL format: {"sessionPath":..., "processedAt":...}'];

    for (const entry of this.entries.values()) {
      lines.push(JSON.stringify(entry));
    }

    await withLock(this.logPath, async () => {
      await atomicWrite(this.logPath, lines.join("\n"));
    });
  }

  async append(entry: ProcessedEntry, options?: { skipLock?: boolean }): Promise<void> {
    await this.appendBatch([entry], options);
  }

  async appendBatch(entries: ProcessedEntry[], options?: { skipLock?: boolean }): Promise<void> {
    if (entries.length === 0) return;

    const lines: string[] = [];

    for (const entry of entries) {
      const normalizedSessionPath = normalizeSessionPathForLog(entry.sessionPath);
      if (!normalizedSessionPath) continue;

      const normalizedEntry: ProcessedEntry = { ...entry, sessionPath: normalizedSessionPath };
      this.entries.set(normalizedSessionPath, normalizedEntry);
      lines.push(JSON.stringify(normalizedEntry));
    }

    if (lines.length === 0) return;

    await ensureDir(path.dirname(this.logPath));

    const doAppend = async () => {
      // Check if file exists to add header if needed
      const exists = await fileExists(this.logPath);
      if (!exists) {
        const header = '# JSONL format: {"sessionPath":..., "processedAt":...}\n';
        await fs.writeFile(this.logPath, header + lines.join("\n") + "\n", "utf-8");
      } else {
        await fs.appendFile(this.logPath, lines.join("\n") + "\n", "utf-8");
      }
    };

    // Skip lock if caller already holds it (e.g., orchestrator)
    if (options?.skipLock) {
      await doAppend();
    } else {
      // Use withLock to safely append to the log
      await withLock(this.logPath, doAppend);
    }
  }

  /**
   * True when the session has been reflected (or deliberately skipped). A
   * session whose last attempt failed is NOT processed; see `get()` for its
   * retry state.
   */
  has(sessionPath: string): boolean {
    const normalized = normalizeSessionPathForLog(sessionPath);
    if (!normalized) return false;
    const entry = this.entries.get(normalized);
    return entry !== undefined && entry.status !== "failed";
  }

  get(sessionPath: string): ProcessedEntry | undefined {
    const normalized = normalizeSessionPathForLog(sessionPath);
    if (!normalized) return undefined;
    return this.entries.get(normalized);
  }

  add(entry: ProcessedEntry): void {
    const normalized = normalizeSessionPathForLog(entry.sessionPath);
    if (!normalized) return;
    this.entries.set(normalized, { ...entry, sessionPath: normalized });
  }

  /** Paths of processed sessions (failed attempts excluded). */
  getProcessedPaths(): Set<string> {
    const paths = new Set<string>();
    for (const [p, entry] of this.entries) {
      if (entry.status !== "failed") paths.add(p);
    }
    return paths;
  }
}

function pickIncrementalFields(raw: Record<string, unknown>): Partial<ProcessedEntry> {
  const out: Partial<ProcessedEntry> = {};
  const nonNegInt = (v: unknown): v is number =>
    typeof v === "number" && Number.isInteger(v) && v >= 0;
  const nonNeg = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
  const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;
  if (nonNegInt(raw.recordCount)) out.recordCount = raw.recordCount;
  if (str(raw.lastRecordHash)) out.lastRecordHash = raw.lastRecordHash;
  if (nonNeg(raw.messageCount)) out.messageCount = raw.messageCount;
  if (str(raw.endedAt)) out.endedAt = raw.endedAt;
  if (nonNeg(raw.sizeBytes)) out.sizeBytes = raw.sizeBytes;
  if (raw.status === "processed" || raw.status === "failed") out.status = raw.status;
  if (nonNegInt(raw.failures)) out.failures = raw.failures;
  if (str(raw.lastFailureAt)) out.lastFailureAt = raw.lastFailureAt;
  if (str(raw.lastError)) out.lastError = raw.lastError;
  return out;
}

// -----------------------------------------------------------------------------
// Session eligibility for reflection (#85)
// -----------------------------------------------------------------------------

/** What discovery observed about a session right now. */
export interface ObservedSessionState {
  messageCount?: number;
  endedAt?: string;
  sizeBytes?: number;
}

export interface SessionRetryPolicy {
  maxFailures: number;
  cooldownMs: number;
}

/** Longest a repeatedly failing session is ever parked. */
export const MAX_SESSION_RETRY_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * - "new": never attempted.
 * - "grown": reflected before, has a watermark, and has grown since.
 * - "retry": the last attempt failed and the retry policy allows another.
 * - "skip": processed and unchanged, has no watermark to resume from, or is
 *   cooling down after repeated failures.
 */
export type SessionEligibility = "new" | "grown" | "retry" | "skip";

/** True when any growth signal increased since the entry was written. */
export function sessionHasGrown(entry: ProcessedEntry, observed: ObservedSessionState): boolean {
  if (
    typeof observed.messageCount === "number" &&
    typeof entry.messageCount === "number" &&
    observed.messageCount > entry.messageCount
  ) {
    return true;
  }
  if (observed.endedAt && entry.endedAt) {
    const now = Date.parse(observed.endedAt);
    const then = Date.parse(entry.endedAt);
    if (!Number.isNaN(now) && !Number.isNaN(then) && now > then) return true;
  }
  if (
    typeof observed.sizeBytes === "number" &&
    typeof entry.sizeBytes === "number" &&
    observed.sizeBytes > entry.sizeBytes
  ) {
    return true;
  }
  return false;
}

/**
 * When may a failed session be retried? Immediately while it has failed fewer
 * than `maxFailures` times; after that only once `cooldownMs` has passed since
 * the last failure, doubling per further failure (capped at 30 days).
 */
export function nextRetryAtMs(entry: ProcessedEntry, policy: SessionRetryPolicy): number {
  const failures = entry.failures ?? 1;
  if (failures < policy.maxFailures) return 0;
  const last = entry.lastFailureAt ? Date.parse(entry.lastFailureAt) : Number.NaN;
  if (Number.isNaN(last)) return 0;
  const exponent = Math.min(failures - policy.maxFailures, 20);
  const cooldown = Math.min(policy.cooldownMs * 2 ** exponent, MAX_SESSION_RETRY_COOLDOWN_MS);
  return last + cooldown;
}

export function classifySessionForReflection(
  entry: ProcessedEntry | undefined,
  observed: ObservedSessionState,
  policy: SessionRetryPolicy,
  nowMs: number = Date.now(),
): SessionEligibility {
  if (!entry) return "new";
  if (entry.status === "failed") {
    return nowMs >= nextRetryAtMs(entry, policy) ? "retry" : "skip";
  }
  // No watermark: re-reflecting would re-count every earlier turn.
  if (entry.recordCount === undefined) return "skip";
  return sessionHasGrown(entry, observed) ? "grown" : "skip";
}
