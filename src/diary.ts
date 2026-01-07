import path from "node:path";
import fs from "node:fs/promises";
import { z } from "zod";
import { 
  Config, 
  DiaryEntry, 
  DiaryEntrySchema, 
  CassHit,
  RelatedSession,
  RelatedSessionSchema,
  SanitizationConfig
} from "./types.js";
import { 
  extractDiary, 
  generateSearchQueries 
} from "./llm.js";
import { 
  safeCassSearch, 
  cassExport, 
  cassSearch 
} from "./cass.js";
import { 
  sanitize, 
  verifySanitization,
  compileExtraPatterns
} from "./sanitize.js";
import { 
  generateDiaryId, 
  extractKeywords, 
  hashContent,
  now, 
  ensureDir, 
  expandPath,
  log,
  warn,
  error as logError,
  atomicWrite,
  resolveRepoDir
} from "./utils.js";
import { withLock } from "./lock.js";

// --- Helpers ---

function normalizeAgentName(agent: string | undefined): string {
  return (agent || "").trim().toLowerCase();
}

async function appendCrossAgentAuditLog(
  diary: DiaryEntry,
  related: RelatedSession[],
  config: Config
): Promise<void> {
  try {
    if (config.crossAgent?.auditLog === false) return;

    // Use resolveRepoDir to check for repo context
    const repoDir = await resolveRepoDir();
    const repoLog = repoDir ? path.join(repoDir, "privacy-audit.jsonl") : null;
    
    // Fall back to global log if not in repo or repo-level logging disabled (policy)
    const logPath = repoLog
      ? repoLog
      : expandPath("~/.cass-memory/privacy-audit.jsonl");

    await ensureDir(path.dirname(logPath));

    const relatedAgents = Array.from(
      new Set(related.map((r) => normalizeAgentName(r.agent)).filter(Boolean))
    ).sort();

    const payload = {
      timestamp: now(),
      event: "cross_agent_enrichment",
      sourceAgent: normalizeAgentName(diary.agent),
      sourceSessionHash: hashContent(diary.sessionPath),
      relatedSessionCount: related.length,
      relatedAgents,
      allowlistAgents: (config.crossAgent?.agents || []).map(normalizeAgentName).filter(Boolean),
    };

    // Use withLock to safely append to audit log
    await withLock(logPath, async () => {
      await fs.appendFile(logPath, JSON.stringify(payload) + "\n", "utf-8");
    });
  } catch {
    // Best-effort: privacy auditing must never break diary generation.
  }
}

export function formatRawSession(content: string, ext: string): string {
  const normalizedExt = (ext.startsWith(".") ? ext : `.${ext}`).toLowerCase();

  const coerceRawContent = (value: unknown): string | null => {
    if (!value) return null;
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
      const parts = value
        .map((v) => coerceRawContent(v))
        .filter((v): v is string => Boolean(v));
      return parts.length ? parts.join("\n") : null;
    }
    if (typeof value === "object") {
      const maybeText = (value as { text?: unknown; content?: unknown; message?: unknown; value?: unknown });
      if (typeof maybeText.text === "string") return maybeText.text;
      // Recurse into content if it's an array (e.g., Claude multi-block format)
      if (Array.isArray(maybeText.content)) return coerceRawContent(maybeText.content);
      if (typeof maybeText.content === "string") return maybeText.content;
      if (typeof maybeText.message === "string") return maybeText.message;
      if (typeof maybeText.value === "string") return maybeText.value;
    }
    return null;
  };

  const formatEntry = (entry: any): string | null => {
    if (!entry) return null;

    // Codex CLI: skip metadata entries
    if (entry.type === "session_meta") return null;

    // Codex CLI: response_item with message payload
    if (entry.type === "response_item" && entry.payload) {
      const payload = entry.payload;
      if (payload?.type === "message") {
        const role = payload.role || "[unknown]";
        const payloadContent = coerceRawContent(payload.content);
        return `**${role}**: ${payloadContent ?? "[empty]"}`;
      }
      return null;
    }

    const role = entry.role || entry.type || entry.agent || "[unknown]";
    const msgContent = coerceRawContent(entry.content ?? entry.text ?? entry.message ?? entry.value);
    return `**${role}**: ${msgContent ?? "[empty]"}`;
  };

  if (normalizedExt === ".md" || normalizedExt === ".markdown") {
    return content;
  }

  if (normalizedExt === ".jsonl") {
    if (!content.trim()) return "";
    return content
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        try {
          const json = JSON.parse(line);
          return formatEntry(json);
        } catch {
          return `[PARSE ERROR] ${line}`;
        }
      })
      .filter((line): line is string => Boolean(line))
      .join("\n\n");
  }

  if (normalizedExt === ".json") {
    if (!content.trim()) return "";
    try {
      const json = JSON.parse(content);
      let messages: any[] = [];

      if (Array.isArray(json)) {
        messages = json;
      } else if (json.messages && Array.isArray(json.messages)) {
        messages = json.messages;
      } else if (json.conversation && Array.isArray(json.conversation)) {
        messages = json.conversation;
      } else if (json.turns && Array.isArray(json.turns)) {
        messages = json.turns;
      } else {
        return `WARNING: Unrecognized JSON structure (.${ext})\n${content}`;
      }

      if (messages.length === 0) return "";

      return messages
        .map((msg) => formatEntry(msg))
        .filter((line): line is string => Boolean(line))
        .join("\n\n");
    } catch {
      return `[PARSE ERROR: Invalid JSON] ${content}`;
    }
  }

  return `WARNING: Unsupported session format (.${normalizedExt.replace(".", "")})\n${content}`;
}

