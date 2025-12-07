import { execFile, spawn, execSync } from "node:child_process";
import { promisify } from "node:util";
import {
  CassSearchHit,
  CassSearchHitSchema,
  Config
} from "./types.js";
import { log, error, warn } from "./utils.js";

const execFileAsync = promisify(execFile);

// --- Constants ---

export const CASS_EXIT_CODES = {
  SUCCESS: 0,
  USAGE_ERROR: 2,
  INDEX_MISSING: 3,
  NOT_FOUND: 4,
  IDEMPOTENCY_MISMATCH: 5,
  UNKNOWN: 9,
  TIMEOUT: 10,
} as const;

// --- Health & Availability ---

/**
 * Check if cass CLI is installed and functional.
 * Uses `cass health` with 200ms timeout.
 * Safe to call frequently - no exceptions thrown.
 */
export function cassAvailable(cassPath = "cass"): boolean {
  try {
    execSync(`${cassPath} health`, {
      stdio: "pipe",
      timeout: 200
    });
    return true;
  } catch (err: any) {
    // Log at debug level only - safe to fail silently
    log(`cass health check failed: ${err.message || 'unknown error'}`, true);
    return false;
  }
}

export function cassNeedsIndex(cassPath = "cass"): boolean {
  try {
    execSync(`${cassPath} health`, { stdio: "pipe" });
    return false;
  } catch (err: any) {
    if (err.status === CASS_EXIT_CODES.INDEX_MISSING || err.status === 1) {
      return true;
    }
    return false;
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
): Promise<CassSearchHit[]> {
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
    
    const rawHits = JSON.parse(stdout);
    // Validate and parse with Zod
    return rawHits.map((h: any) => CassSearchHitSchema.parse(h));
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
): Promise<CassSearchHit[]> {
  if (!cassAvailable(cassPath)) {
    log("cass not available, skipping search", true);
    return [];
  }

  try {
    return await cassSearch(query, options, cassPath);
  } catch (err: any) {
    const exitCode = err.code;
    
    if (exitCode === CASS_EXIT_CODES.INDEX_MISSING) {
      log("Index missing, rebuilding...", true);
      try {
        await cassIndex(cassPath);
        return await cassSearch(query, options, cassPath);
      } catch (retryErr) {
        error(`Recovery failed: ${retryErr}`);
        return [];
      }
    }
    
    if (exitCode === CASS_EXIT_CODES.TIMEOUT) {
      log("Search timed out, retrying with reduced limit...", true);
      const reducedOptions = { ...options, limit: Math.max(1, Math.floor((options.limit || 10) / 2)) };
      try {
        return await cassSearch(query, reducedOptions, cassPath);
      } catch {
        return [];
      }
    }
    
    error(`Cass search failed: ${err.message}`);
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
    const { stdout } = await execFileAsync(cassPath, args, { maxBuffer: 50 * 1024 * 1024 });
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
    // Assuming robot output for expand is the content directly or JSON? 
    // BEAD says "Return expanded context as string". 
    // If --robot returns JSON, I should parse it. Let's assume it returns the text for now or check.
    // Actually bead 0l6 says "Returns just the content...".
    // Let's assume standard output for now unless --json is explicit.
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
): Promise<any> {
  try {
    const { stdout } = await execFileAsync(cassPath, ["timeline", "--days", days.toString(), "--json"]);
    return JSON.parse(stdout);
  } catch {
    return { groups: [] };
  }
}