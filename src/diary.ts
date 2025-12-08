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
  now, 
  ensureDir, 
  expandPath,
  log,
  warn,
  error as logError,
  atomicWrite
} from "./utils.js";

// --- Helpers ---

export function formatRawSession(content: string, ext: string): string {
  const normalizedExt = (ext.startsWith(".") ? ext : `.${ext}`).toLowerCase();

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
          const role = json.role || "[unknown]";
          const msgContent = json.content || "[empty]";
          return `**${role}**: ${msgContent}`;
        } catch {
          return `[PARSE ERROR] ${line}`;
        }
      })
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
        .map((msg) => {
          const role = msg.role || "[unknown]";
          const msgContent = msg.content || "[empty]";
          return `**${role}**: ${msgContent}`;
        })
        .join("\n\n");
    } catch {
      return `[PARSE ERROR: Invalid JSON] ${content}`;
    }
  }

  return `WARNING: Unsupported session format (.${normalizedExt.replace(".", "")})\n${content}`;
}

function extractSessionMetadata(sessionPath: string): { agent: string; workspace?: string } {
  const normalized = path.normalize(sessionPath);
  
  // Detect agent
  let agent = "unknown";
  if (normalized.includes(".claude")) agent = "claude";
  else if (normalized.includes(".cursor")) agent = "cursor";
  else if (normalized.includes(".codex")) agent = "codex";
  else if (normalized.includes(".aider")) agent = "aider";
  
  return { agent };
}

async function enrichWithRelatedSessions(
  diary: DiaryEntry, 
  config: Config
): Promise<DiaryEntry> {
  if (!config.enrichWithCrossAgent) return diary;

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
  }, config.cassPath);

  // 3. Filter and Format
  const related: RelatedSession[] = hits
    .filter(h => h.agent !== diary.agent) // Cross-agent only
    .map(h => ({
      sessionPath: h.source_path,
      agent: h.agent,
      relevanceScore: h.score || 0, 
      snippet: h.snippet
    }));

  // 4. Attach to diary
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
  const lowerContent = content.toLowerCase();

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
    // src/ or test/ paths
    /(?:src|test|lib|app|pages|components)[\/\\][\w./\\-]+/gi
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
  log(`Generating diary (fast mode) for ${sessionPath}...`);

  // 1. Export Session
  const rawContent = await cassExport(sessionPath, "markdown", config.cassPath);
  if (!rawContent) {
    throw new Error(`Failed to export session: ${sessionPath}`);
  }

  // 2. Sanitize
  const compiledPatterns = compileExtraPatterns(config.sanitization.extraPatterns || []);
  const runtimeSanitizeConfig = {
    enabled: config.sanitization.enabled,
    extraPatterns: compiledPatterns,
    auditLog: config.sanitization.auditLog
  };
  const sanitizedContent = sanitize(rawContent, runtimeSanitizeConfig);

  // 3. Extract Metadata
  const metadata = extractSessionMetadata(sessionPath);

  // 4. Fast Extraction (no LLM)
  const task = extractFirstUserMessage(sanitizedContent);
  const outcome = inferOutcome(sanitizedContent);
  const filesChanged = extractFilePaths(sanitizedContent);
  const summary = generateQuickSummary(sanitizedContent, task);

  // 5. Assemble Entry
  const diary: DiaryEntry = {
    id: generateDiaryId(sessionPath),
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

  // 6. Save
  await saveDiary(diary, config);
  log(`Saved fast diary to ${expandPath(config.diaryDir)}/${diary.id}.json`);

  return diary;
}

// --- Main Generator ---

export async function generateDiary(
  sessionPath: string,
  config: Config
): Promise<DiaryEntry> {
  log(`Generating diary for ${sessionPath}...`);

  // 1. Export Session
  const rawContent = await cassExport(sessionPath, "markdown", config.cassPath);
  if (!rawContent) {
    throw new Error(`Failed to export session: ${sessionPath}`);
  }

  // 2. Sanitize
  const compiledPatterns = compileExtraPatterns(config.sanitization.extraPatterns || []);
  
  const runtimeSanitizeConfig = {
    enabled: config.sanitization.enabled,
    extraPatterns: compiledPatterns,
    auditLog: config.sanitization.auditLog
  };

  const sanitizedContent = sanitize(rawContent, runtimeSanitizeConfig);
  
  const verification = verifySanitization(sanitizedContent);
  if (verification.containsPotentialSecrets) {
    warn(`[Diary] Potential secrets detected after sanitization in ${sessionPath}: ${verification.warnings.join(", ")}`);
  }

  // 3. Extract Metadata
  const metadata = extractSessionMetadata(sessionPath);

  // 4. LLM Extraction
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

  // 5. Assemble Entry
  const diary: DiaryEntry = {
    id: generateDiaryId(sessionPath),
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

  // 7. Enrich (Cross-Agent)
  const enrichedDiary = await enrichWithRelatedSessions(diary, config);

  // 8. Save
  await saveDiary(enrichedDiary, config);

  return enrichedDiary;
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

    const diaries = await loadAllDiaries(diaryDir);
    const match = diaries.find((d) => d.sessionPath && path.resolve(expandPath(d.sessionPath)) === target);
    return match || null;
  } catch (err: any) {
    warn(`Failed to find diary for ${sessionPath}: ${err.message}`);
    return null;
  }
}

export async function loadDiary(idOrPath: string, config: Config): Promise<DiaryEntry | null> {
  let fullPath = idOrPath;
  if (!idOrPath.includes("/") && !idOrPath.endsWith(".json")) {
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
    const jsonFiles = files
      .filter(f => f.endsWith(".json"))
      .slice(0, limit * 2); // Read extra to account for validation failures

    for (const file of jsonFiles) {
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

    // Sort by timestamp, most recent first
    entries.sort((a, b) =>
      new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );

    return entries.slice(0, limit);
  } catch (err: any) {
    if (err.code === "ENOENT") {
      return [];
    }
    warn(`Failed to load diaries from ${expanded}: ${err.message}`);
    return [];
  }
}
