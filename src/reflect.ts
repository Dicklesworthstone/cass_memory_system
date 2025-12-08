// src/reflect.ts
// Reflector Pipeline - ACE Pattern Multi-Iteration Reflection
// Extracts reusable insights from session diaries into playbook deltas

import path from "node:path";
import { z } from "zod";
import { generateObject } from "ai";
import {
  Config,
  DiaryEntry,
  CassHit,
  Playbook,
  PlaybookBullet,
  PlaybookDelta,
  PlaybookDeltaSchema,
} from "./types.js";
import { getModel, PROMPTS, fillPrompt, truncateForPrompt } from "./llm.js";
import { safeCassSearch } from "./cass.js";
import { truncate } from "./utils.js";

// ============================================================================ 
// SCHEMAS FOR LLM OUTPUT
// ============================================================================ 

/**
 * Schema for LLM reflector output - array of deltas
 */
const ReflectorOutputSchema = z.object({
  deltas: z.array(PlaybookDeltaSchema),
});

// ============================================================================ 
// HELPER FUNCTIONS
// ============================================================================ 

/**
 * Format playbook bullets for prompt context.
 * Groups by category for readability.
 */
function formatBulletsForPrompt(bullets: PlaybookBullet[]): string {
  if (bullets.length === 0) {
    return "(No existing rules in playbook)";
  }

  // Group by category
  const byCategory = new Map<string, PlaybookBullet[]>();
  for (const bullet of bullets) {
    const cat = bullet.category || "uncategorized";
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(bullet);
  }

  const lines: string[] = [];
  for (const [category, catBullets] of byCategory) {
    lines.push(`\n## ${category}`);
    for (const b of catBullets) {
      const maturity =
        b.maturity === "proven" ? "★" : b.maturity === "established" ? "●" : "○";
      lines.push(
        `[${b.id}] ${maturity} ${b.content} (${b.helpfulCount}+ / ${b.harmfulCount}-)`
      );
    }
  }

  return lines.join("\n");
}

/**
 * Format diary entry for prompt inclusion.
 */
function formatDiaryForPrompt(diary: DiaryEntry): string {
  const sections: string[] = [];

  sections.push(`## Session Overview`);
  sections.push(`- Path: ${diary.sessionPath}`);
  sections.push(`- Agent: ${diary.agent}`);
  sections.push(`- Workspace: ${diary.workspace || "unknown"}`);
  sections.push(`- Status: ${diary.status}`);
  sections.push(`- Timestamp: ${diary.timestamp}`);

  if (diary.accomplishments.length > 0) {
    sections.push(`\n## Accomplishments`);
    for (const a of diary.accomplishments) {
      sections.push(`- ${a}`);
    }
  }

  if (diary.decisions.length > 0) {
    sections.push(`\n## Decisions Made`);
    for (const d of diary.decisions) {
      sections.push(`- ${d}`);
    }
  }

  if (diary.challenges.length > 0) {
    sections.push(`\n## Challenges Encountered`);
    for (const c of diary.challenges) {
      sections.push(`- ${c}`);
    }
  }

  if (diary.keyLearnings.length > 0) {
    sections.push(`\n## Key Learnings`);
    for (const k of diary.keyLearnings) {
      sections.push(`- ${k}`);
    }
  }

  if (diary.preferences.length > 0) {
    sections.push(`\n## User Preferences`);
    for (const p of diary.preferences) {
      sections.push(`- ${p}`);
    }
  }

  return sections.join("\n");
}

/**
 * Get relevant cass history for context enrichment.
 */
async function getCassHistoryForDiary(
  diary: DiaryEntry,
  config: Config
): Promise<string> {
  // Use related sessions if available
  if (diary.relatedSessions && diary.relatedSessions.length > 0) {
    return diary.relatedSessions
      .slice(0, 5)
      .map((s) => `[${s.agent}] ${s.snippet}`)
      .join("\n\n");
  }

  // Otherwise search cass for relevant history
  const searchTerms: string[] = [];

  // Use key learnings as search seeds
  for (const learning of (diary.keyLearnings || []).slice(0, 2)) {
    const phrase = learning.split(/\s+/).slice(0, 5).join(" ");
    searchTerms.push(phrase);
  }

  // Use challenges as search seeds
  for (const challenge of (diary.challenges || []).slice(0, 2)) {
    const phrase = challenge.split(/\s+/).slice(0, 5).join(" ");
    searchTerms.push(phrase);
  }

  if (searchTerms.length === 0 && diary.workspace) {
    searchTerms.push(diary.workspace);
  }

  const historySnippets: string[] = [];
  for (const term of searchTerms.slice(0, 3)) {
    try {
      const hits = await safeCassSearch(term, {
        limit: 3,
        days: config.sessionLookbackDays,
      });

      for (const hit of hits) {
        historySnippets.push(`[${hit.agent}] ${hit.snippet}`);
      }
    } catch {
      // Ignore search failures - cass may not be available
    }
  }

  if (historySnippets.length === 0) {
    return "(No relevant history found in cass)";
  }

  return historySnippets.slice(0, 10).join("\n\n");
}