function extractSessionMetadata(sessionPath: string): { agent: string; workspace?: string } {
  const normalized = path.normalize(sessionPath);
  const lower = normalized.toLowerCase();
  
  // Detect agent
  let agent = "unknown";
  if (lower.includes(".claude")) agent = "claude";
  else if (lower.includes(".cursor")) agent = "cursor";
  else if (lower.includes(".codex")) agent = "codex";
  else if (lower.includes(".aider")) agent = "aider";
  else if (lower.includes(".pi/agent/sessions") || lower.includes(".pi\\agent\\sessions")) agent = "pi_agent";
  
  return { agent };
}

async function enrichWithRelatedSessions(
  diary: DiaryEntry, 
  config: Config
): Promise<DiaryEntry> {
  const cross = config.crossAgent;
  if (!cross?.enabled || !cross.consentGiven) return diary;

  // 1. Build keyword set from diary content
  const textContent = [
    ...diary.keyLearnings,
    ...diary.challenges,
    ...diary.accomplishments
  ].join(" ");
  
  const keywords = extractKeywords(textContent);
  if (keywords.length === 0) return diary;

  // 2. Query cass
  const query = keywords.slice(0, 5).join(" "); // Top 5 keywords
  const hits = await safeCassSearch(query, {
    limit: 5,
    days: config.sessionLookbackDays,
  }, config.cassPath, config);

  const allowlist = (cross.agents || []).map(normalizeAgentName).filter(Boolean);
  const diaryAgent = normalizeAgentName(diary.agent);

  // 3. Filter and Format
  const related: RelatedSession[] = hits
    .filter(h => normalizeAgentName(h.agent) !== diaryAgent) // Cross-agent only
    .filter(h => allowlist.length === 0 || allowlist.includes(normalizeAgentName(h.agent)))
    .map(h => ({
      sessionPath: h.source_path,
      agent: h.agent,
      relevanceScore: h.score || 0, 
      snippet: h.snippet
    }));

  // 4. Attach to diary
  await appendCrossAgentAuditLog(diary, related, config);
  if (related.length > 0) {
    diary.relatedSessions = related;
  }

  return diary;
}

// --- Fast Extraction (No LLM) ---

/**
 * Infer session outcome from session content without LLM.
 * Looks for error patterns, success indicators, etc.
 * @public - Exported for testing
 */
export function inferOutcome(content: string): "success" | "failure" | "mixed" {
  const errorPatterns = [
    /\berror[s]?\b/i, /\bfailed\b/i, /\bexception\b/i, /\btraceback\b/i,
    /cannot\s+find/i, /not\s+found/i, /\bundefined\b/i, /null\s+reference/i,
    /syntax\s*error/i, /type\s*error/i, /runtime\s*error/i, /\bcrash/i
  ];

  const successPatterns = [
    /successfully/i, /completed/i, /done/i, /fixed/i,
    /works\s+(now|correctly)/i, /resolved/i, /passed/i,
    /all\s+tests\s+pass/i, /build\s+successful/i
  ];

  const hasErrors = errorPatterns.some(p => p.test(content));
  const hasSuccess = successPatterns.some(p => p.test(content));

  if (hasErrors && hasSuccess) return "mixed";
  if (hasErrors) return "failure";
  if (hasSuccess) return "success";

  return "success"; // Default to success if no clear indicators
}

