import { z } from "zod";
import {
  Config,
  DiaryEntry,
  Playbook,
  PlaybookBullet,
  PlaybookDelta,
  PlaybookDeltaSchema,
  CassHit,
  AddDeltaSchema
} from "./types.js";
import { runReflector } from "./llm.js";
import { safeCassSearch } from "./cass.js";
import { log } from "./utils.js";

// --- Helper: Summarize Playbook for Prompt ---

export function formatBulletsForPrompt(bullets: PlaybookBullet[]): string {
  if (bullets.length === 0) return "(Playbook is empty)";

  // Group bullets by category for readability
  const byCategory: Record<string, PlaybookBullet[]> = {};
  for (const bullet of bullets) {
    const cat = bullet.category || "uncategorized";
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(bullet);
  }

  const iconForMaturity = (maturity?: PlaybookBullet["maturity"]) => {
    if (maturity === "proven") return "★";
    if (maturity === "established") return "●";
    return "○"; // candidate or default
  };

  let output = "";
  for (const [category, list] of Object.entries(byCategory)) {
    output += `### ${category}\n`;
    for (const b of list) {
      const icon = iconForMaturity(b.maturity);
      const helpful = b.helpfulCount ?? 0;
      const harmful = b.harmfulCount ?? 0;
      output += `- [${b.id}] ${icon} ${b.content} (${helpful} helpful, ${harmful} harmful)\n`;
    }
    output += "\n";
  }

  return output.trim();
}

export function formatDiaryForPrompt(diary: DiaryEntry): string {
  // ... (implementation)
  const lines = [];
  lines.push(`## Session Overview`);
  lines.push(`- Path: ${diary.sessionPath}`);
  lines.push(`- Agent: ${diary.agent}`);
  lines.push(`- Workspace: ${diary.workspace || "unknown"}`);
  lines.push(`- Status: ${diary.status}`);
  lines.push(`- Timestamp: ${diary.timestamp}`);

  if (diary.accomplishments && diary.accomplishments.length > 0) {
    lines.push(`\n## Accomplishments`);
    diary.accomplishments.forEach(a => lines.push(`- ${a}`));
  }

  if (diary.decisions && diary.decisions.length > 0) {
    lines.push(`\n## Decisions Made`);
    diary.decisions.forEach(d => lines.push(`- ${d}`));
  }

  if (diary.challenges && diary.challenges.length > 0) {
    lines.push(`\n## Challenges Encountered`);
    diary.challenges.forEach(c => lines.push(`- ${c}`));
  }

  if (diary.keyLearnings && diary.keyLearnings.length > 0) {
    lines.push(`\n## Key Learnings`);
    diary.keyLearnings.forEach(k => lines.push(`- ${k}`));
  }

  if (diary.preferences && diary.preferences.length > 0) {
    lines.push(`\n## User Preferences`);
    diary.preferences.forEach(p => lines.push(`- ${p}`));
  }

  return lines.join("\n");
}

export function formatCassHistory(hits: CassHit[]): string {
  if (!hits || hits.length === 0) {
    return "RELATED HISTORY FROM OTHER AGENTS:\n\n(None found)";
  }

  const maxHits = 5;
  const truncate = (text: string, max = 200) =>
    text.length > max ? `${text.slice(0, max)}…` : text;

  const formatted = hits.slice(0, maxHits).map((h) => {
    const snippet = truncate(h.snippet || "");
    const agent = h.agent || "unknown";
    const path = (h as any).sessionPath || h.source_path || "unknown";
    return `Session: ${path}\nAgent: ${agent}\nSnippet: "${snippet}"\n---`;
  });

  return "RELATED HISTORY FROM OTHER AGENTS:\n\n" + formatted.join("\n");
}

// --- Helper: Context Gathering ---

async function getCassHistoryForDiary(
  diary: DiaryEntry,
  config: Config
): Promise<string> {
  if (!diary.relatedSessions || diary.relatedSessions.length === 0) {
    return "(No related history found)";
  }

  // Format top 3 related sessions
  return diary.relatedSessions.slice(0, 3).map(s => `
Session: ${s.sessionPath}
Agent: ${s.agent}
Snippet: ${s.snippet}
---`).join("\n");
}

// --- Helper: Deduplication ---

export function hashDelta(delta: PlaybookDelta): string {
  if (delta.type === "add") return `add:${delta.bullet.content?.toLowerCase()}`;
  if (delta.type === "replace") return `replace:${delta.bulletId}:${delta.newContent}`;
  
  // Only types with bulletId fall through here
  if ("bulletId" in delta) {
    return `${delta.type}:${delta.bulletId}`;
  }
  
  // Merge delta handling
  if (delta.type === "merge") {
    return `merge:${delta.bulletIds.sort().join(",")}`;
  }
  
  return JSON.stringify(delta);
}

export function deduplicateDeltas(newDeltas: PlaybookDelta[], existing: PlaybookDelta[]): PlaybookDelta[] {
  const seen = new Set(existing.map(hashDelta));
  return newDeltas.filter(d => {
    const h = hashDelta(d);
    if (seen.has(h)) return false;
    seen.add(h);
    return true;
  });
}

// --- Main Reflector ---

// Schema for the LLM output - array of deltas
const ReflectorOutputSchema = z.object({
  deltas: z.array(PlaybookDeltaSchema)
});

export async function reflectOnSession(
  diary: DiaryEntry,
  playbook: Playbook,
  config: Config
): Promise<PlaybookDelta[]> {
  log(`Reflecting on diary ${diary.id}...`);

  const allDeltas: PlaybookDelta[] = [];
  const existingBullets = formatBulletsForPrompt(playbook.bullets);
  const cassHistory = await getCassHistoryForDiary(diary, config);

  for (let i = 0; i < config.maxReflectorIterations; i++) {
    log(`Reflection iteration ${i + 1}/${config.maxReflectorIterations}`);

    const output = await runReflector(
      ReflectorOutputSchema,
      diary,
      existingBullets,
      cassHistory,
      i,
      config
    );

    const validDeltas = output.deltas.map(d => {
      if (d.type === "add") {
        // Force sourceSession injection
        return { ...d, sourceSession: diary.sessionPath };
      }
      if ((d.type === "helpful" || d.type === "harmful") && !d.sourceSession) {
        return { ...d, sourceSession: diary.sessionPath };
      }
      return d;
    });

    const uniqueDeltas = deduplicateDeltas(validDeltas, allDeltas);
    allDeltas.push(...uniqueDeltas);

    // Early exit if no new insights
    if (uniqueDeltas.length === 0) {
      log("No new insights found, ending reflection.");
      break;
    }
    
    if (allDeltas.length >= 20) {
      log("Hit max delta limit (20), ending reflection.");
      break;
    }
  }

  return allDeltas;
}
