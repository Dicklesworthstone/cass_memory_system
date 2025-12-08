import { z } from 'zod';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Config, DiaryEntry, RelatedSession, DiaryEntrySchema } from './types.js';
import { extractDiary } from './llm.js';
import { getSanitizeConfig } from './config.js'; // Import helper
import { sanitize } from './security.js';
import { extractAgentFromPath } from './utils.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Subset of schema for LLM extraction (omits relatedSessions which we do separately)
const ExtractionSchema = DiaryEntrySchema.pick({
  status: true,
  accomplishments: true,
  decisions: true,
  challenges: true,
  preferences: true,
  keyLearnings: true,
  tags: true,
  searchAnchors: true
});

export async function generateDiary(sessionPath: string, config: Config): Promise<DiaryEntry> {
  const rawContent = await exportSessionSafe(sessionPath);
  
  // Use helper to get compiled regex patterns
  const sanitizeConfig = getSanitizeConfig(config);
  const sanitizedContent = sanitize(rawContent, sanitizeConfig);
  
  const agent = extractAgentFromPath(sessionPath);
  // Extract workspace name from path (heuristic: parent dir)
  const workspace = path.basename(path.dirname(sessionPath));

  const metadata = { sessionPath, agent, workspace };
  
  // Extract structured data using LLM
  const extracted = await extractDiary(
    ExtractionSchema,
    sanitizedContent, 
    metadata,
    config
  );

  const related = await enrichWithRelatedSessions(sanitizedContent, config);
  
  const diary: DiaryEntry = {
    id: `diary-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    sessionPath,
    timestamp: new Date().toISOString(),
    agent,
    workspace,
    status: extracted.status,
    accomplishments: extracted.accomplishments || [],
    decisions: extracted.decisions || [],
    challenges: extracted.challenges || [],
    preferences: extracted.preferences || [],
    keyLearnings: extracted.keyLearnings || [],
    tags: extracted.tags || [],
    searchAnchors: extracted.searchAnchors || [],
    relatedSessions: related
  };
  
  await saveDiaryEntry(diary, config);
  
  return diary;
}

async function exportSessionSafe(sessionPath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('cass', ['export', sessionPath, '--format', 'markdown'], {
      timeout: 30000,
      maxBuffer: 50 * 1024 * 1024
    });
    return stdout;
  } catch (error) {
    throw new Error(`Failed to export session: ${error}`);
  }
}

async function enrichWithRelatedSessions(content: string, config: Config): Promise<RelatedSession[]> {
  // Placeholder for cross-agent enrichment
  return []; 
}

async function saveDiaryEntry(entry: DiaryEntry, config: Config): Promise<void> {
  if (!config.diaryDir) return;
  
  // Atomic write
  const filename = `${entry.id}.json`;
  const filePath = path.join(config.diaryDir, filename);
  const tempPath = `${filePath}.tmp`;
  
  await fs.mkdir(config.diaryDir, { recursive: true });
  
  try {
    await fs.writeFile(tempPath, JSON.stringify(entry, null, 2));
    await fs.rename(tempPath, filePath);
  } catch (error) {
    try { await fs.unlink(tempPath); } catch {}
    throw error;
  }
}
