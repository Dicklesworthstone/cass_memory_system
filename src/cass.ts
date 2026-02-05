import fs from "node:fs/promises";
import path from "node:path";
import { execFile, spawn, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import {
  CassHit,
  CassHitSchema,
  CassTimelineGroup,
  CassTimelineResult,
  Config,
  RemoteCassHost
} from "./types.js";
import { log, warn, error, expandPath, validatePositiveInt } from "./utils.js";
import { sanitize, compileExtraPatterns } from "./sanitize.js";
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

export type CassFallbackMode = "none" | "playbook-only";

export interface CassRunner {
  execFile: (
    file: string,
    args: string[],
    options?: { maxBuffer?: number; timeout?: number }
  ) => Promise<{ stdout: string; stderr: string }>;
  spawnSync: (
    file: string,
    args: string[],
    options?: {
      stdio?: any;
      timeout?: number;
      encoding?: BufferEncoding | "buffer";
      maxBuffer?: number;
    }
  ) => {
    status: number | null;
    stdout?: string | Buffer;
    stderr?: string | Buffer;
    error?: any;
  };
  spawn: typeof spawn;
}

const DEFAULT_CASS_RUNNER: CassRunner = {
  execFile: async (file, args, options) => {
    const result = await execFileAsync(file, args, options);
    return {
      stdout: typeof (result as any)?.stdout === "string" ? (result as any).stdout : String((result as any)?.stdout ?? ""),
      stderr: typeof (result as any)?.stderr === "string" ? (result as any).stderr : String((result as any)?.stderr ?? ""),
    };
  },
  spawnSync: (file, args, options) => spawnSync(file, args, options as any) as any,
  spawn,
};

export interface CassAvailabilityResult {
  canContinue: boolean;
  fallbackMode: CassFallbackMode;
  message: string;
  resolvedCassPath?: string;
}

export type CassDegradedReason = "NOT_FOUND" | "INDEX_MISSING" | "FTS_TABLE_MISSING" | "TIMEOUT" | "OTHER";

export interface CassDegradedInfo {
  /** Whether cass-powered history is available for this operation. */
  available: boolean;
  reason: CassDegradedReason;
  message: string;
  suggestedFix?: string[];
}

export interface SafeCassSearchResult {
  hits: CassHit[];
  degraded?: CassDegradedInfo;
  resolvedCassPath?: string;
  /**
   * Optional per-host degraded info for SSH-based remote cass queries.
   * Present only when remote cass is enabled and one or more hosts fail.
   */
  remoteDegraded?: Array<CassDegradedInfo & { host: string }>;
}

// --- Helpers ---

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
    // Recurse into content if it's an array (e.g., Claude multi-block format)
    if (Array.isArray(raw.content)) return coerceContent(raw.content);
    if (typeof raw.content === "string") return raw.content;
    if (typeof raw.message === "string") return raw.message;
    // Codex CLI: content blocks have type: "input_text" or "output_text" with text field
    if (raw.type === "input_text" || raw.type === "output_text") {
      return typeof raw.text === "string" ? raw.text : null;
    }
  }

  return null;
}

