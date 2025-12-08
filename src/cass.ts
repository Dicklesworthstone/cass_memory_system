import fs from "node:fs/promises";
import path from "node:path";
import { execFile, spawn, execSync } from "node:child_process";
import { promisify } from "node:util";
import {
  CassHit,
  CassHitSchema,
  CassTimelineGroup,
  CassTimelineResult,
  Config
} from "./types.js";
import { log, error } from "./utils.js";
import { sanitize } from "./security.js";
import { loadConfig, getSanitizeConfig } from "./config.js";

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

// --- Helpers ---

function sanitizeWithConfig(text: string, config: Config): string {
  const sanitizeConfig = getSanitizeConfig(config);
  return sanitize(text, sanitizeConfig);
}

function coerceContent(raw: any): string | null {
  if (!raw) return null;
  if (typeof raw === "string") return raw;

  if (Array.isArray(raw)) {
    const parts = raw
      .map((p) => coerceContent(p))
      .filter((v): v is string => Boolean(v));
    return parts.length ? parts.join("\n") : null;
  }

  if (typeof raw === "object") {
    if (typeof raw.text === "string") return raw.text;
    if (typeof raw.content === "string") return raw.content;
    if (typeof raw.message === "string") return raw.message;
  }

  return null;
}

function formatSessionEntry(entry: any): string | null {
  const content = coerceContent(entry?.content ?? entry?.text ?? entry?.message ?? entry);
  if (!content) return null;
  const speaker = entry?.role || entry?.type || entry?.agent;
  return speaker ? `[${speaker}] ${content}` : content;
}

function joinMessages(entries: any[]): string | null {
  const parts = entries
    .map((e) => formatSessionEntry(e))
    .filter((v): v is string => Boolean(v));
  return parts.length ? parts.join("\n") : null;
}

// --- Health & Availability ---

export function cassAvailable(cassPath = "cass"): boolean {
  try {
    execSync(`${cassPath} --version`, { stdio: "pipe" });
    return true;
  } catch {
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
  const args = ["search", query, "--robot"];

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
      maxBuffer: 50 * 1024 * 1024,
      timeout: (options.timeout || 30) * 1000
    });

    const rawHits = JSON.parse(stdout);
    // Validate and parse with Zod
    return rawHits.map((h: any) => CassHitSchema.parse(h));
  } catch (err: any) {
    if (err.code === CASS_EXIT_CODES.NOT_FOUND) return [];
    throw err;
  }
}

// --- Safe Wrapper ---

export async function safeCassSearch(
  query: string,
  options: CassSearchOptions = {},
  cassPath = "cass",
  config?: Config
): Promise<CassHit[]> {
  if (!cassAvailable(cassPath)) {
    log("cass not available, skipping search", true);
    return [];
  }

  const activeConfig = config || await loadConfig();
  const sanitizeConfig = getSanitizeConfig(activeConfig);

  try {
    const hits = await cassSearch(query, options, cassPath);

    return hits.map(hit => ({
      ...hit,
      snippet: sanitize(hit.snippet, sanitizeConfig)
    }));
  } catch (err: any) {
    const exitCode = err.code;

    if (exitCode === CASS_EXIT_CODES.INDEX_MISSING) {
      log("Index missing, rebuilding...", true);
      try {
        await cassIndex(cassPath);
        const hits = await cassSearch(query, options, cassPath);

        return hits.map(hit => ({
          ...hit,
          snippet: sanitize(hit.snippet, sanitizeConfig)
        }));
      } catch (retryErr) {
        error(`Recovery failed: ${retryErr}`);
        return [];
      }
    }

    if (exitCode === CASS_EXIT_CODES.TIMEOUT) {
      log("Search timed out, retrying with reduced limit...", true);
      const reducedOptions = { ...options, limit: Math.max(1, Math.floor((options.limit || 10) / 2)) };
      try {
        const hits = await cassSearch(query, reducedOptions, cassPath);

        return hits.map(hit => ({
          ...hit,
          snippet: sanitize(hit.snippet, sanitizeConfig)
        }));
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
  cassPath = "cass",
  config?: Config
): Promise<string | null> {
  const args = ["export", sessionPath, "--format", format];

  try {
    const { stdout } = await execFileAsync(cassPath, args, { maxBuffer: 50 * 1024 * 1024 });
    const activeConfig = config || await loadConfig();
    return sanitizeWithConfig(stdout, activeConfig);
  } catch (err: any) {
    const fallback = await handleSessionExportFailure(sessionPath, err, config);
    if (fallback !== null) return fallback;

    if (err.code === CASS_EXIT_CODES.NOT_FOUND) return null;
    error(`Export failed: ${err.message}`);
    return null;
  }
}

/**
 * Fallback parser when cass export fails. Attempts direct parsing of session
 * files (.jsonl, .json, .md) to salvage readable content.
 */
export async function handleSessionExportFailure(
  sessionPath: string,
  exportError: Error,
  config?: Config
): Promise<string | null> {
  log(`cass export failed for ${sessionPath}: ${exportError.message}. Attempting fallback parse...`, true);

  try {
    const fileContent = await fs.readFile(path.resolve(sessionPath), "utf-8");
    const ext = path.extname(sessionPath).toLowerCase();
    const activeConfig = config || await loadConfig();

    if (ext === ".jsonl") {
      const parsed = fileContent
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return line;
          }
        });
      const joined = joinMessages(parsed);
      return joined ? sanitizeWithConfig(joined, activeConfig) : null;
    }

    if (ext === ".json") {
      try {
        const parsed = JSON.parse(fileContent);
        const messages = Array.isArray(parsed)
          ? parsed
          : Array.isArray(parsed?.messages)
            ? parsed.messages
            : null;
        const joined = messages ? joinMessages(messages) : null;
        return joined ? sanitizeWithConfig(joined, activeConfig) : null;
      } catch (parseErr: any) {
        log(`Fallback JSON parse failed for ${sessionPath}: ${parseErr.message}`, true);
        return null;
      }
    }

    if (ext === ".md") {
      return sanitizeWithConfig(fileContent, activeConfig);
    }
  } catch (readErr: any) {
    log(`Fallback read failed for ${sessionPath}: ${readErr.message}`, true);
  }

  return null;
}

// --- Expand ---

export async function cassExpand(
  sessionPath: string,
  lineNumber: number,
  contextLines = 3,
  cassPath = "cass",
  config?: Config
): Promise<string | null> {
  const args = ["expand", sessionPath, "-n", lineNumber.toString(), "-C", contextLines.toString(), "--robot"];

  try {
    const { stdout } = await execFileAsync(cassPath, args);

    // Sanitize expanded output
    const activeConfig = config || await loadConfig();
    const sanitizeConfig = getSanitizeConfig(activeConfig);
    return sanitize(stdout, sanitizeConfig);
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
    return JSON.parse(stdout) as CassTimelineResult;
  } catch {
    return { groups: [] };
  }
}

export async function findUnprocessedSessions(
  processed: Set<string>,
  options: { days?: number; maxSessions?: number; agent?: string },
  cassPath = "cass"
): Promise<string[]> {
  const timeline = await cassTimeline(options.days || 7, cassPath);

  const allSessions = timeline.groups.flatMap((g) =>
    g.sessions.map((s) => ({ path: s.path, agent: s.agent }))
  );

  return allSessions
    .filter((s) => !processed.has(s.path))
    .filter((s) => !options.agent || s.agent === options.agent)
    .map((s) => s.path)
    .slice(0, options.maxSessions || 20);
}
