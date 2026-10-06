import { addBullet, deprecateBullet, findBullet } from "./playbook.js";
import { checkForDemotion, checkForPromotion, getDecayedCounts } from "./scoring.js";
import { cosineSimilarity, type SemanticDedupIndex } from "./semantic.js";
import type {
  Config,
  CurationResult,
  DecisionLogEntry,
  InversionReport,
  Playbook,
  PlaybookBullet,
  PlaybookDelta,
} from "./types.js";
import {
  generateBulletId,
  hashContent,
  jaccardSimilarity,
  jaccardSimilaritySets,
  log,
  STOP_WORDS,
  stemToken,
  now,
  tokenize,
} from "./utils.js";

function findSimilarBulletFromMeta(
  newTokens: Set<string>,
  metaList: ConflictMeta[],
  threshold: number,
  newClauses: DirectiveClause[],
): PlaybookBullet | undefined {
  let bestDeprecated: PlaybookBullet | undefined;

  for (const meta of metaList) {
    const b = meta.bullet;
    // "Mock the database in unit tests" and "Never mock the database in unit
    // tests" share 6 of 7 tokens; word overlap alone would merge them.
    if (directivesDisagree(newClauses, meta.clauses)) continue;
    const isDeprecated =
      Boolean(b.deprecated) || b.maturity === "deprecated" || b.state === "retired";

    // Fast skip based on size difference
    // Jaccard = intersection / union.
    // Max intersection = min(A, B). Min union = max(A, B).
    // Max Jaccard = min(A, B) / max(A, B).
    const sizeA = newTokens.size;
    const sizeB = meta.tokens.size;
    if (sizeA === 0 && sizeB === 0) return b; // Both empty = match
    if (sizeA === 0 || sizeB === 0) continue; // One empty = 0 similarity

    const maxPossible = Math.min(sizeA, sizeB) / Math.max(sizeA, sizeB);
    if (maxPossible < threshold) continue;

    const sim = jaccardSimilaritySets(newTokens, meta.tokens);
    if (sim >= threshold) {
      if (!isDeprecated) {
        return b; // Return active match immediately (priority)
      }
      if (!bestDeprecated) {
        bestDeprecated = b; // Save deprecated match as fallback
      }
    }
  }

  return bestDeprecated;
}

// --- Helper: Conflict Detection ---
//
// Rules are compared clause by clause. A rule such as "Set explicit timeouts on
// HTTP calls; never rely on defaults" makes two directives with different
// polarity, and judging the rule as one bag of words (any "never" anywhere ->
// negative) flagged it against every timeout rule. Each clause gets its own
// polarity and topic (content words minus stop words and directive markers);
// two rules conflict only when an affirming and a negating clause, or an
// "always" and an "except/unless" clause, share most of their topic.

const NEGATIVE_MARKERS = [
  "never",
  "dont",
  "don't",
  "do not",
  "does not",
  "must not",
  "should not",
  "shouldn't",
  "mustn't",
  "avoid",
  "forbid",
  "forbidden",
  "disable",
  "prevent",
  "stop",
  "skip",
  "no longer",
];
const POSITIVE_MARKERS = ["always", "must", "required", "ensure", "use", "enable", "prefer"];
const EXCEPTION_MARKERS = ["unless", "except", "only if", "only when", "except when"];

/** Directive and filler words that say how strongly, not what about. */
const DIRECTIVE_WORDS = new Set([
  "always",
  "never",
  "must",
  "should",
  "shall",
  "required",
  "require",
  "ensure",
  "use",
  "using",
  "used",
  "prefer",
  "enable",
  "disable",
  "avoid",
  "forbid",
  "forbidden",
  "prevent",
  "stop",
  "skip",
  "dont",
  "don",
  "do",
  "does",
  "not",
  "no",
  "longer",
  "unless",
  "except",
  "only",
  "when",
  "if",
  "make",
  "sure",
]);