/**
 * Extract file paths mentioned in session content.
 */
function extractFilePaths(content: string): string[] {
  const patterns = [
    // Common file patterns
    /[\w./\\-]+\.(ts|tsx|js|jsx|py|go|rs|java|c|cpp|h|hpp|md|json|yaml|yml|toml|txt|css|scss|html)/gi,
    // src/ or test/ paths - generalized to be less opinionated but still useful
    // Matches path-like strings containing a slash
    /[\w.-]+[\/\\][\w./\\-]+\.\w+/gi
  ];

  const matches = new Set<string>();
  for (const pattern of patterns) {
    const found = content.match(pattern) || [];
    for (const f of found) {
      // Clean up and normalize
      const cleaned = f.replace(/^['"]+|['"]+$/g, "").replace(/\\+/g, "/");
      if (cleaned.length > 3 && cleaned.length < 200) {
        matches.add(cleaned);
      }
    }
  }

  return [...matches].slice(0, 20); // Limit to 20 files
}

/**
 * Extract first user message as task description.
 */
function extractFirstUserMessage(content: string): string | undefined {
  // Look for user message patterns
  const patterns = [
    /\*\*user\*\*:\s*(.+?)(?=\n\n|\n\*\*|$)/is,
    /\*\*human\*\*:\s*(.+?)(?=\n\n|\n\*\*|$)/is,
    /user:\s*(.+?)(?=\n\n|assistant:|$)/is
  ];

  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match && match[1]) {
      const task = match[1].trim().slice(0, 500);
      if (task.length > 10) return task;
    }
  }

  return undefined;
}

/**
 * Generate a brief summary from content without LLM.
 * Extracts key information from the session.
 */
function generateQuickSummary(content: string, task?: string): string {
  if (task && task.length > 20) {
    return `Session: ${task.slice(0, 200)}`;
  }

  // Extract first meaningful line
  const lines = content.split("\n").filter(l => l.trim().length > 20);
  if (lines.length > 0) {
    return lines[0].slice(0, 200);
  }

  return "Coding session";
}

/**
 * Generate diary entry WITHOUT LLM (fast extraction).
 * Uses heuristics to extract key information from session content.
 *
 * Use this for:
 * - Quick session processing
 * - Offline/local-only mode
 * - Reducing LLM costs
 * - Initial processing before full LLM extraction
 */
export async function generateDiaryFast(
  sessionPath: string,
  config: Config
): Promise<DiaryEntry> {
  // 1. Export Session (Sanitized via cassExport)
  const sanitizedContent = await cassExport(sessionPath, "markdown", config.cassPath, config);
  if (!sanitizedContent) {
    throw new Error(`Failed to export session: ${sessionPath}`);
  }

  return generateDiaryFastFromContent(sessionPath, sanitizedContent, config);
}

// --- Main Generator ---

async function generateDiaryFastFromContent(
  sessionPath: string,
  sanitizedContent: string,
  config: Config
): Promise<DiaryEntry> {
  log(`Generating diary (fast mode) for ${sessionPath}...`);

  // 1. Extract Metadata
  const metadata = extractSessionMetadata(sessionPath);

  // 2. Fast Extraction (no LLM)
  const task = extractFirstUserMessage(sanitizedContent);
  const outcome = inferOutcome(sanitizedContent);
  const filesChanged = extractFilePaths(sanitizedContent);
  const summary = generateQuickSummary(sanitizedContent, task);

  // 3. Assemble Entry
  const diary: DiaryEntry = {
    id: generateDiaryId(sessionPath, sanitizedContent), // Use content for deterministic ID
    sessionPath,
    timestamp: now(),
    agent: metadata.agent,
    workspace: metadata.workspace,
    status: outcome,
    accomplishments: task ? [task.slice(0, 200)] : [],
    decisions: [],
    challenges: [],
    preferences: [],
    keyLearnings: summary ? [summary] : [],
    tags: filesChanged.slice(0, 5).map(f => path.basename(f)),
    searchAnchors: extractKeywords(summary + " " + (task || "")),
    relatedSessions: []
  };

  // 4. Save
  await saveDiary(diary, config);
  log(`Saved fast diary to ${expandPath(config.diaryDir)}/${diary.id}.json`);

  return diary;
}

