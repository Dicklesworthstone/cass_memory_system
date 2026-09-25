import fs from "node:fs/promises";
import path from "node:path";
import { type CassRunner, cassExport, cassExportRecords, cassSearch } from "./cass.js";
import { getSanitizeConfig } from "./config.js";
import { withLock } from "./lock.js";
import { compileExtraPatterns, sanitize } from "./sanitize.js";
import { type Config, type TraumaEntry, TraumaEntrySchema } from "./types.js";
import {
  atomicWrite,
  ensureDir,
  expandPath,
  fileExists,
  log,
  error as logError,
  resolveGlobalDir,
  resolveRepoDir,
  warn,
} from "./utils.js";

const GLOBAL_TRAUMA_FILE = "traumas.jsonl";
const REPO_TRAUMA_FILE = "traumas.jsonl";

/**
 * Known dangerous patterns that indicate a potential catastrophe.
 * Sourced from simultaneous_launch_button (Project Hot Stove).
 */
export const DOOM_PATTERNS = [
  // Filesystem Destruction
  {
    pattern: String.raw`^rm\s+(-[rf]+\s+)+/(etc|usr|var|boot|home|root|bin|sbin|lib)`,
    description: "Recursive deletion of system directories",
  },
  {
    pattern: String.raw`^rm\s+(-[rf]+\s+)+/[^t]`,
    description: "Recursive deletion of root subdirectories",
  },
  { pattern: String.raw`^rm\s+(-[rf]+\s+)+~`, description: "Recursive deletion of home directory" },
  { pattern: String.raw`^rm\s+(-[rf]+\s+)+`, description: "Recursive force deletion (high risk)" },

  // Database Destruction
  { pattern: String.raw`DROP\s+DATABASE`, description: "Drop database" },
  { pattern: String.raw`DROP\s+SCHEMA`, description: "Drop schema" },
  { pattern: String.raw`TRUNCATE\s+TABLE`, description: "Truncate table" },
  {
    pattern: String.raw`DELETE\s+FROM\s+[\w.\[\]"'\x60]+\s*(;|$|--|/\*)`,
    description: "Unbounded delete from table",
  },

  // Infrastructure Destruction
  { pattern: String.raw`^terraform\s+destroy`, description: "Terraform destroy" },
  {
    pattern: String.raw`^kubectl\s+delete\s+(node|namespace|pv|pvc)\b`,
    description: "Kubernetes core resource deletion",
  },
  { pattern: String.raw`^helm\s+uninstall.*--all`, description: "Helm uninstall all" },
  { pattern: String.raw`^docker\s+system\s+prune\s+-a`, description: "Docker system prune all" },

  // Git Destruction
  { pattern: String.raw`^git\s+push\s+.*--force($|\s)`, description: "Git force push" },
  { pattern: String.raw`^git\s+push\s+.*-f($|\s)`, description: "Git force push (short flag)" },
  { pattern: String.raw`^git\s+reset\s+--hard`, description: "Git hard reset" },
  { pattern: String.raw`^git\s+clean\s+-[a-z]*f`, description: "Git clean force" },
  { pattern: String.raw`^git\s+checkout\s+--\s+`, description: "Git checkout discard changes" },
  {
    pattern: String.raw`^git\s+restore\s+(?!--staged)`,
    description: "Git restore discard changes",
  },

  // Cloud/System
  { pattern: String.raw`^aws\s+.*terminate-instances`, description: "AWS terminate instances" },
  { pattern: String.raw`^gcloud.*delete.*--quiet`, description: "GCloud quiet delete" },
  { pattern: String.raw`^mkfs`, description: "Format filesystem" },
  { pattern: String.raw`^fdisk`, description: "Partition modification" },
  { pattern: String.raw`^dd\b.*of=/dev/`, description: "Direct disk write" },
  { pattern: String.raw`^chmod\s+-R`, description: "Recursive permission change" },
  { pattern: String.raw`^chown\s+-R`, description: "Recursive ownership change" },
];

/**
 * Result of a trauma scan.
 */
export interface TraumaCandidate {
  sessionPath: string;
  matchedPattern: string;
  description: string;
  evidence: string; // The specific command found
  context: string; // Surrounding text (apology etc)
  timestamp?: string;
}