/** Minimum shared topic words, and shared fraction of the smaller topic, for two clauses to be about the same thing. */
const CONFLICT_MIN_SHARED = 2;
const CONFLICT_MIN_OVERLAP = 0.5;

function hasMarker(text: string, markers: string[]): boolean {
  // Use word boundaries to avoid substring matches (e.g., "use" matching "user")
  const lower = text.toLowerCase();
  return markers.some((m) => new RegExp(`\\b${m}\\b`, "i").test(lower));
}

type ClausePolarity = "negative" | "positive" | "neutral";

interface DirectiveClause {
  polarity: ClausePolarity;
  exception: boolean;
  topic: Set<string>;
}

/** Split a rule into directive clauses: sentence ends, semicolons, and "but"/"however". */
export function splitDirectiveClauses(content: string): DirectiveClause[] {
  return content
    .split(/[;!?\n]+|\.(?=\s|$)|\s[-\u2013\u2014]\s|\bbut\b|\bhowever\b/i)
    .map((c) => c.trim())
    .filter((c) => c.length > 0)
    .map((clause) => {
      const negative = hasMarker(clause, NEGATIVE_MARKERS);
      const positive = !negative && hasMarker(clause, POSITIVE_MARKERS);
      const topic = new Set(
        tokenize(clause)
          .filter((t) => !STOP_WORDS.has(t) && !DIRECTIVE_WORDS.has(t))
          .map(stemToken),
      );
      return {
        polarity: negative ? "negative" : positive ? "positive" : "neutral",
        exception: hasMarker(clause, EXCEPTION_MARKERS),
        topic,
      } as DirectiveClause;
    })
    .filter((c) => c.topic.size > 0);
}

function sameTopic(a: Set<string>, b: Set<string>): boolean {
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared >= CONFLICT_MIN_SHARED && shared / Math.min(a.size, b.size) >= CONFLICT_MIN_OVERLAP;
}

/**
 * Whether two rules point opposite ways: a negating clause on one side only,
 * or a clause-level conflict. Such rules are never duplicates, however
 * similar their words or embeddings (opposite directives score 0.88-0.98
 * cosine on all-MiniLM-L6-v2).
 */
export function directivesDisagree(a: DirectiveClause[], b: DirectiveClause[]): boolean {
  const aNeg = a.some((c) => c.polarity === "negative");
  const bNeg = b.some((c) => c.polarity === "negative");
  return aNeg !== bNeg || clauseConflict(a, b) !== null;
}

/** First conflicting clause pair between two rules, or null. */
function clauseConflict(a: DirectiveClause[], b: DirectiveClause[]): string | null {
  for (const ca of a) {
    for (const cb of b) {
      if (!sameTopic(ca.topic, cb.topic)) continue;
      const aNeg = ca.polarity === "negative";
      const bNeg = cb.polarity === "negative";
      if (aNeg !== bNeg) {
        return "Negation conflict: one rule says to do what the other says to avoid";
      }
      if (
        (ca.polarity === "positive" && cb.exception && !ca.exception) ||
        (cb.polarity === "positive" && ca.exception && !cb.exception)
      ) {
        return "Scope conflict: one rule says always, the other names an exception";
      }
    }
  }
  return null;
}

// Optimized metadata structure for conflict detection (and token-based dedup)
export interface ConflictMeta {
  bullet: PlaybookBullet;
  tokens: Set<string>;
  clauses: DirectiveClause[];
}

export function computeConflictMeta(bullet: PlaybookBullet): ConflictMeta {
  return {
    bullet,
    tokens: new Set(tokenize(bullet.content)),
    clauses: splitDirectiveClauses(bullet.content),
  };
}

export function detectConflicts(
  newContent: string,
  existingBullets: PlaybookBullet[],
): { id: string; content: string; reason: string }[] {
  const meta = existingBullets.map(computeConflictMeta);
  return detectConflictsWithMeta(newContent, meta);
}