export async function generateDiaryFromContent(
  sessionPath: string,
  sanitizedContent: string,
  config: Config
): Promise<DiaryEntry> {
  if (!sanitizedContent || sanitizedContent.trim().length === 0) {
    throw new Error(`Session content is empty after sanitization: ${sessionPath}`);
  }

  // Fast path when LLMs are disabled or unavailable
  if (process.env.CASS_MEMORY_LLM === "none") {
    return generateDiaryFastFromContent(sessionPath, sanitizedContent, config);
  }

  log(`Generating diary for ${sessionPath}...`);

  const verification = verifySanitization(sanitizedContent);
  if (verification.containsPotentialSecrets) {
    warn(`[Diary] Potential secrets detected after sanitization in ${sessionPath}: ${verification.warnings.join(", ")}`);
  }

  // 1. Extract Metadata
  const metadata = extractSessionMetadata(sessionPath);

  // 2. LLM Extraction
  const ExtractionSchema = DiaryEntrySchema.omit({ 
    id: true, 
    sessionPath: true, 
    timestamp: true, 
    relatedSessions: true, 
    searchAnchors: true 
  });

  const extracted = await extractDiary(
    ExtractionSchema,
    sanitizedContent,
    { ...metadata, sessionPath },
    config
  );

  // 3. Assemble Entry
  const diary: DiaryEntry = {
    id: generateDiaryId(sessionPath, sanitizedContent), // Use content for deterministic ID
    sessionPath,
    timestamp: now(),
    agent: metadata.agent,
    workspace: metadata.workspace,
    status: extracted.status,
    accomplishments: extracted.accomplishments || [],
    decisions: extracted.decisions || [],
    challenges: extracted.challenges || [],
    preferences: extracted.preferences || [],
    keyLearnings: extracted.keyLearnings || [],
    tags: extracted.tags || [],
    searchAnchors: [], 
    relatedSessions: []
  };

  const anchorText = [
    ...diary.keyLearnings, 
    ...diary.challenges
  ].join(" ");
  diary.searchAnchors = extractKeywords(anchorText);

  // 4. Enrich (Cross-Agent)
  const enrichedDiary = await enrichWithRelatedSessions(diary, config);

  // 5. Save
  await saveDiary(enrichedDiary, config);

  return enrichedDiary;
}

export async function generateDiary(
  sessionPath: string,
  config: Config
): Promise<DiaryEntry> {
  // Fast path when LLMs are disabled or unavailable
  if (process.env.CASS_MEMORY_LLM === "none") {
    return generateDiaryFast(sessionPath, config);
  }

  // 1. Export Session (Sanitized via cassExport)
  const sanitizedContent = await cassExport(sessionPath, "markdown", config.cassPath, config);
  if (!sanitizedContent) {
    throw new Error(`Failed to export session: ${sessionPath}`);
  }
  
  return generateDiaryFromContent(sessionPath, sanitizedContent, config);
}

// --- Persistence ---

export async function saveDiary(diary: DiaryEntry, config: Config): Promise<void> {
  const diaryPath = path.join(expandPath(config.diaryDir), `${diary.id}.json`);
  await atomicWrite(diaryPath, JSON.stringify(diary, null, 2));
  log(`Saved diary to ${diaryPath}`);
}

/**
 * Locate a diary entry by session path.
 *
 * Returns the first diary whose sessionPath matches the provided path
 * (after resolving both to absolute paths). Returns null if none found or
 * if the diary directory is missing/unreadable.
 */
