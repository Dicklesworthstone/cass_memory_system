import { z } from "zod";
import {
  Config,
  DiaryEntry,
  Playbook,
  PlaybookBullet,
  PlaybookDelta,
  HarmfulReasonEnum,
  BulletScopeEnum,
  BulletTypeEnum,
  BulletKindEnum,
  CassHit,
  DecisionLogEntry
} from "./types.js";
import { runReflector, type LLMIO } from "./llm.js";
import { log, now, hashContent } from "./utils.js";

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

// OpenAI strict-mode requirements (issue #44):
//   - every property in each object must appear in the `required` array
//   - optional fields must use a null union (`.nullable()`, not `.optional()`)
//   - every object must set `additionalProperties: false` (via `.strict()`)
//   - discriminated unions translate to `anyOf` and each variant must comply
// The internal `PlaybookBullet` model has ~30 tracking fields (timestamps,
// counters, embeddings, …) that are filled in by `addBullet()` at persistence
// time, not by the LLM. We therefore expose a minimal, strict-compliant
// LLM-facing schema here and let the downstream code enrich it. Field list
// mirrors what curate.ts consumes from `delta.bullet`.
const LLMNewBulletSchema = z.object({
  content: z.string(),
  category: z.string(),
  kind: BulletKindEnum.nullable(),
  type: BulletTypeEnum.nullable(),
  isNegative: z.boolean().nullable(),
  scope: BulletScopeEnum.nullable(),
  workspace: z.string().nullable(),
  searchPointer: z.string().nullable(),
  tags: z.array(z.string()).nullable()
}).strict();

const LLMAddDeltaSchema = z.object({
  type: z.literal("add"),
  bullet: LLMNewBulletSchema,
  reason: z.string(),
  // sourceSession is injected by reflectOnSession() after the LLM responds,
  // but strict mode requires the property to be present in the schema's
  // `required` list. We accept null here and overwrite post-hoc.
  sourceSession: z.string().nullable()
}).strict();

const LLMHelpfulDeltaSchema = z.object({
  type: z.literal("helpful"),
  bulletId: z.string(),
  sourceSession: z.string().nullable(),
  context: z.string().nullable()
}).strict();

const LLMHarmfulDeltaSchema = z.object({
  type: z.literal("harmful"),
  bulletId: z.string(),
  sourceSession: z.string().nullable(),
  reason: HarmfulReasonEnum.nullable(),
  context: z.string().nullable()
}).strict();

const LLMReplaceDeltaSchema = z.object({
  type: z.literal("replace"),
  bulletId: z.string(),
  newContent: z.string(),
  reason: z.string().nullable()
}).strict();

const LLMDeprecateDeltaSchema = z.object({
  type: z.literal("deprecate"),
  bulletId: z.string(),
  reason: z.string(),
  replacedBy: z.string().nullable()
}).strict();

const LLMMergeDeltaSchema = z.object({
  type: z.literal("merge"),
  bulletIds: z.array(z.string()),
  mergedContent: z.string(),
  reason: z.string().nullable()
}).strict();

const LLMPlaybookDeltaSchema = z.discriminatedUnion("type", [
  LLMAddDeltaSchema,
  LLMHelpfulDeltaSchema,
  LLMHarmfulDeltaSchema,
  LLMReplaceDeltaSchema,
  LLMDeprecateDeltaSchema,
  LLMMergeDeltaSchema,
]);

// Schema for the LLM output - array of deltas
const ReflectorOutputSchema = z.object({
  deltas: z.array(LLMPlaybookDeltaSchema)
}).strict();

type LLMReflectorDelta = z.infer<typeof LLMPlaybookDeltaSchema>;

/**
 * Normalize an LLM-produced delta (strict schema with nullable fields) to a
 * domain `PlaybookDelta`. Null LLM values collapse to `undefined` so they
 * stop being serialized and match the domain's `.optional()` contract.
 * `sourceSession` on "add" is always rewritten by the caller, so we pass a
 * placeholder here and let `reflectOnSession` overwrite it.
 */
function normalizeLLMDelta(d: LLMReflectorDelta, sessionPath: string): PlaybookDelta {
  switch (d.type) {
    case "add":
      return {
        type: "add",
        bullet: {
          content: d.bullet.content,
          category: d.bullet.category,
          ...(d.bullet.kind !== null ? { kind: d.bullet.kind } : {}),
          ...(d.bullet.type !== null ? { type: d.bullet.type } : {}),
          ...(d.bullet.isNegative !== null ? { isNegative: d.bullet.isNegative } : {}),
          ...(d.bullet.scope !== null ? { scope: d.bullet.scope } : {}),
          ...(d.bullet.workspace !== null ? { workspace: d.bullet.workspace } : {}),
          ...(d.bullet.searchPointer !== null ? { searchPointer: d.bullet.searchPointer } : {}),
          ...(d.bullet.tags !== null ? { tags: d.bullet.tags } : {}),
        },
        reason: d.reason,
        sourceSession: d.sourceSession ?? sessionPath
      };
    case "helpful":
      return {
        type: "helpful",
        bulletId: d.bulletId,
        sourceSession: d.sourceSession ?? sessionPath,
        ...(d.context !== null ? { context: d.context } : {})
      };
    case "harmful":
      return {
        type: "harmful",
        bulletId: d.bulletId,
        sourceSession: d.sourceSession ?? sessionPath,
        ...(d.reason !== null ? { reason: d.reason } : {}),
        ...(d.context !== null ? { context: d.context } : {})
      };
    case "replace":
      return {
        type: "replace",
        bulletId: d.bulletId,
        newContent: d.newContent,
        ...(d.reason !== null ? { reason: d.reason } : {})
      };
    case "deprecate":
      return {
        type: "deprecate",
        bulletId: d.bulletId,
        reason: d.reason,
        ...(d.replacedBy !== null ? { replacedBy: d.replacedBy } : {})
      };
    case "merge":
      return {
        type: "merge",
        bulletIds: d.bulletIds,
        mergedContent: d.mergedContent,
        ...(d.reason !== null ? { reason: d.reason } : {})
      };
  }
}

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

      // `output.deltas` are strict-mode LLM deltas (see issue #44) — null
      // fields must be collapsed to `undefined` before curation. "add" deltas
      // always get `sourceSession` injected from the diary, overriding any
      // value the LLM may have supplied.
      const validDeltas: PlaybookDelta[] = output.deltas.map(d =>
        normalizeLLMDelta(d, diary.sessionPath)
      );

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
