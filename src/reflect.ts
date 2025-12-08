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

  // Group by category
  const byCategory: Record<string, PlaybookBullet[]> = {};
  for (const b of bullets) {
    if (!byCategory[b.category]) byCategory[b.category] = [];
    byCategory[b.category].push(b);
  }

  let output = "";
  for (const [cat, group] of Object.entries(byCategory)) {
    output += `### ${cat}\n`;
    for (const b of group) {
      // Format: [id] Content (stats)
      output += `- [${b.id}] ${b.content} (${b.helpfulCount} helpful, ${b.harmfulCount} harmful)\n`;
    }
    output += "\n";
  }
  return output;
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