const COMMAND_KEYS = new Set(["command", "cmd", "CommandLine", "commandLine"]);
const MAX_RECORD_DEPTH = 64;

/** `["bash", "-lc", "<script>"]` → the script; any other argv → joined words. */
function argvToCommand(argv: string[]): string {
  const shellFlagIdx = argv.findIndex((a) => /^-[a-z]*c$/.test(a));
  if (shellFlagIdx >= 1 && shellFlagIdx === argv.length - 2) {
    const shell = path.basename(argv[shellFlagIdx - 1] ?? "");
    if (/^(ba|z|da|k|fi)?sh$/.test(shell)) return argv[argv.length - 1]!;
  }
  return argv.join(" ");
}

/**
 * Collect the shell commands an agent actually executed from a session's
 * structured records (#83). Text exports reduce tool calls to stubs such as
 * `[Tool: Bash - <description>]`, so the commands must come from tool inputs:
 *
 * - Claude Code: `tool_use` blocks with `input.command`
 * - Codex: `function_call` payloads whose `arguments` JSON string holds
 *   `cmd` / `command` (string or argv), and `local_shell_call` argv
 * - Gemini / Antigravity / others: `args.command`, `args.CommandLine`
 *
 * The walk is structural rather than per-connector so new agent formats that
 * name the field `command` / `cmd` are covered without code changes.
 */
export function extractExecutedCommands(records: unknown): string[] {
  const out: string[] = [];
  const visit = (node: unknown, depth: number): void => {
    if (depth > MAX_RECORD_DEPTH || node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (COMMAND_KEYS.has(key)) {
        if (typeof value === "string" && value.trim()) {
          out.push(value);
          continue;
        }
        if (
          Array.isArray(value) &&
          value.length > 0 &&
          value.every((v): v is string => typeof v === "string")
        ) {
          out.push(argvToCommand(value));
          continue;
        }
      }
      if (key === "arguments" && typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
          try {
            visit(JSON.parse(trimmed), depth + 1);
          } catch {
            // Not JSON; nothing structured to read.
          }
        }
        continue;
      }
      visit(value, depth + 1);
    }
  };
  visit(records, 0);
  return out;
}

/**
 * Split a shell command into the simple commands it runs, so `^`-anchored
 * DOOM_PATTERNS match `cd x && rm -rf y` or a multi-line script. This is a
 * heuristic (it does not honour quoting); `cm audit --trauma` output is for
 * human review.
 */
