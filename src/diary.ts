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
  error as logError
} from "./utils.js";

// --- Helpers ---

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
  // Fix: Properly compile patterns and construct sanitization config
  const compiledPatterns = compileExtraPatterns(config.sanitization.extraPatterns || []);
  
  const sanitizationConfig: SanitizationConfig = {
    enabled: config.sanitization.enabled,
    extraPatterns: config.sanitization.extraPatterns || [],
    auditLog: config.sanitization.auditLog,
    auditLevel: config.sanitization.auditLevel || "off"
  };
  
  // For runtime usage in sanitize utility, we pass the regexes manually if utility supports it?
  // sanitize utility interface: extraPatterns?: RegExp[];
  // Config has string[].
  // We need to pass an object that matches what sanitize() expects.
  // sanitize() signature: (text: string, config: SanitizationConfig) -> but SanitizationConfig in sanitize.ts has RegExp[]
  // While SanitizationConfig in types.ts has string[] (for JSON config file).
  // This mismatch causes the issue.
  // We should cast or construct the object expected by sanitize().
  
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

  return enrichedDiary;
}

// --- Persistence ---

export async function saveDiary(diary: DiaryEntry, config: Config): Promise<void> {
  const diaryPath = path.join(expandPath(config.diaryDir), `${diary.id}.json`);
  await ensureDir(path.dirname(diaryPath));
  
  await fs.writeFile(diaryPath, JSON.stringify(diary, null, 2));
  log(`Saved diary to ${diaryPath}`);
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