export function detectConflictsWithMeta(
  newContent: string,
  existingMeta: ConflictMeta[],
): { id: string; content: string; reason: string }[] {
  const conflicts: { id: string; content: string; reason: string }[] = [];
  const newClauses = splitDirectiveClauses(newContent);
  if (newClauses.length === 0) return conflicts;

  for (const m of existingMeta) {
    // Skip deprecated/retired bullets - consistent with isDeprecated helper
    if (m.bullet.deprecated || m.bullet.maturity === "deprecated" || m.bullet.state === "retired")
      continue;
    const reason = clauseConflict(newClauses, m.clauses);
    if (reason) conflicts.push({ id: m.bullet.id, content: m.bullet.content, reason });
  }

  return conflicts;
}

export interface BulletConflictPair {
  a: { id: string; content: string };
  b: { id: string; content: string };
  reason: string;
}

/**
 * Every conflicting pair among active bullets (deprecated/retired skipped),
 * each pair reported once. O(n^2) clause comparisons on precomputed clauses;
 * fine for playbooks of a few thousand rules.
 */
export function findBulletConflicts(bullets: PlaybookBullet[]): BulletConflictPair[] {
  const active = bullets
    .filter((b) => !(b.deprecated || b.maturity === "deprecated" || b.state === "retired"))
    .map(computeConflictMeta);
  const pairs: BulletConflictPair[] = [];
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const reason = clauseConflict(active[i].clauses, active[j].clauses);
      if (!reason) continue;
      pairs.push({
        a: { id: active[i].bullet.id, content: active[i].bullet.content },
        b: { id: active[j].bullet.id, content: active[j].bullet.content },
        reason,
      });
    }
  }
  return pairs;
}

// --- Helper: Decision Logging ---

function logDecision(
  decisionLog: DecisionLogEntry[],
  phase: DecisionLogEntry["phase"],
  action: DecisionLogEntry["action"],
  reason: string,
  options?: { bulletId?: string; content?: string; details?: Record<string, unknown> },
): void {
  decisionLog.push({
    timestamp: now(),
    phase,
    action,
    reason,
    bulletId: options?.bulletId,
    content: options?.content,
    details: options?.details,
  });
}

// --- Helper: Anti-Pattern Inversion ---

function invertToAntiPattern(bullet: PlaybookBullet, config: Config): PlaybookBullet {
  const reason = `Marked harmful ${bullet.harmfulCount} times`;
  const cleaned = bullet.content
    .replace(/^(always |prefer |use |try |consider |ensure )/i, "")
    .trim();
  const invertedContent = `AVOID: ${cleaned}. ${reason}`;

  return {
    id: generateBulletId(),
    content: invertedContent,
    category: bullet.category,
    kind: "anti_pattern",
    type: "anti-pattern",
    isNegative: true,
    scope: bullet.scope,
    workspace: bullet.workspace,
    source: "learned", // Derived from existing rule, so implicitly learned/inferred
    state: "active",
    maturity: "candidate",
    createdAt: now(),
    updatedAt: now(),
    // Copy provenance arrays to avoid aliasing mutations between bullets.
    sourceSessions: [...(bullet.sourceSessions || [])],
    sourceAgents: [...(bullet.sourceAgents || [])],
    tags: [...(bullet.tags || []), "inverted", "anti-pattern"],
    feedbackEvents: [],
    helpfulCount: 0,
    harmfulCount: 0,
    deprecated: false,
    pinned: false,
    confidenceDecayHalfLifeDays: config.scoring.decayHalfLifeDays,
  };
}

// --- Main Curator ---

/**
 * Most similar active bullet by embedding, at or above the index threshold.
 * Bullets without an embedding in the index are skipped.
 *
 * Sentence embeddings barely register negation ("Always commit lockfiles" and
 * "Never commit lockfiles" sit close together), so a candidate whose
 * directives disagree with the new rule (any negating clause on one side
 * only, or a clause-level conflict) is never treated as a duplicate:
 * reinforcing it would credit the opposite advice.
 */
