import { z } from "zod";
import {
  Config,
  DiaryEntry,
  Playbook,
  PlaybookBullet,
  PlaybookDelta,
  // Import individual schemas to construct LLM-specific loose schema
  AddDeltaSchema,
  HelpfulDeltaSchema,
  HarmfulDeltaSchema,
  ReplaceDeltaSchema,
  DeprecateDeltaSchema,
  MergeDeltaSchema,
  CassHit,
  DecisionLogEntry,
  KnowledgeDelta,
  KnowledgePageAppendDelta,
  DigestUpdateDelta,
  TopicSuggestionDelta,
  Topic,
  type ReflectorCall1Output,
  type ReflectorCall2Output,
} from "./types.js";
import { runReflector, runReflectorCall1, runReflectorCall2, type LLMIO } from "./llm.js";
import { log, now, hashContent, generateBulletId } from "./utils.js";

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
      const maturity = iconFor(b.maturity);
      // Format: [id] Content (stats)
      output += `- [${b.id}] ${maturity} ${b.content} (${b.helpfulCount}+ / ${b.harmfulCount}-)\n`;
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
  // Normalize content for hashing to prevent duplicates differing only by case/whitespace
  const normalize = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

  if (delta.type === "add") {
    // Category differences shouldn't allow duplicate rule content to re-enter the system.
    return `add:${hashContent(delta.bullet.content)}`;
  }
  if (delta.type === "replace") {
    return `replace:${delta.bulletId}:${normalize(delta.newContent)}`;
  }
  
  // Only types with bulletId fall through here
  if ("bulletId" in delta) {
    return `${delta.type}:${delta.bulletId}`;
  }
  
  // Merge delta handling
  if (delta.type === "merge") {
    return `merge:${[...delta.bulletIds].sort().join(",")}`;
  }
  
  // Fallback for unexpected types
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

// Define a loose schema for LLM output where sourceSession is optional for 'add' deltas.
// We will inject sourceSession systematically in the code, saving tokens and reducing validation errors.
const LLMAddDeltaSchema = AddDeltaSchema.extend({
  sourceSession: z.string().optional()
});

const LLMPlaybookDeltaSchema = z.discriminatedUnion("type", [
  LLMAddDeltaSchema,
  HelpfulDeltaSchema,
  HarmfulDeltaSchema,
  ReplaceDeltaSchema,
  DeprecateDeltaSchema,
  MergeDeltaSchema,
]);

// Schema for the LLM output - array of deltas
const ReflectorOutputSchema = z.object({
  deltas: z.array(LLMPlaybookDeltaSchema)
});

// Early exit logic
export function shouldExitEarly(
  iteration: number,
  deltasThisIteration: number,
  totalDeltas: number,
  config: Config
): boolean {
  if (deltasThisIteration === 0) return true;
  if (totalDeltas >= 50) return true;
  const maxIterations = config.maxReflectorIterations ?? 3;
  if (iteration >= maxIterations - 1) return true;
  return false;
}

export interface ReflectionResult {
  deltas: PlaybookDelta[];
  decisionLog: DecisionLogEntry[];
}

export async function reflectOnSession(
  diary: DiaryEntry,
  playbook: Playbook,
  config: Config,
  io?: LLMIO
): Promise<ReflectionResult> {
  log(`Reflecting on diary ${diary.id}...`);

  // Stubbed flow for subprocess E2E tests: CM_REFLECTOR_STUBS contains an array
  // of { deltas } objects. This is only checked when `io` is NOT provided,
  // since unit/integration tests should pass a mock LLMIO directly.
  if (!io) {
    const stubEnv = process.env.CM_REFLECTOR_STUBS;
    if (stubEnv) {
      try {
        const stubIterations: { deltas: PlaybookDelta[] }[] = JSON.parse(stubEnv);
        const collected: PlaybookDelta[] = [];

        for (const iteration of stubIterations) {
          const injected = iteration.deltas.map((d) => {
            if (d.type === "add") return { ...d, sourceSession: diary.sessionPath };
            if ((d.type === "helpful" || d.type === "harmful") && !d.sourceSession) {
              return { ...d, sourceSession: diary.sessionPath };
            }
            return d;
          });
          collected.push(...injected);
        }

        return {
          deltas: deduplicateDeltas(collected, []),
          decisionLog: []
        };
      } catch (err) {
        log(`Failed to parse CM_REFLECTOR_STUBS: ${err instanceof Error ? err.message : String(err)}`);
        // fall through to real flow
      }
    }
  }

  const allDeltas: PlaybookDelta[] = [];
  const decisionLog: DecisionLogEntry[] = [];
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
        config,
        io
      );

      const validDeltas: PlaybookDelta[] = output.deltas.map(d => {
        if (d.type === "add") {
          // Force sourceSession injection
          return { ...d, sourceSession: diary.sessionPath } as PlaybookDelta;
        }
        if ((d.type === "helpful" || d.type === "harmful") && !d.sourceSession) {
          return { ...d, sourceSession: diary.sessionPath } as PlaybookDelta;
        }
        return d as PlaybookDelta;
      });

      const uniqueDeltas = deduplicateDeltas(validDeltas, allDeltas);
      const duplicatesRemoved = validDeltas.length - uniqueDeltas.length;

      decisionLog.push({
        timestamp: now(),
        phase: "add",
        action: uniqueDeltas.length > 0 ? "accepted" : "skipped",
        reason: `Iteration ${i + 1}: ${uniqueDeltas.length} unique deltas (${duplicatesRemoved} duplicates removed)`,
        details: {
          iteration: i + 1,
          generatedCount: validDeltas.length,
          uniqueCount: uniqueDeltas.length,
          duplicatesRemoved
        }
      });

      allDeltas.push(...uniqueDeltas);

      if (shouldExitEarly(i, uniqueDeltas.length, allDeltas.length, config)) {
        decisionLog.push({
          timestamp: now(),
          phase: "add",
          action: "skipped",
          reason: `Early exit at iteration ${i + 1}: ${uniqueDeltas.length === 0 ? 'no new deltas' : `reached ${allDeltas.length} total deltas`}`,
          details: { iteration: i + 1, totalDeltas: allDeltas.length }
        });
        log("Ending reflection early.");
        break;
      }
    } catch (err) {
      decisionLog.push({
        timestamp: now(),
        phase: "add",
        action: "rejected",
        reason: `Iteration ${i + 1} failed: ${err instanceof Error ? err.message : String(err)}`,
        details: { iteration: i + 1, error: String(err) }
      });
      log(`Reflection iteration ${i + 1} failed: ${err}`);
      break;
    }
  }

  return { deltas: allDeltas, decisionLog };
}

