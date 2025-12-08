import { z } from 'zod';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Config, DiaryEntry, RelatedSession, DiaryEntrySchema } from './types.js';
import { extractDiary } from './llm.js';
import { getSanitizeConfig } from './config.js';
import { sanitize } from './security.js';
import { extractAgentFromPath, expandPath, ensureDir } from './utils.js';
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
  const rawContent = await exportSessionSafe(sessionPath, config.cassPath);
  
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

async function exportSessionSafe(sessionPath: string, cassPath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(cassPath, ['export', sessionPath, '--format', 'markdown'], {
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
  const diaryDir = expandPath(config.diaryDir);
  const filePath = path.join(diaryDir, filename);
  const tempPath = `${filePath}.tmp`;
  
  await ensureDir(diaryDir);
  
  try {
    await fs.writeFile(tempPath, JSON.stringify(entry, null, 2));
    await fs.rename(tempPath, filePath);
  } catch (error) {
    try { await fs.unlink(tempPath); } catch {}
    throw error;
  }
}

// --- Statistics ---

export function computeDiaryStats(diaries: DiaryEntry[]): {
  total: number;
  byStatus: Record<string, number>;
  byAgent: Record<string, number>;
  avgChallenges: number;
  avgLearnings: number;
  topTags: Array<{ tag: string; count: number }>;
  successRate: number;
} {
  const byStatus: Record<string, number> = {};
  const byAgent: Record<string, number> = {};
  const tagCounts: Record<string, number> = {};

  let totalChallenges = 0;
  let totalLearnings = 0;
  let successCount = 0;

  for (const diary of diaries) {
    byStatus[diary.status] = (byStatus[diary.status] || 0) + 1;
    byAgent[diary.agent] = (byAgent[diary.agent] || 0) + 1;

    totalChallenges += diary.challenges?.length ?? 0;
    totalLearnings += diary.keyLearnings?.length ?? 0;

    if (diary.status === "success") successCount++;

    for (const tag of diary.tags ?? []) {
      tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    }
  }

  const total = diaries.length;
  const avgChallenges = total === 0 ? 0 : totalChallenges / total;
  const avgLearnings = total === 0 ? 0 : totalLearnings / total;
  const successRate = total === 0 ? 0 : (successCount / total) * 100;

  const topTags = Object.entries(tagCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([tag, count]) => ({ tag, count }));

  return {
    total,
    byStatus,
    byAgent,
    avgChallenges,
    avgLearnings,
    topTags,
    successRate,
  };
}
