import { z } from "zod";
import {
  Config,
  DiaryEntry,
  Playbook,
  PlaybookBullet,
  PlaybookDelta,
  PlaybookDeltaSchema,
  CassHit
} from "./types.js";
import { runReflector } from "./llm.js";
import { log } from "./utils.js";

// --- Helper: Summarize Playbook for Prompt ---

export function formatBulletsForPrompt(bullets: PlaybookBullet[]): string {
  if (bullets.length === 0) return "(Playbook is empty)";

  // Group by category
  const byCategory: Record<string, PlaybookBullet[]> = {};
  for (const b of bullets) {
    const cat = b.category || "uncategorized";
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(b);
  }

  const iconFor = (maturity?: PlaybookBullet["maturity"]) => {
    if (maturity === "proven") return "★";
    if (maturity === "established") return "●";
    return "○";
  };

  let output = "";
  for (const [cat, group] of Object.entries(byCategory)) {
    output += `### ${cat}\n`;
    for (const b of group) {
      // Format: [id] Content (stats)
      const helpful = b.helpfulCount ?? 0;
      const harmful = b.harmfulCount ?? 0;
      const icon = iconFor(b.maturity);
      output += `- [${b.id}] ${icon} ${b.content} (${helpful} helpful, ${harmful} harmful)\n`;
    }
    output += "\n";
  }
  return output;
}

// --- Helper: Summarize Diary for Prompt ---

export function formatDiaryForPrompt(diary: DiaryEntry): string {
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

export function formatCassHistory(hits: CassHit[]): string {
  if (!hits || hits.length === 0) {
    return "RELATED HISTORY FROM OTHER AGENTS:\n\n(None found)";
  }
  return "RELATED HISTORY FROM OTHER AGENTS:\n\n" + hits.map(h => `
Session: ${h.source_path || (h as any).sessionPath}
Agent: ${h.agent || "unknown"}
Snippet: "${h.snippet}"
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

// Early exit logic
export function shouldExitEarly(
  iteration: number,
  deltasThisIteration: number,
  totalDeltas: number,
  config: Config
): boolean {
  if (deltasThisIteration === 0) return true;
  if (totalDeltas >= 20) return true;
  const maxIterations = config.maxReflectorIterations ?? 3;
  if (iteration >= maxIterations - 1) return true;
  return false;
}

export async function reflectOnSession(
  diary: DiaryEntry,
  playbook: Playbook,
  config: Config
): Promise<PlaybookDelta[]> {
  log(`Reflecting on diary ${diary.id}...`);

  const allDeltas: PlaybookDelta[] = [];
  const existingBullets = formatBulletsForPrompt(playbook.bullets);
  const cassHistory = await getCassHistoryForDiary(diary, config);

  const maxIterations = config.maxReflectorIterations ?? 3;

  for (let i = 0; i < maxIterations; i++) {
    log(`Reflection iteration ${i + 1}/${maxIterations}`);

    try {
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

      if (shouldExitEarly(i, uniqueDeltas.length, allDeltas.length, config)) {
        log("Ending reflection early.");
        break;
      }
    } catch (err) {
      log(`Reflection iteration ${i} failed: ${err}`);
      break;
    }
  }

  return allDeltas;
}