export async function findDiaryBySession(
  sessionPath: string,
  diaryDir: string
): Promise<DiaryEntry | null> {
  try {
    const base = path.resolve(expandPath(diaryDir));
    const target = path.isAbsolute(sessionPath)
      ? path.resolve(expandPath(sessionPath))
      : path.resolve(base, sessionPath);

    // Optimization: Check processed logs (global AND workspaces) to avoid scanning thousands of files
    try {
      const { getProcessedLogPath, ProcessedLog } = await import("./tracking.js");
      const globalLogPath = getProcessedLogPath(); 
      const reflectionsDir = path.dirname(globalLogPath);

      // 1. Check global log first
      const globalLog = new ProcessedLog(globalLogPath);
      await globalLog.load();
      let entry = globalLog.get(target);

      // 2. If not found, check workspace logs
      if (!entry && await fs.access(reflectionsDir).then(() => true).catch(() => false)) {
        const files = await fs.readdir(reflectionsDir);
        const workspaceLogs = files.filter(f => f.endsWith(".processed.log") && f !== "global.processed.log");
        
        for (const logFile of workspaceLogs) {
          const pLog = new ProcessedLog(path.join(reflectionsDir, logFile));
          await pLog.load();
          entry = pLog.get(target);
          if (entry) break;
        }
      }
      
      if (entry && entry.diaryId) {
        // Found indexed diary ID, load directly
        // We mock the config object since loadDiary only needs diaryDir
        const loaded = await loadDiary(entry.diaryId, { diaryDir } as Config);
        if (loaded) return loaded;
      }
    } catch {
      // Ignore index errors, fall back to scan
    }

    // Load all diaries to find the match (limit set high to ensure we search history)
    // In a future optimization, we should maintain a sessionPath -> diaryId index
    const diaries = await loadAllDiaries(diaryDir, 10000);
    const match = diaries.find((d) => d.sessionPath && path.resolve(expandPath(d.sessionPath)) === target);
    return match || null;
  } catch (err: any) {
    warn(`Failed to find diary for ${sessionPath}: ${err.message}`);
    return null;
  }
}

export async function loadDiary(idOrPath: string, config: Config): Promise<DiaryEntry | null> {
  let fullPath = idOrPath;
  const looksLikePath =
    idOrPath.endsWith(".json") ||
    idOrPath.includes("/") ||
    idOrPath.includes("\\") ||
    path.isAbsolute(idOrPath) ||
    path.win32.isAbsolute(idOrPath);

  if (!looksLikePath) {
    fullPath = path.join(expandPath(config.diaryDir), `${idOrPath}.json`);
  }

  if (!(await fs.stat(fullPath).catch(() => null))) return null;

  try {
    const content = await fs.readFile(fullPath, "utf-8");
    const json = JSON.parse(content);
    return DiaryEntrySchema.parse(json);
  } catch (err: any) {
    logError(`Failed to load diary ${fullPath}: ${err.message}`);
    return null;
  }
}

/**
 * Load all diary entries from a directory.
 *
 * @param diaryDir - Path to the diary directory
 * @param limit - Maximum number of entries to load (default: 100)
 * @returns Array of diary entries sorted by timestamp (most recent first)
 */
export async function loadAllDiaries(diaryDir: string, limit = 100): Promise<DiaryEntry[]> {
  const expanded = expandPath(diaryDir);
  const entries: DiaryEntry[] = [];

  try {
    const files = await fs.readdir(expanded);
    
    // Sort files by mtime to get most recent first
    const fileStats = await Promise.all(
      files
        .filter(f => f.endsWith(".json"))
        .map(async f => {
          try {
            const stats = await fs.stat(path.join(expanded, f));
            return { name: f, mtime: stats.mtimeMs };
          } catch {
            return null;
          }
        })
    );

    const sortedFiles = fileStats
      .filter((f): f is { name: string; mtime: number } => f !== null)
      .sort((a, b) => b.mtime - a.mtime)
      .map(f => f.name);

    for (const file of sortedFiles) {
      if (entries.length >= limit) break;

      try {
        const fullPath = path.join(expanded, file);
        const content = await fs.readFile(fullPath, "utf-8");
        const json = JSON.parse(content);
        const diary = DiaryEntrySchema.parse(json);
        entries.push(diary);
      } catch (err: any) {
        warn(`[Diary] Skipped invalid diary file ${file}: ${err.message}`);
      }
    }

    // Double-check sort by internal timestamp in case mtime was touched
    entries.sort((a, b) =>
      new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );

    return entries;
  } catch (err: any) {
    if (err.code === "ENOENT") {
      return [];
    }
    warn(`Failed to load diaries from ${expanded}: ${err.message}`);
    return [];
  }
}