export function splitShellCommand(command: string): string[] {
  return command
    .split(/\r?\n|&&|\|\||;|\|/)
    .map((s) =>
      s
        .trim()
        .replace(/^[({]\s*/, "")
        .replace(/^(?:sudo|exec|time|nohup|command)\s+/, "")
        .trim(),
    )
    .filter(Boolean);
}

/**
 * Scan cass history for potential traumas.
 * Looks for "apology" keywords AND "destruction" patterns. Commands the agent
 * executed (structured tool inputs) are checked first; the text export still
 * catches commands quoted or typed in prose.
 */
export async function scanForTraumas(
  config: Config,
  days: number = 30,
  cassRunner?: CassRunner,
): Promise<TraumaCandidate[]> {
  const APOLOGY_KEYWORDS = [
    "sorry",
    "apologies",
    "mistake",
    "error",
    "catastrophe",
    "disaster",
    "destroyed",
    "wiped",
    "deleted",
    "overwrote",
    "lost work",
  ];

  // 1. Search for sessions with apologies
  const query = APOLOGY_KEYWORDS.join(" OR ");
  const hits = await cassSearch(query, { days, limit: 50 }, config.cassPath, cassRunner);

  // Deduplicate sessions
  const sessionPaths = Array.from(new Set(hits.map((h) => h.source_path)));
  const candidates: TraumaCandidate[] = [];

  log(`Scanning ${sessionPaths.length} sessions for potential traumas...`);

  // 2. Analyze each session
  const sanitizeConfig = getSanitizeConfig(config);
  const compiledSanitizeConfig = {
    ...sanitizeConfig,
    extraPatterns: compileExtraPatterns(sanitizeConfig.extraPatterns),
  };

  for (const sessionPath of sessionPaths) {
    try {
      // Executed commands, from structured tool-call inputs (#83). Records are
      // unsanitized, so everything surfaced from them is sanitized below.
      const records = await cassExportRecords(sessionPath, config.cassPath, cassRunner);
      const commandSegments = records
        ? extractExecutedCommands(records).flatMap((command) =>
            splitShellCommand(command).map((segment) => ({ command, segment })),
          )
        : [];

      const content = await cassExport(sessionPath, "text", config.cassPath, config, cassRunner);
      if (!content && commandSegments.length === 0) continue;

      // Check for DOOM patterns
      for (const doom of DOOM_PATTERNS) {
        const segmentRegex = new RegExp(doom.pattern, "i");
        const executed = commandSegments.find(({ segment }) => segmentRegex.test(segment));
        if (executed) {
          const segmentMatch = segmentRegex.exec(executed.segment);
          const fullCommand =
            executed.command.length > 500
              ? `${executed.command.slice(0, 500)}…`
              : executed.command;
          candidates.push({
            sessionPath,
            matchedPattern: doom.pattern,
            description: doom.description,
            evidence: sanitize(segmentMatch?.[0] ?? executed.segment, compiledSanitizeConfig),
            context: sanitize(`Executed: ${fullCommand.trim()}`, compiledSanitizeConfig),
            timestamp: undefined,
          });
          continue;
        }

        if (!content) continue;
        const regex = new RegExp(doom.pattern, "mi"); // Multiline, case-insensitive
        const match = regex.exec(content);

        if (match) {
          // Found a dangerous command!
          // We assume if it's in a session with an apology, it might be a trauma.
          // Note: This is heuristic. It might be a false positive (e.g. discussing the command).
          // But "cm audit --trauma" is for human review.

          // Grab some context around the match
          const start = Math.max(0, match.index - 100);
          const end = Math.min(content.length, match.index + match[0].length + 100);
          const context = content.slice(start, end);

          candidates.push({
            sessionPath,
            matchedPattern: doom.pattern,
            description: doom.description,
            evidence: match[0],
            context: context.trim(),
            timestamp: undefined, // We'd need to parse this from session content if available
          });
        }
      }
    } catch (e) {
      warn(`[trauma] Failed to analyze session ${sessionPath}: ${e}`);
    }
  }

  return candidates;
}

/**
 * Load all trauma entries from global and project scopes.
 * Merges them into a single list.
 */
export async function loadTraumas(): Promise<TraumaEntry[]> {
  const traumas: TraumaEntry[] = [];

  // 1. Load Global
  const globalDir = resolveGlobalDir();
  const globalPath = path.join(globalDir, GLOBAL_TRAUMA_FILE);
  const globalTraumas = await loadTraumasFromFile(globalPath);
  traumas.push(...globalTraumas);

  // 2. Load Project (if in a repo)
  const repoDir = await resolveRepoDir();
  if (repoDir) {
    const repoPath = path.join(repoDir, REPO_TRAUMA_FILE);
    const repoTraumas = await loadTraumasFromFile(repoPath);
    traumas.push(...repoTraumas);
  }

  return traumas;
}

export type TraumaStatus = TraumaEntry["status"];

async function updateTraumaStatusInFile(
  filePath: string,
  traumaId: string,
  status: TraumaStatus,
): Promise<number> {
  const expanded = expandPath(filePath);
  if (!(await fileExists(expanded))) return 0;

  return withLock(expanded, async () => {
    const content = await fs.readFile(expanded, "utf-8");
    const rawLines = content.split(/\r?\n/);
    const outLines: string[] = [];
    let updated = 0;

    for (const raw of rawLines) {
      const trimmed = raw.trim();
      if (!trimmed) {
        outLines.push("");
        continue;
      }

      try {
        const json = JSON.parse(trimmed) as any;
        if (json && typeof json === "object" && json.id === traumaId) {
          if (json.status !== status) {
            json.status = status;
            updated += 1;
          }
          outLines.push(JSON.stringify(json));
          continue;
        }
        outLines.push(trimmed);
      } catch {
        // Preserve non-JSON lines verbatim (defensive)
        outLines.push(raw);
      }
    }

    if (updated === 0) return 0;

    // Keep JSONL tidy: remove trailing empty lines, ensure final newline.
    while (outLines.length > 0 && outLines[outLines.length - 1] === "") outLines.pop();
    const nextContent = outLines.join("\n") + "\n";
    await atomicWrite(expanded, nextContent);
    return updated;
  });
}

export async function setTraumaStatusById(
  traumaId: string,
  status: TraumaStatus,
  options: { scope?: "global" | "project" | "all" } = {},
): Promise<{ updated: number; checkedPaths: string[]; updatedPaths: string[] }> {
  const scope = options.scope ?? "all";
  const checkedPaths: string[] = [];
  const updatedPaths: string[] = [];
  let updated = 0;

  if (scope === "global" || scope === "all") {
    const globalPath = path.join(resolveGlobalDir(), GLOBAL_TRAUMA_FILE);
    checkedPaths.push(globalPath);
    const n = await updateTraumaStatusInFile(globalPath, traumaId, status);
    if (n > 0) updatedPaths.push(globalPath);
    updated += n;
  }

  if (scope === "project" || scope === "all") {
    const repoDir = await resolveRepoDir();
    if (repoDir) {
      const repoPath = path.join(repoDir, REPO_TRAUMA_FILE);
      checkedPaths.push(repoPath);
      const n = await updateTraumaStatusInFile(repoPath, traumaId, status);
      if (n > 0) updatedPaths.push(repoPath);
      updated += n;
    }
  }

  return { updated, checkedPaths, updatedPaths };
}

export async function healTraumaById(
  traumaId: string,
  options: { scope?: "global" | "project" | "all" } = {},
): Promise<{ updated: number; checkedPaths: string[]; updatedPaths: string[] }> {
  return setTraumaStatusById(traumaId, "healed", options);
}

async function removeTraumaFromFile(filePath: string, traumaId: string): Promise<number> {
  const expanded = expandPath(filePath);
  if (!(await fileExists(expanded))) return 0;

  return withLock(expanded, async () => {
    const content = await fs.readFile(expanded, "utf-8");
    const rawLines = content.split(/\r?\n/);
    const outLines: string[] = [];
    let removed = 0;

    for (const raw of rawLines) {
      const trimmed = raw.trim();
      if (!trimmed) {
        outLines.push("");
        continue;
      }

      try {
        const json = JSON.parse(trimmed) as any;
        if (json && typeof json === "object" && json.id === traumaId) {
          removed += 1;
          continue;
        }
        outLines.push(trimmed);
      } catch {
        // Preserve non-JSON lines verbatim (defensive)
        outLines.push(raw);
      }
    }

    if (removed === 0) return 0;

    // Keep JSONL tidy: remove trailing empty lines, ensure final newline.
    while (outLines.length > 0 && outLines[outLines.length - 1] === "") outLines.pop();
    const nextContent = outLines.length === 0 ? "" : outLines.join("\n") + "\n";
    await atomicWrite(expanded, nextContent);
    return removed;
  });
}

export async function removeTraumaById(
  traumaId: string,
  options: { scope?: "global" | "project" | "all" } = {},
): Promise<{ removed: number; checkedPaths: string[]; updatedPaths: string[] }> {
  const scope = options.scope ?? "all";
  const checkedPaths: string[] = [];
  const updatedPaths: string[] = [];
  let removed = 0;

  if (scope === "global" || scope === "all") {
    const globalPath = path.join(resolveGlobalDir(), GLOBAL_TRAUMA_FILE);
    checkedPaths.push(globalPath);
    const n = await removeTraumaFromFile(globalPath, traumaId);
    if (n > 0) updatedPaths.push(globalPath);
    removed += n;
  }

  if (scope === "project" || scope === "all") {
    const repoDir = await resolveRepoDir();
    if (repoDir) {
      const repoPath = path.join(repoDir, REPO_TRAUMA_FILE);
      checkedPaths.push(repoPath);
      const n = await removeTraumaFromFile(repoPath, traumaId);
      if (n > 0) updatedPaths.push(repoPath);
      removed += n;
    }
  }

  return { removed, checkedPaths, updatedPaths };
}

/**
 * Load traumas from a specific file path.
 * Returns empty array if file doesn't exist or is invalid.
 */
async function loadTraumasFromFile(filePath: string): Promise<TraumaEntry[]> {
  if (!(await fileExists(filePath))) {
    return [];
  }

  try {
    const content = await fs.readFile(expandPath(filePath), "utf-8");
    const lines = content.split(/\r?\n/).filter((line) => line.trim());

    const entries: TraumaEntry[] = [];
    for (const line of lines) {
      try {
        const json = JSON.parse(line);
        const parsed = TraumaEntrySchema.safeParse(json);
        if (parsed.success) {
          entries.push(parsed.data);
        } else {
          warn(`[trauma] Invalid trauma entry in ${filePath}: ${parsed.error.message}`);
        }
      } catch (e) {
        warn(`[trauma] Failed to parse line in ${filePath}: ${e}`);
      }
    }
    return entries;
  } catch (e) {
    logError(`[trauma] Failed to read trauma file ${filePath}: ${e}`);
    return [];
  }
}

/**
 * Save a new trauma entry to the appropriate storage.
 */
export async function saveTrauma(entry: TraumaEntry): Promise<void> {
  let targetPath: string;

  if (entry.scope === "global") {
    const globalDir = resolveGlobalDir();
    await ensureDir(globalDir);
    targetPath = path.join(globalDir, GLOBAL_TRAUMA_FILE);
  } else {
    // Project scope
    if (!entry.projectPath) {
      // Fallback to current repo if not specified
      const repoDir = await resolveRepoDir();
      if (!repoDir) {
        throw new Error("Cannot save project-scoped trauma: not in a git repository");
      }
      targetPath = path.join(repoDir, REPO_TRAUMA_FILE);
    } else {
      // Use specified project root path (we will write under <root>/.cass/)
      targetPath = path.join(entry.projectPath, ".cass", REPO_TRAUMA_FILE);
    }
    await ensureDir(path.dirname(targetPath));
  }

  const line = JSON.stringify(entry) + "\n";
  await withLock(targetPath, async () => {
    await fs.appendFile(expandPath(targetPath), line, "utf-8");
  });
}

/**
 * Save multiple trauma entries in batch.
 * Optimizes file locking by grouping writes per file.
 */
export async function saveTraumas(entries: TraumaEntry[]): Promise<void> {
  // Group entries by target path
  const batches = new Map<string, string[]>();

  for (const entry of entries) {
    let targetPath: string;

    if (entry.scope === "global") {
      const globalDir = resolveGlobalDir();
      targetPath = path.join(globalDir, GLOBAL_TRAUMA_FILE);
    } else {
      // Project scope
      if (!entry.projectPath) {
        const repoDir = await resolveRepoDir();
        if (!repoDir) {
          throw new Error("Cannot save project-scoped trauma: not in a git repository");
        }
        targetPath = path.join(repoDir, REPO_TRAUMA_FILE);
      } else {
        targetPath = path.join(entry.projectPath, ".cass", REPO_TRAUMA_FILE);
      }
    }

    const line = JSON.stringify(entry);
    const bucket = batches.get(targetPath);
    if (bucket) bucket.push(line);
    else batches.set(targetPath, [line]);
  }

  // Write each batch under a single lock
  for (const [targetPath, lines] of batches.entries()) {
    await ensureDir(path.dirname(targetPath));
    const content = lines.join("\n") + "\n";

    await withLock(targetPath, async () => {
      await fs.appendFile(expandPath(targetPath), content, "utf-8");
    });
  }
}

/**
 * Check a command against all active traumas.
 * Returns the matching entry if found, null otherwise.
 */
export function findMatchingTrauma(command: string, traumas: TraumaEntry[]): TraumaEntry | null {
  const activeTraumas = traumas.filter((t) => t.status === "active");

  for (const trauma of activeTraumas) {
    try {
      const regex = new RegExp(trauma.pattern, "i");
      if (regex.test(command)) {
        return trauma;
      }
    } catch {
      warn(`[trauma] Invalid regex pattern in trauma ${trauma.id}: ${trauma.pattern}`);
    }
  }

  return null;
}
