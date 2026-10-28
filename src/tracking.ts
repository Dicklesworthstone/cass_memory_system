import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { assertInputLimits, assertTextSize, formatValidationIssues, InputLimitError, PLAYBOOK_INPUT_LIMITS } from "./input-limits.js";
import { sanitize } from "./sanitize.js";
import { OutcomeRecordSchema, ProcessedEntrySchema, type ProcessedEntry } from "./types.js";
import {
  atomicWrite,
  ensureDir,
  ensureDurableDirectory,
  expandPath,
  fileExists,
  now,
  resolveGlobalDir,
  syncDirectory,
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

class PendingOutcomeRecoveryError extends Error {}
class ReflectionCommitRecoveryError extends Error {}

const ReflectionCommitEnvelopeSchema = z.object({
  reflectionCommit: z.object({
    owner: z.string().trim().min(1),
    id: z.string().min(1),
  }).strict(),
  entries: z.array(ProcessedEntrySchema.extend({
    sessionPath: z.string().trim().min(1),
    processedAt: z.string().min(1),
  })).max(PLAYBOOK_INPUT_LIMITS.maxArrayLength),
}).strict();

function normalizeCommitOwner(owner: string): string {
  if (typeof owner !== "string" || !owner.trim()) {
    throw new ReflectionCommitRecoveryError("A reflection commit requires a non-empty playbook owner");
  }
  // Preserve the logical file address. Atomic replacement may replace a final
  // symlink, so realpath would change this identity between commit and replay.
  return path.resolve(expandPath(owner.trim()));
}

function parseReflectionCommit(value: unknown, source: string) {
  assertInputLimits(value, PLAYBOOK_INPUT_LIMITS, source);
  const parsed = ReflectionCommitEnvelopeSchema.safeParse(value);
  if (!parsed.success) {
    throw new ReflectionCommitRecoveryError(
      `Processed log contains an invalid reflection commit: ${formatValidationIssues(parsed.error)}`,
    );
  }
  return {
    reflectionCommit: {
      owner: normalizeCommitOwner(parsed.data.reflectionCommit.owner),
      id: parsed.data.reflectionCommit.id,
    },
    entries: parsed.data.entries.map(entry => ({
      ...entry, sessionPath: normalizeSessionPathForLog(entry.sessionPath),
    })),
  };
}

function serializeProcessedRecord(value: unknown, source: string): string {
  const line = JSON.stringify(value);
  assertTextSize(line, PLAYBOOK_INPUT_LIMITS.maxBytes, source);
  return line;
}

function mergePendingOutcomes(
  existing: ProcessedEntry["pendingOutcomes"],
  additions: ProcessedEntry["pendingOutcomes"],
): ProcessedEntry["pendingOutcomes"] {
  if (existing === undefined && additions === undefined) return undefined;
  const pending = new Map<string, NonNullable<ProcessedEntry["pendingOutcomes"]>[number]>();
  for (const record of [...(existing ?? []), ...(additions ?? [])]) {
    const key = record.id ?? JSON.stringify([record.path, record.sessionId, record.recordedAt]);
    if (!pending.has(key)) pending.set(key, record);
  }
  return [...pending.values()];
}

export class ProcessedLog {
  private entries: Map<string, ProcessedEntry> = new Map();
  private committedBatches: Map<string, string> = new Map();
  private localUpdates: Map<string, ProcessedEntry> = new Map();
  private logPath: string;

  constructor(logPath: string) {
    this.logPath = logPath;
  }

  async load(): Promise<void> {
    try {
      const content = await fs.readFile(this.logPath, "utf-8");
      const lines = content.split("\n").filter((line) => line.trim() && !line.startsWith("#"));
      const entries = new Map<string, ProcessedEntry>();
      const committedBatches = new Map<string, string>();

      for (const line of lines) {
        // Try JSONL first (new format)
        if (line.trim().startsWith("{")) {
          try {
            // A ledger may contain many batches, but one record is bounded
            // before parsing just like ordinary persisted playbook input.
            assertTextSize(line, PLAYBOOK_INPUT_LIMITS.maxBytes, this.logPath);
            const entry = JSON.parse(line);
            if (entry && typeof entry === "object" && Object.hasOwn(entry, "reflectionCommit")) {
              // Validate the entire batch before applying any watermark or
              // ACK. A torn JSON line is ignored below and can be replayed.
              const batch = parseReflectionCommit(entry, this.logPath);
              const { owner, id } = batch.reflectionCommit;
              if (committedBatches.get(owner) !== id) {
                for (const update of batch.entries) entries.set(update.sessionPath, update);
                committedBatches.set(owner, id);
              }
              continue;
            }
            if (entry && typeof entry === "object" && entry.pendingOutcomes !== undefined
              && (typeof entry.sessionPath !== "string" || !entry.sessionPath.trim())) {
              throw new PendingOutcomeRecoveryError("Processed log contains pending outcomes without a valid session path; repair the recovery records before reflecting");
            }
            if (entry.sessionPath) {
              const normalizedSessionPath = normalizeSessionPathForLog(entry.sessionPath);
              if (!normalizedSessionPath) continue;
              entries.set(normalizedSessionPath, {
                ...pickIncrementalFields(entry),
                sessionPath: normalizedSessionPath,
                processedAt: entry.processedAt || new Date().toISOString(),
                diaryId: entry.diaryId || entry.id, // Handle both keys for compatibility
                deltasGenerated:
                  typeof entry.deltasGenerated === "number" ? entry.deltasGenerated : 0,
              });
            }
            continue;
          } catch (error) {
            if (error instanceof PendingOutcomeRecoveryError || error instanceof ReflectionCommitRecoveryError ||
                error instanceof InputLimitError) throw error;
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
            entries.set(normalizedSessionPath, {
              sessionPath: normalizedSessionPath,
              processedAt: processedAt || new Date().toISOString(),
              diaryId: id === "-" ? undefined : id,
              deltasGenerated: parseInt(deltasProposed || "0", 10),
            });
          }
        } catch {}
      }
      this.entries = entries;
      this.committedBatches = committedBatches;
      this.localUpdates.clear();
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        this.entries.clear();
        this.committedBatches.clear();
        this.localUpdates.clear();
        return;
      }
      // Treating an unreadable log as empty could repeat reflection and lose
      // its pending outcomes. Only a genuinely absent log starts empty.
      throw error;
    }
  }

  async save(): Promise<void> {
    await withLock(this.logPath, async () => {
      const current = new ProcessedLog(this.logPath);
      await current.load();
      // Compaction must retain newer writers' watermarks as well as the ACKs
      // proving them committed. Only explicit add() calls are local updates.
      const entries = new Map(current.entries);
      for (const entry of this.localUpdates.values()) {
        entries.set(entry.sessionPath, {
          ...entry,
          pendingOutcomes: mergePendingOutcomes(entries.get(entry.sessionPath)?.pendingOutcomes, entry.pendingOutcomes),
        });
      }
      const lines = ['# JSONL format: {"sessionPath":..., "processedAt":...}'];
      for (const entry of entries.values()) lines.push(serializeProcessedRecord(entry, this.logPath));
      for (const [owner, id] of current.committedBatches) {
        lines.push(serializeProcessedRecord({ reflectionCommit: { owner, id }, entries: [] }, this.logPath));
      }
      await atomicWrite(this.logPath, lines.join("\n") + "\n");
      this.entries = entries;
      this.committedBatches = current.committedBatches;
      this.localUpdates.clear();
    });
  }

  /** Visible ACK state; appendCommittedBatch also flushes it before cleanup. */
  hasCommittedBatch(owner: string, id: string): boolean {
    return this.committedBatches.get(normalizeCommitOwner(owner)) === id;
  }

  /**
   * Publish one reflection's entries and ACK as one bounded JSONL record.
   * Replaying an ACK never overwrites newer watermarks or requeues outcomes.
   * The coordinator allows only one outstanding commit per playbook owner.
   */
  async appendCommittedBatch(
    owner: string,
    id: string,
    entries: ProcessedEntry[],
  ): Promise<{ alreadyCommitted: boolean }> {
    const batch = parseReflectionCommit({ reflectionCommit: { owner, id }, entries }, this.logPath);
    // Check the full encoding before creating a lock or touching the ledger.
    serializeProcessedRecord(batch, this.logPath);
    await ensureDurableDirectory(path.dirname(this.logPath));
    return withLock(this.logPath, async () => {
      const current = new ProcessedLog(this.logPath);
      await current.load();
      if (current.hasCommittedBatch(batch.reflectionCommit.owner, id)) {
        // An earlier write may have reached the page cache but failed fsync.
        // Do not let receipt cleanup turn that visible ACK into false success.
        const handle = await fs.open(this.logPath, "a+", 0o600);
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
        await syncDirectory(path.dirname(this.logPath));
        this.entries = current.entries;
        this.committedBatches = current.committedBatches;
        this.localUpdates.clear();
        return { alreadyCommitted: true };
      }
      batch.entries = batch.entries.map(entry => {
        const update = {
          ...entry,
          pendingOutcomes: mergePendingOutcomes(current.get(entry.sessionPath)?.pendingOutcomes, entry.pendingOutcomes),
        };
        current.add(update);
        return update;
      });
      // Merging a prior queue can increase the batch: enforce limits again
      // before the first write, not only on the caller's original proposal.
      assertInputLimits(batch, PLAYBOOK_INPUT_LIMITS, this.logPath);
      await this.writeRecords([serializeProcessedRecord(batch, this.logPath)]);
      current.committedBatches.set(batch.reflectionCommit.owner, id);
      this.entries = current.entries;
      this.committedBatches = current.committedBatches;
      this.localUpdates.clear();
      return { alreadyCommitted: false };
    });
  }

  async append(entry: ProcessedEntry, options?: { skipLock?: boolean }): Promise<void> {
    await this.appendBatch([entry], options);
  }

  async appendBatch(entries: ProcessedEntry[], options?: { skipLock?: boolean }): Promise<void> {
    if (entries.length === 0) return;

    const normalizedEntries: ProcessedEntry[] = [];

    for (const entry of entries) {
      const normalizedSessionPath = normalizeSessionPathForLog(entry.sessionPath);
      if (!normalizedSessionPath) continue;

      const normalizedEntry: ProcessedEntry = { ...entry, sessionPath: normalizedSessionPath };
      normalizedEntries.push(normalizedEntry);
    }

    if (normalizedEntries.length === 0) return;
    await ensureDurableDirectory(path.dirname(this.logPath));

    const doAppend = async () => {
      // A manual marker or stale writer must not erase another invocation's
      // recovery queue. Only acknowledgeOutcomes can remove pending records.
      const current = new ProcessedLog(this.logPath);
      await current.load();
      const merged = normalizedEntries.map((entry) => {
        const update = {
          ...entry,
          pendingOutcomes: mergePendingOutcomes(current.get(entry.sessionPath)?.pendingOutcomes, entry.pendingOutcomes),
        };
        current.add(update);
        return update;
      });
      await this.writeEntries(merged);
      this.entries = current.entries;
      this.committedBatches = current.committedBatches;
      this.localUpdates.clear();
    };

    // Skip lock if caller already holds it (e.g., orchestrator)
    if (options?.skipLock) {
      await doAppend();
    } else {
      // Use withLock to safely append to the log
      await withLock(this.logPath, doAppend);
    }
  }

  /** Remove only completed outcome IDs from the latest durable session state. */
  async acknowledgeOutcomes(
    acknowledgements: Array<{ sessionPath: string; outcomeIds: string[] }>,
  ): Promise<void> {
    if (acknowledgements.length === 0) return;
    await withLock(this.logPath, async () => {
      const current = new ProcessedLog(this.logPath);
      await current.load();
      const updates: ProcessedEntry[] = [];
      for (const acknowledgement of acknowledgements) {
        const entry = current.get(acknowledgement.sessionPath);
        if (!entry?.pendingOutcomes?.length) continue;
        const completed = new Set(acknowledgement.outcomeIds);
        const pendingOutcomes = entry.pendingOutcomes.filter((record) => !record.id || !completed.has(record.id));
        if (pendingOutcomes.length === entry.pendingOutcomes.length) continue;
        const update = { ...entry, pendingOutcomes };
        updates.push(update);
        current.add(update);
      }
      await this.writeEntries(updates);
      this.entries = current.entries;
      this.committedBatches = current.committedBatches;
      this.localUpdates.clear();
    });
  }

  /** Called only while the processed-log lock is held. */
  private async writeEntries(entries: ProcessedEntry[]): Promise<void> {
    if (entries.length === 0) return;
    await this.writeRecords(entries.map(entry => serializeProcessedRecord(entry, this.logPath)));
    // Failed writes must not acknowledge pending work in memory.
    for (const entry of entries) this.entries.set(entry.sessionPath, entry);
  }

  /** The caller holds the processed-log lock and has bounded every record. */
  private async writeRecords(records: string[]): Promise<void> {
    if (records.length === 0) return;
    const handle = await fs.open(this.logPath, "a+", 0o600);
    try {
      const { size } = await handle.stat();
      let prefix = '# JSONL format: {"sessionPath":..., "processedAt":...}\n';
      if (size > 0) {
        const tail = Buffer.alloc(1);
        await handle.read(tail, 0, 1, size - 1);
        // A legacy save or interrupted append must not swallow the next
        // complete entry, including its pending outcome recovery records.
        prefix = tail[0] === 10 ? "" : "\n";
      }
      await handle.writeFile(prefix + records.join("\n") + "\n", "utf-8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    // Also flush the directory when the first append created the ledger.
    // Flushing on every append makes recovery from an earlier failed flush
    // safe without relying on an in-memory "created" flag.
    await syncDirectory(path.dirname(this.logPath));
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

  /** Pending outcome work is independent of session discovery and growth. */
  getPendingOutcomeEntries(): ProcessedEntry[] {
    return [...this.entries.values()]
      .filter((entry) => (entry.pendingOutcomes?.length ?? 0) > 0)
      .map((entry) => ({ ...entry, pendingOutcomes: [...entry.pendingOutcomes!] }));
  }

  add(entry: ProcessedEntry): void {
    const normalized = normalizeSessionPathForLog(entry.sessionPath);
    if (!normalized) return;
    const update = { ...entry, sessionPath: normalized };
    this.entries.set(normalized, update);
    this.localUpdates.set(normalized, update);
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
  if (raw.pendingOutcomes !== undefined) {
    const pending = OutcomeRecordSchema.array().safeParse(raw.pendingOutcomes);
    if (!pending.success) {
      // Silently discarding a malformed recovery record would make a
      // processed session permanently lose its outcome again.
      throw new PendingOutcomeRecoveryError("Processed log contains invalid pending outcomes; repair the recovery records before reflecting");
    }
    out.pendingOutcomes = pending.data;
  }
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