function findSemanticDuplicateFromMeta(
  content: string,
  metaList: ConflictMeta[],
  index: SemanticDedupIndex,
): { bullet: PlaybookBullet; similarity: number } | undefined {
  const query = index.embeddings.get(hashContent(content));
  if (!query) return undefined;
  const clauses = splitDirectiveClauses(content);
  let best: { bullet: PlaybookBullet; similarity: number } | undefined;
  for (const meta of metaList) {
    const b = meta.bullet;
    if (b.deprecated || b.maturity === "deprecated" || b.state === "retired") continue;
    if (directivesDisagree(clauses, meta.clauses)) continue;
    const vector = index.embeddings.get(hashContent(b.content));
    if (!vector) continue;
    const similarity = cosineSimilarity(query, vector);
    if (similarity >= index.threshold && (!best || similarity > best.similarity)) {
      best = { bullet: b, similarity };
    }
  }
  return best;
}

export function curatePlaybook(
  targetPlaybook: Playbook,
  deltas: PlaybookDelta[],
  config: Config,
  contextPlaybook?: Playbook,
  options: {
    /** Embeddings for reworded-duplicate detection (see buildSemanticDedupIndex). */
    semanticIndex?: SemanticDedupIndex;
  } = {},
): CurationResult {
  // Use context playbook (merged) for dedup checks if available, otherwise target
  const referencePlaybook = contextPlaybook || targetPlaybook;

  // Optimization: Pre-compute maps for O(1) lookups and conflict detection.
  // This map tracks content hashes from BOTH the reference playbook AND newly added bullets in this batch.
  const bulletContentMap = new Map<string, PlaybookBullet>();
  for (const b of referencePlaybook.bullets) {
    bulletContentMap.set(hashContent(b.content), b);
  }

  // Pre-compute conflict metadata for the reference playbook once.
  // We will append to this array as we add new bullets to ensure conflicts are caught within the batch.
  const conflictMeta = referencePlaybook.bullets.map(computeConflictMeta);

  const decisionLog: DecisionLogEntry[] = [];

  const result: CurationResult = {
    playbook: targetPlaybook, // Mutating target
    applied: 0,
    skipped: 0,
    conflicts: [],
    promotions: [],
    inversions: [],
    pruned: 0,
    decisionLog,
  };

  for (const delta of deltas) {
    let applied = false;

    switch (delta.type) {
      case "add": {
        if (!delta.bullet?.content || !delta.bullet?.category) {
          logDecision(decisionLog, "add", "rejected", "Missing required content or category", {
            content: delta.bullet?.content?.slice(0, 100),
          });
          break;
        }

        const content = delta.bullet.content;
        const hash = hashContent(content);

        // Conflict detection (warnings only)
        // Checks against reference AND newly added bullets (via updated conflictMeta)
        // Use optimized version with pre-computed meta
        const newTokens = tokenize(content);
        const newTokenSet = new Set(newTokens);

        // Note: detectConflictsWithMeta re-tokenizes internally if we pass string.
        // But we need newTokenSet for dedup anyway.
        // We can't easily pass Set to detectConflictsWithMeta without changing its signature or logic duplication.
        // For now, letting it re-tokenize is fine (it's fast), or we can refactor.
        // To be safe and minimal diff, we'll let it re-tokenize or just pass string.
        const conflicts = detectConflictsWithMeta(content, conflictMeta);

        for (const c of conflicts) {
          result.conflicts.push({
            newBulletContent: content,
            conflictingBulletId: c.id,
            conflictingContent: c.content,
            reason: c.reason,
          });
          logDecision(decisionLog, "conflict", "skipped", c.reason, {
            content: content.slice(0, 100),
            bulletId: c.id,
            details: { conflictingContent: c.content.slice(0, 100) },
          });
        }

        // 1. Exact duplicate check (O(1) using map)
        const exactMatch = bulletContentMap.get(hash);

        if (exactMatch) {
          const isDeprecated =
            Boolean(exactMatch.deprecated) ||
            exactMatch.maturity === "deprecated" ||
            exactMatch.state === "retired";

          if (isDeprecated) {
            logDecision(
              decisionLog,
              "dedup",
              "skipped",
              "Exact duplicate exists but is deprecated",
              {
                content: content.slice(0, 100),
                bulletId: exactMatch.id,
              },
            );
            break;
          }

          // Try to find it in the target playbook (the one we are writing to)
          const targetBullet = findBullet(targetPlaybook, exactMatch.id);

          if (targetBullet) {
            targetBullet.feedbackEvents.push({
              type: "helpful",
              timestamp: now(),
              sessionPath: delta.sourceSession,
              context: "Reinforced by exact duplicate insight",
            });
            targetBullet.helpfulCount++;
            targetBullet.updatedAt = now();
            applied = true;
            logDecision(decisionLog, "dedup", "modified", "Reinforced existing exact duplicate", {
              bulletId: targetBullet.id,
              content: content.slice(0, 100),
            });
          } else {
            // It exists in the context (other layer) but not target. Skip to avoid duplication.
            logDecision(
              decisionLog,
              "dedup",
              "skipped",
              "Exact duplicate exists in other playbook layer",
              {
                content: content.slice(0, 100),
                bulletId: exactMatch.id,
              },
            );
          }
          break;
        }

        // 2. Semantic duplicate check (Optimized)
        // Uses pre-computed tokens from conflictMeta (which includes newly added bullets)
        const lexicalSimilar = findSimilarBulletFromMeta(
          newTokenSet,
          conflictMeta,
          config.dedupSimilarityThreshold,
          splitDirectiveClauses(content),
        );
        // Word overlap misses rewordings ("Run tests before you push" vs
        // "Always execute the test suite prior to pushing"); embeddings catch them.
        const semanticMatch =
          !lexicalSimilar && options.semanticIndex
            ? findSemanticDuplicateFromMeta(content, conflictMeta, options.semanticIndex)
            : undefined;
        if (semanticMatch) {
          logDecision(decisionLog, "dedup", "modified", "Semantic duplicate of an existing rule", {
            bulletId: semanticMatch.bullet.id,
            content: content.slice(0, 100),
            details: {
              similarity: Math.round(semanticMatch.similarity * 1000) / 1000,
              similarTo: semanticMatch.bullet.content.slice(0, 100),
            },
          });
        }
        const similar = lexicalSimilar ?? semanticMatch?.bullet;

        if (similar) {
          const similarIsDeprecated =
            Boolean(similar.deprecated) ||
            similar.maturity === "deprecated" ||
            similar.state === "retired";

          // Never reinforce deprecated/blocked bullets; treat as a skip to prevent zombie rules.
          if (similarIsDeprecated) {
            logDecision(
              decisionLog,
              "dedup",
              "skipped",
              "Similar bullet exists but is deprecated; skipping to avoid resurrecting blocked content",
              {
                content: content.slice(0, 100),
                bulletId: similar.id,
                details: { similarTo: similar.content.slice(0, 100) },
              },
            );
            break;
          }

          const targetSimilar = findBullet(targetPlaybook, similar.id);
          if (targetSimilar) {
            const targetIsDeprecated =
              Boolean(targetSimilar.deprecated) ||
              targetSimilar.maturity === "deprecated" ||
              targetSimilar.state === "retired";

            if (targetIsDeprecated) {
              logDecision(
                decisionLog,
                "dedup",
                "skipped",
                "Similar bullet exists but is deprecated in target; not reinforcing",
                {
                  bulletId: targetSimilar.id,
                  content: content.slice(0, 100),
                  details: { similarTo: similar.content.slice(0, 100) },
                },
              );
              break;
            }

            targetSimilar.feedbackEvents.push({
              type: "helpful",
              timestamp: now(),
              sessionPath: delta.sourceSession,
              context: "Reinforced by similar insight",
            });
            targetSimilar.helpfulCount++;
            targetSimilar.updatedAt = now();
            applied = true;
            logDecision(decisionLog, "dedup", "modified", "Reinforced existing similar bullet", {
              bulletId: targetSimilar.id,
              content: content.slice(0, 100),
              details: {
                similarTo: similar.content.slice(0, 100),
                similarity: config.dedupSimilarityThreshold,
              },
            });
          } else {
            logDecision(
              decisionLog,
              "dedup",
              "skipped",
              "Similar bullet exists in repo playbook (or just added)",
              {
                content: content.slice(0, 100),
                details: { similarTo: similar.content.slice(0, 100) },
              },
            );
          }
          break;
        }

        // 3. Add new (to TARGET)
        // Preserve safe, schema-validated metadata from the delta where possible.
        const newBullet = addBullet(
          targetPlaybook,
          {
            id: delta.bullet.id,
            content,
            category: delta.bullet.category,
            tags: delta.bullet.tags,
            kind: delta.bullet.kind,
            type: delta.bullet.type,
            isNegative: delta.bullet.isNegative,
            scope: delta.bullet.scope,
            workspace: delta.bullet.workspace,
            searchPointer: delta.bullet.searchPointer,
          },
          delta.sourceSession,
          config.scoring.decayHalfLifeDays,
        );

        if (typeof delta.reason === "string" && delta.reason.trim()) {
          newBullet.reasoning = delta.reason.trim();
        }

        // Update caches to catch duplicates later in this batch
        bulletContentMap.set(hash, newBullet);

        // We reuse the already computed tokens for the new bullet metadata
        conflictMeta.push(computeConflictMeta(newBullet));

        applied = true;
        logDecision(decisionLog, "add", "accepted", "New bullet added to playbook", {
          bulletId: newBullet.id,
          content: content.slice(0, 100),
          details: { category: delta.bullet.category, tags: delta.bullet.tags },
        });
        break;
      }

      case "helpful": {
        const bullet = findBullet(targetPlaybook, delta.bulletId);
        if (!bullet) {
          logDecision(
            decisionLog,
            "feedback",
            "rejected",
            "Bullet not found for helpful feedback",
            {
              bulletId: delta.bulletId,
            },
          );
          break;
        }

        // Idempotency check
        const alreadyRecorded = bullet.feedbackEvents.some(
          (e) =>
            e.type === "helpful" &&
            e.sessionPath &&
            delta.sourceSession &&
            e.sessionPath === delta.sourceSession,
        );

        if (alreadyRecorded) {
          logDecision(
            decisionLog,
            "feedback",
            "skipped",
            "Helpful feedback already recorded for this session",
            {
              bulletId: delta.bulletId,
            },
          );
          break;
        }

        bullet.feedbackEvents.push({
          type: "helpful",
          timestamp: now(),
          sessionPath: delta.sourceSession,
          context: delta.context,
        });
        bullet.helpfulCount++;
        bullet.lastValidatedAt = now();
        bullet.updatedAt = now();
        applied = true;
        logDecision(decisionLog, "feedback", "accepted", "Helpful feedback recorded", {
          bulletId: delta.bulletId,
          content: bullet.content.slice(0, 100),
          details: { helpfulCount: bullet.helpfulCount, context: delta.context },
        });
        break;
      }

      case "harmful": {
        const bullet = findBullet(targetPlaybook, delta.bulletId);
        if (!bullet) {
          logDecision(
            decisionLog,
            "feedback",
            "rejected",
            "Bullet not found for harmful feedback",
            {
              bulletId: delta.bulletId,
            },
          );
          break;
        }

        // Idempotency check
        const alreadyRecorded = bullet.feedbackEvents.some(
          (e) =>
            e.type === "harmful" &&
            e.sessionPath &&
            delta.sourceSession &&
            e.sessionPath === delta.sourceSession,
        );

        if (alreadyRecorded) {
          logDecision(
            decisionLog,
            "feedback",
            "skipped",
            "Harmful feedback already recorded for this session",
            {
              bulletId: delta.bulletId,
            },
          );
          break;
        }

        bullet.feedbackEvents.push({
          type: "harmful",
          timestamp: now(),
          sessionPath: delta.sourceSession,
          reason: delta.reason,
          context: delta.context,
        });
        bullet.harmfulCount++;
        bullet.updatedAt = now();
        applied = true;
        logDecision(decisionLog, "feedback", "accepted", "Harmful feedback recorded", {
          bulletId: delta.bulletId,
          content: bullet.content.slice(0, 100),
          details: { harmfulCount: bullet.harmfulCount, reason: delta.reason },
        });
        break;
      }

      case "replace": {
        const bullet = findBullet(targetPlaybook, delta.bulletId);
        if (!bullet) {
          logDecision(decisionLog, "add", "rejected", "Bullet not found for replacement", {
            bulletId: delta.bulletId,
          });
          break;
        }
        const oldContent = bullet.content;
        bullet.content = delta.newContent;
        bullet.updatedAt = now();
        applied = true;
        logDecision(decisionLog, "add", "modified", "Bullet content replaced", {
          bulletId: delta.bulletId,
          content: delta.newContent.slice(0, 100),
          details: { previousContent: oldContent.slice(0, 100) },
        });
        break;
      }

      case "deprecate": {
        if (deprecateBullet(targetPlaybook, delta.bulletId, delta.reason, delta.replacedBy)) {
          applied = true;
          logDecision(decisionLog, "demotion", "accepted", "Bullet deprecated", {
            bulletId: delta.bulletId,
            details: { reason: delta.reason, replacedBy: delta.replacedBy },
          });
        } else {
          logDecision(decisionLog, "demotion", "rejected", "Failed to deprecate bullet", {
            bulletId: delta.bulletId,
          });
        }
        break;
      }

      case "merge": {
        // Only merge if all bullets exist in target
        const bulletsToMerge = delta.bulletIds
          .map((id) => findBullet(targetPlaybook, id))
          .filter((b) => b !== undefined) as PlaybookBullet[];

        if (bulletsToMerge.length !== delta.bulletIds.length || bulletsToMerge.length < 2) {
          logDecision(
            decisionLog,
            "add",
            "rejected",
            "Cannot merge: missing bullets or insufficient count",
            {
              details: { requested: delta.bulletIds.length, found: bulletsToMerge.length },
            },
          );
          break;
        }

        const merged = addBullet(
          targetPlaybook,
          {
            content: delta.mergedContent,
            category: bulletsToMerge[0].category,
            tags: [...new Set(bulletsToMerge.flatMap((b) => b.tags))],
          },
          "merged",
          config.scoring?.decayHalfLifeDays ?? config.defaultDecayHalfLife ?? 90,
        );

        bulletsToMerge.forEach((b) => {
          deprecateBullet(targetPlaybook, b.id, `Merged into ${merged.id}`, merged.id);
        });

        applied = true;
        logDecision(decisionLog, "add", "accepted", "Bullets merged into new combined bullet", {
          bulletId: merged.id,
          content: delta.mergedContent.slice(0, 100),
          details: { mergedFrom: delta.bulletIds },
        });
        break;
      }
    }

    if (applied) result.applied++;
    else result.skipped++;
  }

  // --- Post-Processing on TARGET ---

  // 1. Anti-Pattern Inversion (must run BEFORE auto-deprecation)
  const inversions: InversionReport[] = [];
  const invertedBulletIds = new Set<string>();

  // Iterate over a copy to safely mutate the array (adding anti-patterns) during iteration
  for (const bullet of [...targetPlaybook.bullets]) {
    if (bullet.deprecated || bullet.pinned || bullet.kind === "anti_pattern") continue;

    const { decayedHarmful, decayedHelpful } = getDecayedCounts(bullet, config);
    const pruneThreshold = config.pruneHarmfulThreshold ?? 3;
    // Use epsilon for floating point comparison robustness
    const epsilon = 0.01;

    if (decayedHarmful >= pruneThreshold - epsilon && decayedHarmful > decayedHelpful * 2) {
      if (bullet.isNegative) {
        deprecateBullet(
          targetPlaybook,
          bullet.id,
          "Negative rule marked harmful (likely incorrect restriction)",
        );
        result.pruned++;
        logDecision(
          decisionLog,
          "inversion",
          "rejected",
          "Negative rule deprecated (not inverted) due to harmful feedback",
          {
            bulletId: bullet.id,
            content: bullet.content.slice(0, 100),
            details: { decayedHarmful, decayedHelpful },
          },
        );
      } else {
        const antiPattern = invertToAntiPattern(bullet, config);
        targetPlaybook.bullets.push(antiPattern);

        deprecateBullet(
          targetPlaybook,
          bullet.id,
          `Inverted to anti-pattern: ${antiPattern.id}`,
          antiPattern.id,
        );
        invertedBulletIds.add(bullet.id);

        inversions.push({
          originalId: bullet.id,
          originalContent: bullet.content,
          antiPatternId: antiPattern.id,
          antiPatternContent: antiPattern.content,
          bulletId: bullet.id,
          reason: `Marked as blocked/anti-pattern`,
        });

        logDecision(
          decisionLog,
          "inversion",
          "accepted",
          "Positive rule inverted to anti-pattern due to harmful feedback",
          {
            bulletId: bullet.id,
            content: bullet.content.slice(0, 100),
            details: { antiPatternId: antiPattern.id, decayedHarmful, decayedHelpful },
          },
        );
      }
    }
  }
  result.inversions = inversions;

  // 2. Promotions & Demotions (after inversion so we don't double-deprecate)
  // Iterate over a copy to avoid issues if we were to modify the array structure (though we currently don't remove)
  for (const bullet of [...targetPlaybook.bullets]) {
    if (bullet.deprecated || invertedBulletIds.has(bullet.id)) continue;

    const oldMaturity = bullet.maturity;
    const promoted = checkForPromotion(bullet, config);

    if (promoted !== oldMaturity) {
      bullet.maturity = promoted;
      result.promotions.push({
        bulletId: bullet.id,
        from: oldMaturity,
        to: promoted,
        reason: `Auto-promoted based on feedback`,
      });

      logDecision(
        decisionLog,
        "promotion",
        "accepted",
        `Maturity promoted from ${oldMaturity} to ${promoted}`,
        {
          bulletId: bullet.id,
          content: bullet.content.slice(0, 100),
          details: { from: oldMaturity, to: promoted },
        },
      );
    }

    const demotionCheck = checkForDemotion(bullet, config);
    if (demotionCheck === "auto-deprecate") {
      deprecateBullet(targetPlaybook, bullet.id, "Auto-deprecated due to negative score");
      result.pruned++;
      logDecision(
        decisionLog,
        "demotion",
        "accepted",
        "Bullet auto-deprecated due to negative effective score",
        {
          bulletId: bullet.id,
          content: bullet.content.slice(0, 100),
        },
      );
    } else if (demotionCheck !== bullet.maturity) {
      const prevMaturity = bullet.maturity;
      bullet.maturity = demotionCheck;
      logDecision(
        decisionLog,
        "demotion",
        "accepted",
        `Maturity demoted from ${prevMaturity} to ${demotionCheck}`,
        {
          bulletId: bullet.id,
          content: bullet.content.slice(0, 100),
          details: { from: prevMaturity, to: demotionCheck },
        },
      );
    }
  }

  return result;
}
