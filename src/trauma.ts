import fs from "node:fs/promises";
import path from "node:path";
import {
  TraumaEntry,
  TraumaEntrySchema,
  TraumaScope,
  Config
} from "./types.js";
import {
  expandPath,
  resolveRepoDir,
  resolveGlobalDir,
  ensureDir,
  fileExists,
  warn,
  error as logError,
  log
} from "./utils.js";
import { cassSearch, cassExport, type CassRunner } from "./cass.js";

// ... existing imports

const GLOBAL_TRAUMA_FILE = "traumas.jsonl";
const REPO_TRAUMA_FILE = "traumas.jsonl";

/**
 * Known dangerous patterns that indicate a potential catastrophe.
 * Sourced from simultaneous_launch_button (Project Hot Stove).
 */
export const DOOM_PATTERNS = [
  // ... (patterns remain the same) ...
  // Filesystem Destruction
  { pattern: String.raw`^rm\s+(-[rf]+\s+)+/(etc|usr|var|boot|home|root|bin|sbin|lib)`, description: "Recursive deletion of system directories" },
  { pattern: String.raw`^rm\s+(-[rf]+\s+)+/[^t]`, description: "Recursive deletion of root subdirectories" },
  { pattern: String.raw`^rm\s+(-[rf]+\s+)+~`, description: "Recursive deletion of home directory" },
  { pattern: String.raw`^rm\s+(-[rf]+\s+)+`, description: "Recursive force deletion (high risk)" },
  
  // Database Destruction
  { pattern: String.raw`DROP\s+DATABASE`, description: "Drop database" },
  { pattern: String.raw`DROP\s+SCHEMA`, description: "Drop schema" },
  { pattern: String.raw`TRUNCATE\s+TABLE`, description: "Truncate table" },
  { pattern: String.raw`DELETE\s+FROM\s+[\w.\[\]"'\x60]+\s*(;|$|--|/\*)`, description: "Unbounded delete from table" },

  // Infrastructure Destruction
  { pattern: String.raw`^terraform\s+destroy`, description: "Terraform destroy" },
  { pattern: String.raw`^kubectl\s+delete\s+(node|namespace|pv|pvc)\b`, description: "Kubernetes core resource deletion" },
  { pattern: String.raw`^helm\s+uninstall.*--all`, description: "Helm uninstall all" },
  { pattern: String.raw`^docker\s+system\s+prune\s+-a`, description: "Docker system prune all" },

  // Git Destruction
  { pattern: String.raw`^git\s+push\s+.*--force($|\s)`, description: "Git force push" },
  { pattern: String.raw`^git\s+push\s+.*-f($|\s)`, description: "Git force push (short flag)" },
  { pattern: String.raw`^git\s+reset\s+--hard`, description: "Git hard reset" },
  { pattern: String.raw`^git\s+clean\s+-[a-z]*f`, description: "Git clean force" },
  { pattern: String.raw`^git\s+checkout\s+--\s+`, description: "Git checkout discard changes" },
  { pattern: String.raw`^git\s+restore\s+(?!--staged)`, description: "Git restore discard changes" },
  
  // Cloud/System
  { pattern: String.raw`^aws\s+.*terminate-instances`, description: "AWS terminate instances" },
  { pattern: String.raw`^gcloud.*delete.*--quiet`, description: "GCloud quiet delete" },
  { pattern: String.raw`^mkfs`, description: "Format filesystem" },
  { pattern: String.raw`^fdisk`, description: "Partition modification" },
  { pattern: String.raw`^dd\b.*of=/dev/`, description: "Direct disk write" },
  { pattern: String.raw`^chmod\s+-R`, description: "Recursive permission change" },
  { pattern: String.raw`^chown\s+-R`, description: "Recursive ownership change" }
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

/**
 * Scan cass history for potential traumas.
 * Looks for "apology" keywords AND "destruction" patterns.
 */
export async function scanForTraumas(
  config: Config,
  days: number = 30,
  cassRunner?: CassRunner
): Promise<TraumaCandidate[]> {
  const APOLOGY_KEYWORDS = [
    "sorry", "apologies", "mistake", "error", "catastrophe", "disaster", 
    "destroyed", "wiped", "deleted", "overwrote", "lost work"
  ];
  
  // 1. Search for sessions with apologies
  const query = APOLOGY_KEYWORDS.join(" OR ");
  const hits = await cassSearch(query, { days, limit: 50 }, config.cassPath, cassRunner);
  
  // Deduplicate sessions
  const sessionPaths = Array.from(new Set(hits.map(h => h.source_path)));
  const candidates: TraumaCandidate[] = [];

  log(`Scanning ${sessionPaths.length} sessions for potential traumas...`);

  // 2. Analyze each session
  for (const sessionPath of sessionPaths) {
    try {
      const content = await cassExport(sessionPath, "text", config.cassPath, config, cassRunner);
      if (!content) continue;

      // Check for DOOM patterns
      for (const doom of DOOM_PATTERNS) {
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
            timestamp: undefined // We'd need to parse this from session content if available
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
export async function loadTraumas(): Promise<TraumaEntry[]> {  const traumas: TraumaEntry[] = [];

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

/**
 * Load traumas from a specific file path.
 * Returns empty array if file doesn't exist or is invalid.
 */
async function loadTraumasFromFile(filePath: string): Promise<TraumaEntry[]> {
  if (!await fileExists(filePath)) {
    return [];
  }

  try {
    const content = await fs.readFile(expandPath(filePath), "utf-8");
    const lines = content.split("\n").filter(line => line.trim());
    
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
         // Use specified project path (.cass folder)
         targetPath = path.join(entry.projectPath, ".cass", REPO_TRAUMA_FILE);
    }
    await ensureDir(path.dirname(targetPath));
  }

  const line = JSON.stringify(entry) + "\n";
  await fs.appendFile(expandPath(targetPath), line, "utf-8");
}

/**
 * Check a command against all active traumas.
 * Returns the matching entry if found, null otherwise.
 */
export function findMatchingTrauma(command: string, traumas: TraumaEntry[]): TraumaEntry | null {
  const activeTraumas = traumas.filter(t => t.status === "active");
  
  for (const trauma of activeTraumas) {
    try {
      const regex = new RegExp(trauma.pattern, "i");
      if (regex.test(command)) {
        return trauma;
      }
    } catch (e) {
      warn(`[trauma] Invalid regex pattern in trauma ${trauma.id}: ${trauma.pattern}`);
    }
  }

  return null;
}