/**
 * Format Cass hits for reflector/validator prompts.
 */
export function formatCassHistory(hits: CassHit[]): string {
  const header = "RELATED HISTORY FROM OTHER AGENTS:";
  if (!hits || hits.length === 0) {
    return `${header}\n\n(None found)`;
  }

  const lines: string[] = [header, ""];
  const max = Math.min(hits.length, 5);

  for (let i = 0; i < max; i++) {
    const hit = hits[i];
    const rawPath = hit.source_path || (hit as any).sessionPath || "";
    const rel = rawPath ? path.relative(process.cwd(), rawPath) : "";
    const displayPath =
      rawPath && rel && rel.length < rawPath.length ? rel : rawPath || "unknown";
    const snippet = truncate(hit.snippet || "", 200);

    lines.push(`Session: ${displayPath}`);
    lines.push(`Agent: ${hit.agent || "unknown"}`);
    lines.push(`Snippet: "${snippet}"`);
    if (i < max - 1) lines.push("---");
  }

  return lines.join("\n");
}

// ============================================================================ 
// DEDUPLICATION
// ============================================================================ 

/**
 * Compute a hash for a delta for deduplication.
 */
function hashDelta(delta: PlaybookDelta): string {
  if (delta.type === "add") {
    return `add:${delta.bullet.content?.toLowerCase()}`;
  }
  if (delta.type === "replace") {
    return `replace:${delta.bulletId}:${delta.newContent}`;
  }
  if (delta.type === "merge") {
    return `merge:${delta.bulletIds.join(",")}`;
  }
  if (delta.type === "deprecate") {
    return `deprecate:${delta.bulletId}`;
  }
  // helpful, harmful
  return `${delta.type}:${delta.bulletId}`;
}

/**
 * Deduplicate deltas against existing ones.
 */
function deduplicateDeltas(
  newDeltas: PlaybookDelta[],
  existing: PlaybookDelta[]
): PlaybookDelta[] {
  const seen = new Set(existing.map(hashDelta));
  return newDeltas.filter((d) => {
    const h = hashDelta(d);
    if (seen.has(h)) return false;
    seen.add(h);
    return true;
  });
}

// ============================================================================ 
// EARLY EXIT LOGIC
// ============================================================================ 

/** Maximum deltas to collect before stopping iteration */
const MAX_DELTAS = 20;

/**
 * Determine if reflector should exit early (skip remaining iterations).
 * 
 * Exit conditions:
 * 1. No new deltas this iteration → LLM has exhausted insights
 * 2. Already have MAX_DELTAS (20) → Diminishing returns
 * 3. Reached maxReflectorIterations → Hard limit
 * 
 * This saves LLM calls when early iterations capture everything.
 * 
 * @param iteration - Current iteration (0-indexed)
 * @param deltasThisIteration - Number of new deltas from this iteration
 * @param totalDeltas - Total deltas accumulated so far
 * @param config - Configuration with maxReflectorIterations
 * @returns true if should stop iterating, false to continue
 * 
 * @example
 * // Iteration 0: 15 deltas → continue (false)
 * shouldExitEarly(0, 15, 15, config) // → false
 * 
 * // Iteration 1: 0 deltas → exit (true)
 * shouldExitEarly(1, 0, 15, config) // → true
 * 
 * // Iteration 0: 12 deltas, then iteration 1: 8 deltas → exit (hit max 20)
 * shouldExitEarly(1, 8, 20, config) // → true
 */
export function shouldExitEarly(
  iteration: number,
  deltasThisIteration: number,
  totalDeltas: number,
  config: Config
): boolean {
  const maxIterations = config.maxReflectorIterations ?? 3;

  // Condition 1: No new deltas this iteration - LLM has exhausted insights
  if (deltasThisIteration === 0) {
    return true;
  }

  // Condition 2: Hit max delta limit - diminishing returns
  if (totalDeltas >= MAX_DELTAS) {
    return true;
  }

  // Condition 3: Reached max iterations (note: iteration is 0-indexed)
  if (iteration >= maxIterations - 1) {
    return true;
  }

  return false;
}