function formatSessionEntry(entry: any): string | null {
  // Handle Codex CLI format: { type: "response_item", payload: { type: "message", role: "user", content: [...] } }
  if (entry?.type === "response_item" && entry?.payload) {
    const payload = entry.payload;
    if (payload?.type === "message" && payload?.role && payload?.content) {
      const content = coerceContent(payload.content);
      if (content) {
        return `[${payload.role}] ${content}`;
      }
    }
    // Other response_item types (function_call, etc.)
    return null;
  }

  // Handle session_meta entries (Codex CLI)
  if (entry?.type === "session_meta") {
    return null; // Skip metadata entries
  }

  // Standard format: { role: "user", content: "..." }
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

function parseCassJsonOutput(stdout: string): unknown {
  // 1) Happy path JSON.parse
  try {
    return JSON.parse(stdout);
  } catch (parseErr) {
    const tryParseJson = (text: string): unknown | null => {
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    };

    const looksLikeJsonStart = (text: string): boolean => {
      const t = text.trimStart();
      if (!t) return false;
      const first = t[0];
      if (first !== "[" && first !== "{") return false;

      // Skip common log prefixes like "[INFO]" / "[WARN]" where the next character is a letter.
      const next = t.slice(1).trimStart()[0];
      if (!next) return false;

      if (first === "[") {
        if (next === "{" || next === "[" || next === "]" || next === '"') return true;
        if (next === "-" || (next >= "0" && next <= "9")) return true;
        if (next === "t" || next === "f" || next === "n") return true;
        return false;
      }

      // "{...}" must start with a string key or be empty.
      return next === '"' || next === "}";
    };

    const extractJsonValue = (text: string, start: number): string | null => {
      const startChar = text[start];
      if (startChar !== "[" && startChar !== "{") return null;

      let depth = 0;
      let inString = false;
      let escaping = false;

      for (let i = start; i < text.length; i++) {
        const ch = text[i];

        if (inString) {
          if (escaping) {
            escaping = false;
            continue;
          }
          if (ch === "\\") {
            escaping = true;
            continue;
          }
          if (ch === '"') {
            inString = false;
            continue;
          }
          continue;
        }

        if (ch === '"') {
          inString = true;
          continue;
        }

        if (ch === "[" || ch === "{") {
          depth++;
          continue;
        }
        if (ch === "]" || ch === "}") {
          depth--;
          if (depth === 0) return text.slice(start, i + 1);
        }
      }

      return null;
    };

    const lines = stdout.split("\n");

    // 2) Leading logs then a JSON array/object (common case)
    const jsonStartLine = lines.findIndex((line) => looksLikeJsonStart(line));
    if (jsonStartLine !== -1) {
      const candidate = lines.slice(jsonStartLine).join("\n");
      const parsed = tryParseJson(candidate);
      if (parsed !== null) return parsed;
    }

    // 3) NDJSON / line-delimited objects/arrays (ignore non-JSON lines)
    const parsedLines: unknown[] = [];
    for (const line of lines) {
      if (!looksLikeJsonStart(line)) continue;
      const parsed = tryParseJson(line.trim());
      if (parsed === null) continue;
      if (Array.isArray(parsed)) parsedLines.push(...parsed);
      else parsedLines.push(parsed);
    }
    if (parsedLines.length > 0) return parsedLines;

    // 4) Inline prefixes like "[INFO] ... [{...}]" (extract first full JSON value)
    let attempts = 0;
    const maxAttempts = 50;
    for (let i = 0; i < stdout.length && attempts < maxAttempts; i++) {
      const ch = stdout[i];
      if (ch !== "[" && ch !== "{") continue;
      if (!looksLikeJsonStart(stdout.slice(i, i + 48))) continue;

      const extracted = extractJsonValue(stdout, i);
      if (!extracted) continue;

      const parsed = tryParseJson(extracted);
      attempts++;
      if (parsed !== null) return parsed;
    }

    throw parseErr;
  }
}

// --- Health & Availability ---

export function cassAvailable(
  cassPath = "cass",
  opts: { quiet?: boolean } = {},
  runner: CassRunner = DEFAULT_CASS_RUNNER
): boolean {
  const resolved = expandPath(cassPath);
  try {
    // Add timeout to prevent hanging if the binary is unresponsive.
    const result = runner.spawnSync(resolved, ["--version"], { stdio: "pipe", timeout: 2000 });

    if (result.error) {
      const code = (result.error as any)?.code;
      // Treat missing binary quietly when requested.
      if (!opts.quiet && code !== "ENOENT") {
        warn(`cassAvailable spawn error: ${String(result.error)}`);
      }
      return false;
    }
    if (result.status !== 0) {
      if (!opts.quiet) {
        warn(`cassAvailable non-zero status: ${result.status} ${result.stderr?.toString()?.trim() || ""}`.trim());
      }
      return false;
    }
    return true;
  } catch (e) {
    if (!opts.quiet) warn(`cassAvailable exception: ${String(e)}`);
    return false;
  }
}

/**
 * Gracefully handle cass being unavailable.
 * Tries configured and common paths; returns fallback guidance.
 */
export async function handleCassUnavailable(
  options: { cassPath?: string; searchCommonPaths?: boolean } = {},
  runner: CassRunner = DEFAULT_CASS_RUNNER
): Promise<CassAvailabilityResult> {
  const configuredPath = options.cassPath || process.env.CASS_PATH || "cass";
  const common = options.searchCommonPaths === false ? [] : [
    "/usr/local/bin/cass",
    "~/.cargo/bin/cass",
    "~/.local/bin/cass",
  ];

  const candidates = Array.from(new Set([configuredPath, ...common])).map(expandPath);

  for (const candidate of candidates) {
    if (cassAvailable(candidate, { quiet: true }, runner)) {
      const message = candidate === configuredPath
        ? `cass available at ${candidate}`
        : `cass found at ${candidate}. Set CASS_PATH=${candidate} or update config.cassPath.`;
      return {
        canContinue: true,
        fallbackMode: "none",
        message,
        resolvedCassPath: candidate,
      };
    }
  }

  const installMessage = [
    "cass binary not found. Falling back to playbook-only mode (history disabled).",
    "Install via `cargo install cass` or download a release binary:",
    "https://github.com/Dicklesworthstone/coding_agent_session_search",
    "Then set CASS_PATH or config.cassPath."
  ].join(" ");

  return {
    canContinue: true,
    fallbackMode: "playbook-only",
    message: installMessage,
  };
}

export function cassNeedsIndex(cassPath = "cass", runner: CassRunner = DEFAULT_CASS_RUNNER): boolean {
  const resolved = expandPath(cassPath);
  try {
    const result = runner.spawnSync(resolved, ["health"], { stdio: "pipe", timeout: 2000 });
    return result.status !== 0;
  } catch (err: any) {
    return true;
  }
}

// --- Indexing ---

export async function cassIndex(
  cassPath = "cass",
  options: { full?: boolean; incremental?: boolean } = {},
  runner: CassRunner = DEFAULT_CASS_RUNNER
): Promise<void> {
  const resolved = expandPath(cassPath);
  const args = ["index"];
  if (options.full) args.push("--full");
  if (options.incremental) args.push("--incremental");

  return new Promise((resolve, reject) => {
    const proc = runner.spawn(resolved, args, { stdio: "inherit" });
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
  /**
   * Attempt a search even when cass appears unavailable.
   * Useful for test stubs or degraded environments where cass availability checks are flaky.
   */
  force?: boolean;
}

export async function cassSearch(
  query: string,
  options: CassSearchOptions = {},
  cassPath = "cass",
  runner: CassRunner = DEFAULT_CASS_RUNNER
): Promise<CassHit[]> {
  const resolved = expandPath(cassPath);
  const args = buildCassSearchArgs(query, options);

  try {
    const { stdout } = await runner.execFile(resolved, args, {
      maxBuffer: 50 * 1024 * 1024,
      timeout: (options.timeout || 30) * 1000
    });

    const rawHits = parseCassJsonOutput(stdout);

    // Handle wrapper object from cass search --robot (returns { count, hits, ... })
    let hitsArray: unknown[];
    if (Array.isArray(rawHits)) {
      hitsArray = rawHits;
    } else if (rawHits && typeof rawHits === 'object' && Array.isArray((rawHits as any).hits)) {
      hitsArray = (rawHits as any).hits;
    } else {
      hitsArray = [rawHits];
    }

    // Validate and parse with Zod
    return hitsArray.map((h: any) => CassHitSchema.parse(h));

  } catch (err: any) {
    if (err.code === CASS_EXIT_CODES.NOT_FOUND) return [];
    if (err instanceof SyntaxError) {
        error(`Failed to parse cass output: ${err.message}`);
    }
    throw err;
  }
}

function shellEscapePosix(arg: string): string {
  // Safe single-quote escaping for POSIX shells: ' -> '"'"'
  return "'" + arg.replace(/'/g, "'\"'\"'") + "'";
}

function shellEscapeForUserCommand(arg: string): string {
  // These strings are meant to be copy/pasted by humans (not executed by the program).
  // Quote conservatively to avoid glob expansion and shell metacharacter surprises.
  if (process.platform === "win32") {
    // PowerShell single-quote escaping: ' -> ''
    return `'${arg.replace(/'/g, "''")}'`;
  }
  return shellEscapePosix(arg);
}

function buildCassSearchArgs(query: string, options: CassSearchOptions = {}): string[] {
  const args = ["search"];

  if (options.limit) args.push("--limit", options.limit.toString());
  if (options.days) args.push("--days", options.days.toString());

  if (options.agent) {
    const agents = Array.isArray(options.agent) ? options.agent : [options.agent];
    agents.forEach((a) => args.push("--agent", a));
  }

  if (options.workspace) args.push("--workspace", options.workspace);
  if (options.fields) args.push("--fields", options.fields.join(","));

  args.push("--robot");
  args.push("--");
  args.push(query);

  return args;
}

function coerceRemoteHostLabel(host: Config["remoteCass"]["hosts"][number]): string {
  const label = typeof host.label === "string" && host.label.trim() ? host.label.trim() : host.host.trim();
  return label || host.host;
}

async function sshCassSearch(
  host: Config["remoteCass"]["hosts"][number],
  query: string,
  options: CassSearchOptions,
  runner: CassRunner
): Promise<CassHit[]> {
  const sshTarget = typeof host.host === "string" ? host.host.trim() : "";
  if (!sshTarget) {
    throw new Error("Invalid remoteCass host: empty ssh target");
  }
  if (sshTarget.startsWith("-")) {
    throw new Error(`Invalid remoteCass host '${sshTarget}': ssh target must not start with '-'`);
  }
  if (/\s/.test(sshTarget)) {
    throw new Error(`Invalid remoteCass host '${sshTarget}': ssh target must not contain whitespace`);
  }
  if (/[^a-zA-Z0-9@._:%\-:\[\]]/.test(sshTarget)) {
    throw new Error(`Invalid remoteCass host '${sshTarget}': ssh target contains unsafe characters`);
  }

  const commandArgs = ["cass", ...buildCassSearchArgs(query, options)];
  const remoteCommand = commandArgs.map(shellEscapePosix).join(" ");
  const sshArgs = [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=5",
    sshTarget,
    remoteCommand,
  ];

  const timeoutSeconds = options.timeout || 15;
  const { stdout } = await runner.execFile("ssh", sshArgs, {
    maxBuffer: 50 * 1024 * 1024,
    timeout: timeoutSeconds * 1000,
  });

  const rawHits = parseCassJsonOutput(stdout);

  let hitsArray: unknown[];
  if (Array.isArray(rawHits)) {
    hitsArray = rawHits;
  } else if (rawHits && typeof rawHits === "object" && Array.isArray((rawHits as any).hits)) {
    hitsArray = (rawHits as any).hits;
  } else {
    hitsArray = rawHits ? [rawHits] : [];
  }

  const hostLabel = coerceRemoteHostLabel(host);
  return hitsArray.map((h: any) => ({ ...CassHitSchema.parse(h), origin: { kind: "remote", host: hostLabel } }));
}

// --- Safe Wrapper ---

function normalizeCassErrorMessage(err: unknown): string {
  if (!err) return "Unknown error";
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function classifyCassSearchError(err: any, query: string): CassDegradedInfo {
  const rawMessage = normalizeCassErrorMessage(err);
  const msg = rawMessage.split("\n")[0]?.trim() || rawMessage;
  const code = err?.code;
  const lower = `${msg}`.toLowerCase();

  if (code === CASS_EXIT_CODES.INDEX_MISSING || lower.includes("index missing") || lower.includes("needs index")) {
    return {
      available: false,
      reason: "INDEX_MISSING",
      message: "cass index is missing; history is disabled until indexed.",
      suggestedFix: ["cass index", "cass health"],
    };
  }

  if (
    code === CASS_EXIT_CODES.TIMEOUT ||
    code === "ETIMEDOUT" ||
    err?.killed === true ||
    lower.includes("timeout") ||
    lower.includes("timed out")
  ) {
    return {
      available: false,
      reason: "TIMEOUT",
      message: "cass search timed out; history may be incomplete.",
      suggestedFix: ["cass search \"<query>\" --robot --limit 5 --days 7", "cass health"],
    };
  }

  if (code === CASS_EXIT_CODES.NOT_FOUND || code === "ENOENT") {
    return {
      available: false,
      reason: "NOT_FOUND",
      message: "cass binary not found; falling back to playbook-only mode (history disabled).",
      suggestedFix: ["cargo install cass", "cass index"],
    };
  }

  // Handle FTS table errors (e.g., "no such table: fts_messages")
  if (lower.includes("no such table") && lower.includes("fts")) {
    return {
      available: false,
      reason: "FTS_TABLE_MISSING",
      message: "cass FTS table is missing; run 'cass doctor --fix' to recreate it.",
      suggestedFix: ["cass doctor --fix", "cass health"],
    };
  }

  return {
    available: false,
    reason: "OTHER",
    message: msg ? `cass search failed: ${msg}` : "cass search failed",
    suggestedFix: ["cass doctor --fix", "cm doctor", "cass health"],
  };
}

function classifyRemoteCassSearchFailure(
  err: unknown,
  sshTarget: string,
  label: string,
  query: string,
  options: CassSearchOptions
): CassDegradedInfo {
  const rawMessage = normalizeCassErrorMessage(err);
  const stderr = typeof (err as any)?.stderr === "string" ? (err as any).stderr : "";
  const msg = rawMessage.split("\n")[0]?.trim() || rawMessage;
  const lower = `${msg}\n${stderr}`.toLowerCase();
  const code = (err as any)?.code;
  const display = label && label !== sshTarget ? `${label} (${sshTarget})` : sshTarget;
  const quotedSshTarget = shellEscapeForUserCommand(sshTarget);

  if (lower.includes("invalid remotecass host")) {
    return {
      available: false,
      reason: "OTHER",
      message: `remote(${display}): invalid ssh target; check config.remoteCass.hosts.`,
      suggestedFix: ["Edit config.remoteCass.hosts to a valid ssh target (no whitespace, must not start with '-', only safe hostname/user characters)"],
    };
  }

  if (
    code === 255 ||
    lower.includes("could not resolve hostname") ||
    lower.includes("connection refused") ||
    lower.includes("no route to host") ||
    lower.includes("permission denied") ||
    lower.includes("connection timed out") ||
    lower.includes("operation timed out")
  ) {
    return {
      available: false,
      reason: "OTHER",
      message: `ssh to ${display} failed; remote history unavailable.`,
      suggestedFix: [`ssh ${quotedSshTarget} true`, `ssh ${quotedSshTarget} cass health`],
    };
  }

  if (
    code === 127 ||
    lower.includes("command not found") ||
    lower.includes("cass: not found") ||
    lower.includes("cass: command not found")
  ) {
    return {
      available: false,
      reason: "NOT_FOUND",
      message: `cass not found on ${display}; remote history disabled for this host.`,
      suggestedFix: [`ssh ${quotedSshTarget} cargo install cass`, `ssh ${quotedSshTarget} cass index --full`],
    };
  }

  const base = classifyCassSearchError(err as any, query);
  if (base.reason === "TIMEOUT") {
    return {
      available: false,
      reason: "TIMEOUT",
      message: `remote(${display}): ${base.message}`,
      suggestedFix: [
        `ssh ${quotedSshTarget} cass search "<query>" --robot --limit ${Math.max(1, Math.min(5, options.limit || 5))} --days ${Math.max(1, Math.min(30, options.days || 7))}`,
        `ssh ${quotedSshTarget} cass health`,
      ],
    };
  }

  if (base.reason === "INDEX_MISSING") {
    return {
      available: false,
      reason: "INDEX_MISSING",
      message: `remote(${display}): ${base.message}`,
      suggestedFix: [`ssh ${quotedSshTarget} cass index --full`, `ssh ${quotedSshTarget} cass health`],
    };
  }

  if (base.reason === "NOT_FOUND") {
    return {
      available: false,
      reason: "NOT_FOUND",
      message: `remote(${display}): ${base.message}`,
      suggestedFix: [`ssh ${quotedSshTarget} cargo install cass`, `ssh ${quotedSshTarget} cass index --full`],
    };
  }

  return {
    available: false,
    reason: "OTHER",
    message: `remote(${display}): ${base.message}`,
    suggestedFix: [`ssh ${quotedSshTarget} cass health`],
  };
}

export async function safeCassSearchWithDegraded(
  query: string,
  options: CassSearchOptions = {},
  cassPath = "cass",
  config?: Config,
  runner: CassRunner = DEFAULT_CASS_RUNNER
): Promise<SafeCassSearchResult> {
  if (!query || !query.trim()) {
    return { hits: [] };
  }

  const force = options.force || process.env.CM_FORCE_CASS_SEARCH === "1";
  const availability = await handleCassUnavailable({ cassPath }, runner);

  const activeConfig = config || await loadConfig();
  const sanitizeConfig = getSanitizeConfig(activeConfig);

  // Pre-compile patterns for performance (avoid recompilation per hit)
  const compiledConfig = {
    ...sanitizeConfig,
    extraPatterns: compileExtraPatterns(sanitizeConfig.extraPatterns)
  };

  // Helper to sanitize and tag hits with origin
  const processLocalHits = (hits: CassHit[]): CassHit[] =>
    hits.map(hit => ({
      ...hit,
      snippet: sanitize(hit.snippet, compiledConfig),
      origin: hit.origin || { kind: "local" as const }
    }));

  const processRemoteHits = (hits: CassHit[]): CassHit[] =>
    hits.map(hit => ({
      ...hit,
      snippet: sanitize(hit.snippet, compiledConfig)
      // origin already set by sshCassSearch
    }));

  // Start remote searches in parallel if enabled (don't wait for local availability check)
  const remoteSearchPromises: Array<Promise<{ host: string; label: string; hits: CassHit[]; error?: unknown }>> = [];
  const remoteEnabled = activeConfig.remoteCass?.enabled && activeConfig.remoteCass.hosts?.length > 0;
  const remoteSearchOptions: CassSearchOptions = {
    ...options,
    limit: Math.min(options.limit || 10, 5), // Cap remote results
    timeout: Math.min(options.timeout || 15, 15),
  };

  if (remoteEnabled) {
    for (const hostConfig of activeConfig.remoteCass.hosts) {
      const label = coerceRemoteHostLabel(hostConfig);
      remoteSearchPromises.push(
        sshCassSearch(hostConfig, query, remoteSearchOptions, runner)
          .then(hits => ({ host: hostConfig.host, label, hits, error: undefined }))
          .catch(err => ({ host: hostConfig.host, label, hits: [], error: err }))
      );
    }
  }

  // Handle local cass unavailable
  if (!force && availability.fallbackMode !== "none") {
    // Still try to get remote results even if local is unavailable
    const remoteResults = await Promise.all(remoteSearchPromises);
    const remoteHits = remoteResults.flatMap(r => processRemoteHits(r.hits));
    const remoteDegraded = remoteResults
      .filter((r) => r.error)
      .map((r) => ({
        host: r.host,
        ...classifyRemoteCassSearchFailure(r.error, r.host, r.label, query, remoteSearchOptions),
      }));

    return {
      hits: remoteHits,
      degraded: {
        available: false,
        reason: "NOT_FOUND",
        message: availability.message,
        suggestedFix: ["cargo install cass", "cass index"],
      },
      remoteDegraded: remoteDegraded.length > 0 ? remoteDegraded : undefined
    };
  }

  const expandedCassPath = expandPath(cassPath);
  const resolvedCassPath = availability.resolvedCassPath || expandedCassPath;
  const resolvedCassPathForOutput =
    availability.resolvedCassPath && availability.resolvedCassPath !== expandedCassPath
      ? availability.resolvedCassPath
      : undefined;

  try {
    // Run local search
    const localHits = await cassSearch(query, options, resolvedCassPath, runner);
    const processedLocalHits = processLocalHits(localHits);

    // Await remote results
    const remoteResults = await Promise.all(remoteSearchPromises);
    const remoteHits = remoteResults.flatMap(r => processRemoteHits(r.hits));
    const remoteDegraded = remoteResults
      .filter((r) => r.error)
      .map((r) => ({
        host: r.host,
        ...classifyRemoteCassSearchFailure(r.error, r.host, r.label, query, remoteSearchOptions),
      }));

    // Merge and sort by score (higher first), local hits preferred for equal scores
    const allHits = [...processedLocalHits, ...remoteHits].sort((a, b) => {
      const scoreDiff = (b.score || 0) - (a.score || 0);
      if (scoreDiff !== 0) return scoreDiff;
      // Prefer local hits when scores are equal
      return (a.origin?.kind === "local" ? 0 : 1) - (b.origin?.kind === "local" ? 0 : 1);
    });

    return {
      hits: allHits,
      resolvedCassPath: resolvedCassPathForOutput,
      remoteDegraded: remoteDegraded.length > 0 ? remoteDegraded : undefined
    };
  } catch (err: any) {
    const degraded = classifyCassSearchError(err, query);
    if (degraded.reason === "TIMEOUT") {
      degraded.suggestedFix = [
        `cass search "<query>" --robot --limit ${Math.max(1, Math.min(5, options.limit || 5))} --days ${Math.max(1, Math.min(30, options.days || 7))}`,
        "cass health",
      ];
    }

    // Still try to get remote results even if local fails
    const remoteResults = await Promise.all(remoteSearchPromises);
    const remoteHits = remoteResults.flatMap(r => processRemoteHits(r.hits));
    const remoteDegraded = remoteResults
      .filter((r) => r.error)
      .map((r) => ({
        host: r.host,
        ...classifyRemoteCassSearchFailure(r.error, r.host, r.label, query, remoteSearchOptions),
      }));

    // Best-effort fallback: if force flag set, attempt to parse whatever stdout we get.
    if (force) {
      try {
        const alt = runner.spawnSync(resolvedCassPath, ["search", query, "--robot"], {
          encoding: "utf-8",
          maxBuffer: 50 * 1024 * 1024,
          timeout: (options.timeout || 30) * 1000,
        });
        if (alt.error) throw alt.error;
        const rawStdout = alt.stdout ?? "";
        const text = typeof rawStdout === "string" ? rawStdout : rawStdout.toString("utf-8");
        if (text.trim()) {
          const parsed = parseCassJsonOutput(text);
          const hitsArr = Array.isArray(parsed) ? parsed : [parsed];
          const fallbackHits = hitsArr.map((hit: any) => ({
            ...CassHitSchema.parse(hit),
            snippet: sanitize(hit.snippet, compiledConfig),
            origin: { kind: "local" as const }
          }));
          return {
            hits: [...fallbackHits, ...remoteHits],
            degraded,
            resolvedCassPath: resolvedCassPathForOutput,
            remoteDegraded: remoteDegraded.length > 0 ? remoteDegraded : undefined
          };
        }
      } catch (fallbackErr: any) {
        // Keep degraded info; return empty hits.
        log(`cass search force fallback failed: ${fallbackErr?.message || String(fallbackErr)}`, true);
      }
    }

    return {
      hits: remoteHits,
      degraded,
      resolvedCassPath: resolvedCassPathForOutput,
      remoteDegraded: remoteDegraded.length > 0 ? remoteDegraded : undefined
    };
  }
}

export async function safeCassSearch(
  query: string,
  options: CassSearchOptions = {},
  cassPath = "cass",
  config?: Config,
  runner: CassRunner = DEFAULT_CASS_RUNNER
): Promise<CassHit[]> {
  const { hits } = await safeCassSearchWithDegraded(query, options, cassPath, config, runner);
  return hits;
}

// --- Export ---

export async function cassExport(
  sessionPath: string,
  format: "markdown" | "json" | "text" = "markdown",
  cassPath = "cass",
  config?: Config,
  runner: CassRunner = DEFAULT_CASS_RUNNER
): Promise<string | null> {
  const args = ["export", "--format", format, "--", sessionPath];
  const resolvedCassPath = expandPath(cassPath);

  try {
    const { stdout } = await runner.execFile(resolvedCassPath, args, { maxBuffer: 50 * 1024 * 1024 });

    // Detect if cass export returned mostly useless "=== UNKNOWN ===" content
    // This happens when cass doesn't understand the session format (e.g., Codex CLI)
    const unknownCount = (stdout.match(/=== UNKNOWN ===/g) || []).length;
    const totalLines = stdout.split("\n").filter((l) => l.trim()).length;
    const unknownRatio = totalLines > 0 ? unknownCount / totalLines : 0;

    // If more than 50% of lines are UNKNOWN, try direct parsing
    if (unknownRatio > 0.5 && unknownCount > 3) {
      log(`cass export returned ${unknownCount} UNKNOWN entries (${Math.round(unknownRatio * 100)}%). Trying direct parse...`, true);
      const fallback = await handleSessionExportFailure(
        sessionPath,
        new Error("cass export returned mostly UNKNOWN content"),
        config
      );
      if (fallback !== null && fallback.trim().length > 0) {
        return fallback;
      }
    }

    const activeConfig = config || await loadConfig();
    const sanitizeConfig = getSanitizeConfig(activeConfig);
    const compiledConfig = {
      ...sanitizeConfig,
      extraPatterns: compileExtraPatterns(sanitizeConfig.extraPatterns)
    };
    return sanitize(stdout, compiledConfig);
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
    const resolvedPath = expandPath(sessionPath);
    const stats = await fs.stat(resolvedPath);
    if (stats.size > 10 * 1024 * 1024) { // 10MB limit
      warn(`[cass] Session file too large for fallback parse (${(stats.size / 1024 / 1024).toFixed(2)}MB). Skipping.`);
      return null;
    }

    const fileContent = await fs.readFile(resolvedPath, "utf-8");
    const ext = path.extname(sessionPath).toLowerCase();
    const activeConfig = config || await loadConfig();
    const sanitizeConfig = getSanitizeConfig(activeConfig);
    const compiledConfig = {
      ...sanitizeConfig,
      extraPatterns: compileExtraPatterns(sanitizeConfig.extraPatterns)
    };

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
      return joined ? sanitize(joined, compiledConfig) : null;
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
        return joined ? sanitize(joined, compiledConfig) : null;
      } catch (parseErr: any) {
        log(`Fallback JSON parse failed for ${sessionPath}: ${parseErr.message}`, true);
        return null;
      }
    }

    if (ext === ".md") {
      return sanitize(fileContent, compiledConfig);
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
  config?: Config,
  runner: CassRunner = DEFAULT_CASS_RUNNER
): Promise<string | null> {
  const args = ["expand", "-n", lineNumber.toString(), "-C", contextLines.toString(), "--robot", "--", sessionPath];
  const resolvedCassPath = expandPath(cassPath);

  try {
    const { stdout } = await runner.execFile(resolvedCassPath, args);

    // Sanitize expanded output
    const activeConfig = config || await loadConfig();
    const sanitizeConfig = getSanitizeConfig(activeConfig);
    const compiledConfig = {
      ...sanitizeConfig,
      extraPatterns: compileExtraPatterns(sanitizeConfig.extraPatterns)
    };
    return sanitize(stdout, compiledConfig);
  } catch (err: any) {
    return null;
  }
}

// --- Stats & Timeline ---

export async function cassStats(
  cassPath = "cass",
  runner: CassRunner = DEFAULT_CASS_RUNNER
): Promise<any | null> {
  const resolvedCassPath = expandPath(cassPath);
  try {
    const { stdout } = await runner.execFile(resolvedCassPath, ["stats", "--json"]);
    const parsed = parseCassJsonOutput(stdout);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function cassTimeline(
  days: number,
  cassPath = "cass",
  runner: CassRunner = DEFAULT_CASS_RUNNER
): Promise<CassTimelineResult> {
  const resolvedCassPath = expandPath(cassPath);
  try {
    // cass timeline uses --since Nd format, not --days
    const { stdout } = await runner.execFile(resolvedCassPath, ["timeline", "--since", `${days}d`, "--json"]);
    const parsed = parseCassJsonOutput(stdout);

    // cass timeline returns { groups: {}, range: {...}, total_sessions: N }
    // where groups is an object keyed by date, not an array
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const result = parsed as any;
      // Transform object groups into array format expected by consumers
      if (result.groups && typeof result.groups === "object" && !Array.isArray(result.groups)) {
        const groupsArray: CassTimelineGroup[] = [];
        for (const [date, sessions] of Object.entries(result.groups)) {
          if (Array.isArray(sessions)) {
            groupsArray.push({
              date,
              sessions: sessions.map((s: any) => ({
                path: s.path || s.source_path || "",
                agent: s.agent || "unknown",
                messageCount: s.messageCount || s.message_count || 0,
                // Coerce to string in case created_at is a Unix timestamp number
                startTime: String(s.startTime || s.start_time || s.created_at || ""),
                endTime: String(s.endTime || s.end_time || ""),
              })),
            });
          }
        }
        return { groups: groupsArray };
      }
      // Already in expected format
      if (Array.isArray(result.groups)) {
        return result as CassTimelineResult;
      }
    }
    return { groups: [] };
  } catch {
    return { groups: [] };
  }
}

export async function findUnprocessedSessions(
  processed: Set<string>,
  options: {
    days?: number;
    maxSessions?: number;
    agent?: string;
    excludePatterns?: string[];
    includeAll?: boolean;
  },
  cassPath = "cass",
  runner: CassRunner = DEFAULT_CASS_RUNNER
): Promise<string[]> {
  const daysCheck = validatePositiveInt(options.days, "days", { min: 1, allowUndefined: true });
  const days = daysCheck.ok ? (daysCheck.value ?? 7) : 7;

  const maxSessionsCheck = validatePositiveInt(options.maxSessions, "maxSessions", {
    min: 1,
    allowUndefined: true,
  });
  const maxSessions = maxSessionsCheck.ok ? (maxSessionsCheck.value ?? 20) : 20;

  const agentFilter = typeof options.agent === "string" ? options.agent.trim().toLowerCase() : undefined;
  const agentNormalized = agentFilter ? agentFilter : undefined;

  // Session type exclusion filtering
  const excludePatterns = options.excludePatterns ?? [];
  const includeAll = options.includeAll ?? false;

  // Try timeline first
  const timeline = await cassTimeline(days, cassPath, runner);
  const groups = timeline.groups || [];

  let allSessions: Array<{ path: string; agent: string }> = [];

  if (Array.isArray(groups) && groups.length > 0) {
    // Use timeline groups if available
    allSessions = groups.flatMap((g) =>
      (g.sessions || []).map((s) => ({ path: s.path, agent: s.agent }))
    );
  } else {
    // Fallback: use broad search queries to discover recent sessions
    // This works around cass timeline returning empty groups
    const broadQueries = ["the", "and", "to", "is", "a", "for", "that", "in", "on", "with"];
    const seenPaths = new Set<string>();

    for (const query of broadQueries) {
      if (seenPaths.size >= maxSessions * 3) break; // Get enough candidates

      try {
        const hits = await cassSearch(query, { limit: 50, days }, cassPath, runner);
        for (const hit of hits) {
          if (!seenPaths.has(hit.source_path)) {
            seenPaths.add(hit.source_path);
            allSessions.push({ path: hit.source_path, agent: hit.agent });
          }
        }
      } catch {
        // Ignore search errors, try next query
      }
    }
  }

  // Helper to check if a session path matches any exclusion pattern
  const matchesExcludePattern = (sessionPath: string): boolean => {
    if (includeAll || excludePatterns.length === 0) return false;
    const pathLower = sessionPath.toLowerCase();
    return excludePatterns.some((pattern) => pathLower.includes(pattern.toLowerCase()));
  };

  return allSessions
    .filter((s) => !processed.has(s.path))
    .filter((s) => !agentNormalized || (s.agent || "").trim().toLowerCase() === agentNormalized)
    .filter((s) => !matchesExcludePattern(s.path))
    .map((s) => s.path)
    .slice(0, maxSessions);
}