// ============================================================================
// PHASE 3: TWO-CALL REFLECTOR
// ============================================================================

export interface TwoCallReflectionResult {
  playbookDeltas: PlaybookDelta[];
  knowledgeDeltas: KnowledgeDelta[];
  decisionLog: DecisionLogEntry[];
  call1Output: ReflectorCall1Output | null;
}

/**
 * Format topics for the reflector prompt.
 */
export function formatTopicsForPrompt(topics: Topic[]): string {
  if (topics.length === 0) return "(No topics defined yet)";

  function formatTopic(t: Topic): string[] {
    const lines = [`  - ${t.slug}: ${t.name} — ${t.description}`];
    if (t.subpages && t.subpages.length > 0) {
      lines.push(`    Sub-pages:`);
      for (const sp of t.subpages) {
        lines.push(`      - ${sp.slug}: ${sp.name} — ${sp.description}`);
      }
    }
    return lines;
  }

  const userTopics = topics.filter(t => t.source === "user");
  const systemTopics = topics.filter(t => t.source === "system");
  const lines: string[] = [];
  if (userTopics.length > 0) {
    lines.push("User-defined topics (PREFERRED — always route to these when content fits):");
    for (const t of userTopics) lines.push(...formatTopic(t));
  }
  if (systemTopics.length > 0) {
    lines.push("System-suggested topics:");
    for (const t of systemTopics) lines.push(...formatTopic(t));
  }
  return lines.join("\n");
}

/**
 * Phase 3 two-call reflector. Replaces the single-call iterative loop.
 *
 * Call 1: structural/extractive — diary + topics + playbook → bullets + topic suggestions
 * Call 2: generative/narrative — diary + session note + knowledge pages → knowledge sections + digest
 *
 * Returns both PlaybookDelta[] (for bullet curation) and KnowledgeDelta[] (for knowledge curation).
 */
