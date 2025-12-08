import { execFile, spawn, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { CassHit, CassHitSchema, CassTimelineGroup, CassTimelineResult } from "./types.js";
import { log, error } from "./utils.js";

const execFileAsync = promisify(execFile);

// --- Constants ---

// Numeric constants (kept for legacy callers)
export const CASS_EXIT_CODES = {
  SUCCESS: 0,
  USAGE_ERROR: 2,
  INDEX_MISSING: 3,
  NOT_FOUND: 4,
  IDEMPOTENCY_MISMATCH: 5,
  UNKNOWN: 9,
  TIMEOUT: 10,
} as const;

// Structured mapping for recovery logic
export const CASS_EXIT_CODE_MAP: Record<
  number,
  { name: string; retryable: boolean; action?: "rebuild_index" | "reduce_limit" }
> = {
  0: { name: "success", retryable: false },
  2: { name: "usage_error", retryable: false },
  3: { name: "index_missing", retryable: true, action: "rebuild_index" },
  4: { name: "not_found", retryable: false },
  5: { name: "idempotency_mismatch", retryable: false },
  9: { name: "unknown", retryable: false },
  10: { name: "timeout", retryable: true, action: "reduce_limit" },
};

function getExitInfo(code: number | undefined) {
  return (code !== undefined && CASS_EXIT_CODE_MAP[code]) || CASS_EXIT_CODE_MAP[CASS_EXIT_CODES.UNKNOWN];
}

// --- Health & Availability ---

export function cassAvailable(cassPath = "cass"): boolean {
  try {
    const result = spawnSync(cassPath, ["health"], { stdio: "ignore", timeout: 200 });
    return result.status === 0;
  } catch {
    return false;
  }
}

export function cassNeedsIndex(cassPath = "cass"): boolean {
  try {
    const result = spawnSync(cassPath, ["health"], { stdio: "pipe", timeout: 2000 });

    if (result.status === 0) return false;
    if (result.status === CASS_EXIT_CODES.INDEX_MISSING || result.status === 1) return true;
    return true; // treat other non-zero codes as needing recovery
  } catch {
    return true;
  }
}

// --- Indexing ---

export async function cassIndex(
  cassPath = "cass", 
  options: { full?: boolean; incremental?: boolean } = {}
): Promise<void> {
  const args = ["index"];
  if (options.full) args.push("--full");
  // incremental is default usually, but explicit flag might exist
  if (options.incremental) args.push("--incremental");

  return new Promise((resolve, reject) => {
    const proc = spawn(cassPath, args, { stdio: "inherit" });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`cass index failed with code ${code}`));
    });
    proc.on("error", (err) => reject(err));
  });
}

// --- Search ---

export interface CassSearchOptions {
  limit?: number;
  days?: number;
  agent?: string | string[];
  workspace?: string;
  fields?: string[];
  timeout?: number;
}

export async function cassSearch(
  query: string,
  options: CassSearchOptions = {},
  cassPath = "cass"
): Promise<CassHit[]> {
  const args = ["search", query, "--robot"]; // --robot for JSON output
  
  if (options.limit) args.push("--limit", options.limit.toString());
  if (options.days) args.push("--days", options.days.toString());
  
  if (options.agent) {
    const agents = Array.isArray(options.agent) ? options.agent : [options.agent];
    agents.forEach(a => args.push("--agent", a));
  }
  
  if (options.workspace) args.push("--workspace", options.workspace);
  if (options.fields) args.push("--fields", options.fields.join(","));

  try {
    const { stdout } = await execFileAsync(cassPath, args, { 
      maxBuffer: 50 * 1024 * 1024, // 50MB
      timeout: (options.timeout || 30) * 1000 
    });
    
    const rawResult = JSON.parse(stdout);
    // If it's an array (old version), map it. If object (new version), use .hits
    const hits = Array.isArray(rawResult) ? rawResult : rawResult.hits || [];
    
    return hits.map((h: any) => CassHitSchema.parse(h));
  } catch (err: any) {
    // If cass returns non-zero exit code, it might still output JSON error or empty
    if (err.code === CASS_EXIT_CODES.NOT_FOUND) return [];
    throw err;
  }
}

// --- Safe Wrapper ---