// ============================================================================ 
// MAIN REFLECTION FUNCTION
// ============================================================================ 

/**
 * Multi-iteration reflection on a session diary.
 * Implements ACE pattern: Generator → Reflector → Curator → Validator
 * 
 * WHY MULTI-ITERATION: First pass catches obvious insights.
 * Subsequent passes catch nuances that might be missed.
 * 
 * @param diary - Structured diary entry from the session
 * @param playbook - Current playbook for context
 * @param config - Configuration including maxReflectorIterations
 * @returns Array of PlaybookDelta ready for curator/validator
 */
export async function reflectOnSession(
  diary: DiaryEntry,
  playbook: Playbook,
  config: Config
): Promise<PlaybookDelta[]> {
  const allDeltas: PlaybookDelta[] = [];
  const maxIterations = config.maxReflectorIterations ?? 3;

  // Prepare context
  const existingBullets = formatBulletsForPrompt(playbook.bullets);
  const diaryContext = formatDiaryForPrompt(diary);
  const cassHistory = await getCassHistoryForDiary(diary, config);

  // Multi-iteration loop
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    // Build iteration note
    let iterationNote = "";
    if (iteration === 0) {
      iterationNote =
        "This is the FIRST pass. Focus on obvious, high-value insights.";
    } else if (allDeltas.length > 0) {
      const previousSummary = allDeltas
        .map((d: PlaybookDelta) => {
          if (d.type === "add") return `- ADD: ${d.bullet.content.slice(0, 60)}...`;
          if (d.type === "helpful") return `- HELPFUL: bullet ${d.bulletId}`;
          if (d.type === "harmful") return `- HARMFUL: bullet ${d.bulletId}`;
          if (d.type === "replace") return `- REPLACE: bullet ${d.bulletId}`;
          if (d.type === "deprecate") return `- DEPRECATE: bullet ${d.bulletId}`;
          if (d.type === "merge") return `- MERGE: bullets ${d.bulletIds.join(", ")}`;
          return `- ${(d as PlaybookDelta).type.toUpperCase()}`;
        })
        .join("\n");

      iterationNote = `This is iteration ${iteration + 1}. Previous passes found:
${previousSummary}

Now look DEEPER. What subtle patterns did we miss? What edge cases? What nuances?
Don't repeat what's already captured.`;
    }

    // Build prompt
    const prompt = fillPrompt(PROMPTS.reflector, {
      existingBullets,
      diary: diaryContext,
      cassHistory: truncateForPrompt(cassHistory, 10000),
      iterationNote,
    });

    try {
      // Cast to explicit type for getModel
      const modelConfig = {
        provider: config.provider,
        model: config.model,
        apiKey: config.apiKey
      };
      const model = getModel(modelConfig);

      const { object } = await generateObject({
        model,
        schema: ReflectorOutputSchema,
        prompt,
        temperature: 0.4, // Moderate creativity for insight generation
      });

      // Normalize deltas - inject sourceSession for add deltas
      const validDeltas = object.deltas.map((d: PlaybookDelta) => {
        if (d.type === "add") {
          return { ...d, sourceSession: diary.sessionPath };
        }
        if (
          (d.type === "helpful" || d.type === "harmful") &&
          !d.sourceSession
        ) {
          return { ...d, sourceSession: diary.sessionPath };
        }
        return d;
      });

      // Deduplicate against what we've already found
      const uniqueDeltas = deduplicateDeltas(validDeltas, allDeltas);
      allDeltas.push(...uniqueDeltas);

      // Check for early exit using centralized logic
      if (shouldExitEarly(iteration, uniqueDeltas.length, allDeltas.length, config)) {
        break;
      }
    } catch (error) {
      console.error(`[reflect] LLM call failed on iteration ${iteration}: ${error}`);
      // Continue to next iteration or exit if first
      if (iteration === 0) {
        return [];
      }
      break;
    }
  }

  return allDeltas;
}

// ============================================================================ 
// EXPORTS
// ============================================================================ 

export {
  formatBulletsForPrompt,
  formatDiaryForPrompt,
  getCassHistoryForDiary,
  deduplicateDeltas,
  hashDelta,
};