export async function reflectOnSessionTwoCalls(
  diary: DiaryEntry,
  sessionNoteBody: string,
  playbook: Playbook,
  existingTopics: Topic[],
  knowledgePageContent: string,
  sessionId: string,
  config: Config,
  io?: LLMIO
): Promise<TwoCallReflectionResult> {
  log(`Reflecting (two-call) on diary ${diary.id}...`);

  const decisionLog: DecisionLogEntry[] = [];
  const playbookDeltas: PlaybookDelta[] = [];
  const knowledgeDeltas: KnowledgeDelta[] = [];
  let call1Output: ReflectorCall1Output | null = null;

  // ── Call 1: Structural/Extractive ──────────────────────────────────

  try {
    const existingBullets = formatBulletsForPrompt(playbook.bullets);
    const topicsText = formatTopicsForPrompt(existingTopics);

    call1Output = await runReflectorCall1(
      diary,
      topicsText,
      existingBullets,
      config,
      io
    );

    // Convert Call 1 bullets → PlaybookDelta "add" deltas
    for (const bullet of call1Output.bullets || []) {
      playbookDeltas.push({
        type: "add" as const,
        bullet: {
          content: bullet.content,
          scope: bullet.scope,
          category: bullet.category,
          type: bullet.type,
          kind: bullet.kind,
        },
        sourceSession: diary.sessionPath,
      });
    }

    // Convert Call 1 feedback → PlaybookDelta "helpful"/"harmful" deltas
    for (const fb of call1Output.feedback || []) {
      if (fb.type === "helpful") {
        playbookDeltas.push({
          type: "helpful" as const,
          bulletId: fb.bulletId,
          sourceSession: diary.sessionPath,
          context: fb.reasoning,
        });
      } else {
        playbookDeltas.push({
          type: "harmful" as const,
          bulletId: fb.bulletId,
          sourceSession: diary.sessionPath,
          reason: "other" as const,
          context: fb.reasoning,
        });
      }
    }

    // Convert Call 1 topic suggestions → TopicSuggestionDelta
    for (const ts of call1Output.topic_suggestions || []) {
      knowledgeDeltas.push({
        type: "topic_suggestion" as const,
        slug: ts.slug,
        name: ts.name,
        description: ts.description,
        suggested_from_session: sessionId,
      });
    }

    // Dedup playbook deltas
    const uniquePlaybook = deduplicateDeltas(playbookDeltas, []);
    const dupsRemoved = playbookDeltas.length - uniquePlaybook.length;
    playbookDeltas.length = 0;
    playbookDeltas.push(...uniquePlaybook);

    decisionLog.push({
      timestamp: now(),
      phase: "add",
      action: "accepted",
      reason: `Call 1: ${(call1Output.bullets || []).length} bullets proposed (${dupsRemoved} deduped), ${(call1Output.feedback || []).length} feedback, ${(call1Output.topic_suggestions || []).length} topic suggestions`,
      details: {
        bulletsProposed: (call1Output.bullets || []).length,
        feedbackProposed: (call1Output.feedback || []).length,
        topicSuggestionsProposed: (call1Output.topic_suggestions || []).length,
        duplicatesRemoved: dupsRemoved,
      },
    });
  } catch (err) {
    decisionLog.push({
      timestamp: now(),
      phase: "add",
      action: "rejected",
      reason: `Call 1 failed: ${err instanceof Error ? err.message : String(err)}`,
      details: { error: String(err) },
    });
    log(`Reflector Call 1 failed: ${err}`);
    // Call 2 can still run — it doesn't depend on Call 1's output
  }

  // ── Call 2: Generative/Narrative ───────────────────────────────────

  try {
    // Only use existing approved topics — don't include suggestions from Call 1.
    // Topic suggestions go to the review queue; knowledge pages are only
    // written for topics the user has explicitly created or approved.
    const availableTopics = [...existingTopics];

    // Cold start fallback: if no topics exist at all, use a general catch-all
    if (availableTopics.length === 0) {
      availableTopics.push({
        slug: "general",
        name: "General",
        description: "Catch-all topic for knowledge that doesn't fit a specific category",
        source: "system" as const,
        created: now(),
      });
    }

    const availableTopicsText = formatTopicsForPrompt(availableTopics);

    const call2Output = await runReflectorCall2(
      diary,
      sessionNoteBody,
      knowledgePageContent,
      availableTopicsText,
      sessionId,
      config,
      io
    );

    // Convert Call 2 page updates → KnowledgePageUpdateDelta
    const pageUpdates = call2Output.page_updates || [];
    for (const update of pageUpdates) {
      knowledgeDeltas.push({
        type: "knowledge_page_update" as const,
        topic_slug: update.topic_slug,
        sub_page: update.sub_page || "_index",
        revised_content: update.revised_content,
        source_session: sessionId,
        updated_date: now().split("T")[0],
        contradictions: update.contradictions || [],
      });
    }

    // Convert Call 2 digest → DigestUpdateDelta
    if (call2Output.digest_content && call2Output.digest_content.trim().length > 0) {
      const today = new Date().toISOString().split("T")[0];
      knowledgeDeltas.push({
        type: "digest_update" as const,
        date: today,
        content: call2Output.digest_content,
        sessions_covered: [sessionId],
      });
    }

    decisionLog.push({
      timestamp: now(),
      phase: "add",
      action: "accepted",
      reason: `Call 2: ${pageUpdates.length} page updates, digest ${call2Output.digest_content ? "generated" : "empty"}`,
      details: {
        pagesUpdated: pageUpdates.length,
        digestGenerated: !!call2Output.digest_content,
        topicsCovered: [...new Set(pageUpdates.map(u => u.topic_slug))],
        contradictionsFlagged: pageUpdates.reduce((sum, u) => sum + (u.contradictions?.length || 0), 0),
      },
    });
  } catch (err) {
    decisionLog.push({
      timestamp: now(),
      phase: "add",
      action: "rejected",
      reason: `Call 2 failed: ${err instanceof Error ? err.message : String(err)}`,
      details: { error: String(err) },
    });
    log(`Reflector Call 2 failed: ${err}`);
  }

  return { playbookDeltas, knowledgeDeltas, decisionLog, call1Output };
}