export async function safeCassSearch(
  query: string,
  options: CassSearchOptions = {},
  cassPath = "cass"
): Promise<CassHit[]> {
  if (!cassAvailable(cassPath)) {
    log("cass not available, skipping search", true);
    return [];
  }

  try {
    return await cassSearch(query, options, cassPath);
  } catch (err: any) {
    const exitCode = err.code;
    const info = getExitInfo(exitCode);
    
    if (info.action === "rebuild_index") {
      log("Index missing, rebuilding...", true);
      try {
        await cassIndex(cassPath);
        return await cassSearch(query, options, cassPath);
      } catch (retryErr) {
        error(`Recovery failed: ${retryErr}`);
        return [];
      }
    }
    
    if (info.action === "reduce_limit") {
      log("Search timed out, retrying with reduced limit...", true);
      const reducedOptions = { ...options, limit: Math.max(1, Math.floor((options.limit || 10) / 2)) };
      try {
        return await cassSearch(query, reducedOptions, cassPath);
      } catch {
        return [];
      }
    }
    
    error(`Cass search failed: ${info.name || "unknown"} (${err.message})`);
    return [];
  }
}

// --- Export ---

export async function cassExport(
  sessionPath: string,
  format: "markdown" | "json" | "text" = "markdown",
  cassPath = "cass"
): Promise<string | null> {
  const args = ["export", sessionPath, "--format", format];
  
  try {
    const { stdout } = await execFileAsync(cassPath, args, {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 30_000,
    });
    return stdout;
  } catch (err: any) {
    if (err.code === CASS_EXIT_CODES.NOT_FOUND) return null;
    error(`Export failed: ${err.message}`);
    return null;
  }
}

// --- Expand ---

export async function cassExpand(
  sessionPath: string,
  lineNumber: number,
  contextLines = 3,
  cassPath = "cass"
): Promise<string | null> {
  const args = ["expand", sessionPath, "-n", lineNumber.toString(), "-C", contextLines.toString(), "--robot"];
  
  try {
    const { stdout } = await execFileAsync(cassPath, args);
    return stdout;
  } catch (err: any) {
    return null;
  }
}

// --- Stats & Timeline ---

export async function cassStats(cassPath = "cass"): Promise<any | null> {
  try {
    const { stdout } = await execFileAsync(cassPath, ["stats", "--json"]);
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

export async function cassTimeline(
  days: number,
  cassPath = "cass"
): Promise<CassTimelineResult> {
  try {
    const { stdout } = await execFileAsync(cassPath, ["timeline", "--days", days.toString(), "--json"]);
    const parsed = JSON.parse(stdout);

    // Basic structural validation with defensive defaults
    const groups = Array.isArray(parsed?.groups) ? parsed.groups : [];
    const sanitizedGroups: CassTimelineGroup[] = groups.map((g: any) => ({
      date: typeof g?.date === "string" ? g.date : "",
      sessions: Array.isArray(g?.sessions)
        ? g.sessions.map((s: any) => ({
            path: typeof s?.path === "string" ? s.path : "",
            agent: typeof s?.agent === "string" ? s.agent : "",
            messageCount: typeof s?.messageCount === "number" ? s.messageCount : undefined,
            startTime: typeof s?.startTime === "string" ? s.startTime : undefined,
            endTime: typeof s?.endTime === "string" ? s.endTime : undefined,
          }))
        : [],
    }));

    return { groups: sanitizedGroups };
  } catch (err: any) {
    log(`cass timeline failed: ${err?.message ?? err}`, true);
    return { groups: [] };
  }
}

type ProcessedLogLike = { processedSessions: Set<string>; lastProcessedAt?: string };

function normalizeProcessed(
  processedOrLog: Set<string> | ProcessedLogLike
): { processed: Set<string>; lastProcessedAt?: string } {
  if (processedOrLog instanceof Set) {
    return { processed: processedOrLog, lastProcessedAt: undefined };
  }
  return {
    processed: processedOrLog.processedSessions ?? new Set<string>(),
    lastProcessedAt: processedOrLog.lastProcessedAt
  };
}

export async function findUnprocessedSessions(
  processedOrLog: Set<string> | ProcessedLogLike,
  options: { days?: number; maxSessions?: number; agent?: string; agents?: string[] } = {},
  cassPath = "cass"
): Promise<string[]> {
  const { processed } = normalizeProcessed(processedOrLog);
  const timeline = await cassTimeline(options.days || 7, cassPath);
  
  const allSessions = timeline.groups.flatMap((g: CassTimelineGroup) => 
    g.sessions.map((s) => ({ path: s.path, agent: s.agent }))
  );

  let unprocessed = allSessions.filter((s) => !processed.has(s.path));

  const agentsFilter = options.agents ?? (options.agent ? [options.agent] : undefined);
  if (agentsFilter && agentsFilter.length > 0) {
    const set = new Set(agentsFilter);
    unprocessed = unprocessed.filter((s) => s.agent && set.has(s.agent));
  }
  
  const limit = options.maxSessions ?? 20;
  return unprocessed.map((s) => s.path).slice(0, limit);
}
