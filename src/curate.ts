import {
  Config,
  Playbook,
  PlaybookDelta,
  CurationResult,
  PlaybookBullet,
  InversionReport,
  DecisionLogEntry
} from "./types.js";
import { 
  findBullet, 
  addBullet, 
  deprecateBullet 
} from "./playbook.js";
import { 
  hashContent, 
  jaccardSimilarity, 
  jaccardSimilaritySets,
  generateBulletId, 
  now,
  log,
  tokenize
} from "./utils.js";
import { 
  checkForPromotion, 
  checkForDemotion, 
  getDecayedCounts 
} from "./scoring.js";

function findSimilarBulletFromMeta(
  newTokens: Set<string>,
  metaList: ConflictMeta[],
  threshold: number
): PlaybookBullet | undefined {
  let bestDeprecated: PlaybookBullet | undefined;

  for (const meta of metaList) {
    const b = meta.bullet;
    const isDeprecated = Boolean(b.deprecated) || b.maturity === "deprecated" || b.state === "retired";
    
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

const NEGATIVE_MARKERS = ["never", "dont", "don't", "avoid", "forbid", "forbidden", "disable", "prevent", "stop", "skip"];
const POSITIVE_MARKERS = ["always", "must", "required", "ensure", "use", "enable"];
const EXCEPTION_MARKERS = ["unless", "except", "only if", "only when", "except when"];

function hasMarker(text: string, markers: string[]): boolean {
  // Use word boundaries to avoid substring matches (e.g., "use" matching "user")
  const lower = text.toLowerCase();
  return markers.some(m => new RegExp(`\\b${m}\\b`, 'i').test(lower));
}

// Optimized metadata structure for conflict detection
interface ConflictMeta {
  bullet: PlaybookBullet;
  tokens: Set<string>;
  neg: boolean;
  pos: boolean;
  exc: boolean;
}

function computeConflictMeta(bullet: PlaybookBullet): ConflictMeta {
  return {
    bullet,
    tokens: new Set(tokenize(bullet.content)),
    neg: hasMarker(bullet.content, NEGATIVE_MARKERS),
    pos: hasMarker(bullet.content, POSITIVE_MARKERS),
    exc: hasMarker(bullet.content, EXCEPTION_MARKERS)
  };
}

export function detectConflicts(
  newContent: string,
  existingBullets: PlaybookBullet[]
): { id: string; content: string; reason: string }[] {
  // For tests/legacy calls: compute meta on the fly
  const meta = existingBullets.map(computeConflictMeta);
  return detectConflictsWithMeta(newContent, meta);
}

export function detectConflictsWithMeta(
  newContent: string,
  existingMeta: ConflictMeta[]
): { id: string; content: string; reason: string }[] {
  const conflicts: { id: string; content: string; reason: string }[] = [];
  
  // Pre-check markers in new content once
  // Optimization: tokenize new content once
  const newTokens = tokenize(newContent);
  const newTokenSet = new Set(newTokens);
  
  const newNeg = hasMarker(newContent, NEGATIVE_MARKERS);
  const newPos = hasMarker(newContent, POSITIVE_MARKERS);
  const newExc = hasMarker(newContent, EXCEPTION_MARKERS);
  
  const hasNewMarkers = newNeg || newPos || newExc;

  for (const m of existingMeta) {
    // Skip deprecated/retired bullets - consistent with isDeprecated helper
    if (m.bullet.deprecated || m.bullet.maturity === "deprecated" || m.bullet.state === "retired") continue;

    // Optimization: Jaccard using pre-computed token sets
    if (newTokens.length === 0 || m.tokens.size === 0) continue;
    
    // Fast skip based on size difference
    const maxSize = Math.max(newTokenSet.size, m.tokens.size);
    const minSize = Math.min(newTokenSet.size, m.tokens.size);
    // If sizes are too different, Jaccard can't be high. 
    // intersection <= minSize. union >= maxSize.
    // Jaccard <= minSize / maxSize.
    // If minSize / maxSize < 0.1, then Jaccard < 0.1.
    // We need 0.1 or 0.2 overlap.
    const hasDirectiveMarkers = hasNewMarkers || m.neg || m.pos || m.exc;
    const minOverlap = hasDirectiveMarkers ? 0.1 : 0.2;
    
    if (minSize / maxSize < minOverlap) continue;

    const intersectionSize = [...newTokenSet].filter(x => m.tokens.has(x)).length;
    const unionSize = new Set([...newTokenSet, ...m.tokens]).size;
    const overlap = intersectionSize / unionSize;
    
    if (overlap < minOverlap) continue;

    // Heuristic 1: Negation conflict (one negative, one affirmative)
    if (overlap >= minOverlap && newNeg !== m.neg) {
      conflicts.push({
        id: m.bullet.id,
        content: m.bullet.content,
        reason: "Possible negation conflict (one says do, the other says avoid) with high term overlap"
      });
      continue;
    }

    // Heuristic 2: Opposite sentiment (must vs avoid)
    if (overlap >= minOverlap && ((newPos && m.neg) || (m.pos && newNeg))) {
      conflicts.push({
        id: m.bullet.id,
        content: m.bullet.content,
        reason: "Opposite directives (must vs avoid) on similar subject matter"
      });
      continue;
    }

    // Heuristic 3: Scope conflict (always vs exception)
    if (overlap >= minOverlap && ((newPos && m.exc) || (m.pos && newExc))) {
      conflicts.push({
        id: m.bullet.id,
        content: m.bullet.content,
        reason: "Potential scope conflict (always vs exception) on overlapping topic"
      });
      continue;
    }
  }

  return conflicts;
}

// --- Helper: Decision Logging ---

function logDecision(
  decisionLog: DecisionLogEntry[],
  phase: DecisionLogEntry["phase"],
  action: DecisionLogEntry["action"],
  reason: string,
  options?: { bulletId?: string; content?: string; details?: Record<string, unknown> }
): void {
  decisionLog.push({
    timestamp: now(),
    phase,
    action,
    reason,
    bulletId: options?.bulletId,
    content: options?.content,
    details: options?.details
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
    confidenceDecayHalfLifeDays: config.scoring.decayHalfLifeDays 
  };
}

// --- Main Curator ---

export function curatePlaybook(
  targetPlaybook: Playbook,
  deltas: PlaybookDelta[],
  config: Config,
  contextPlaybook?: Playbook
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
    decisionLog
  };

  for (const delta of deltas) {
    let applied = false;

    switch (delta.type) {
      case "add": {
        if (!delta.bullet?.content || !delta.bullet?.category) {
          logDecision(decisionLog, "add", "rejected", "Missing required content or category", {
            content: delta.bullet?.content?.slice(0, 100)
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
            reason: c.reason
          });
          logDecision(decisionLog, "conflict", "skipped", c.reason, {
            content: content.slice(0, 100),
            bulletId: c.id,
            details: { conflictingContent: c.content.slice(0, 100) }
          });
        }

        // 1. Exact duplicate check (O(1) using map)
        const exactMatch = bulletContentMap.get(hash);

        if (exactMatch) {
          const isDeprecated = Boolean(exactMatch.deprecated) || exactMatch.maturity === "deprecated" || exactMatch.state === "retired";

          if (isDeprecated) {
             logDecision(decisionLog, "dedup", "skipped", "Exact duplicate exists but is deprecated", {
               content: content.slice(0, 100),
               bulletId: exactMatch.id
             });
             break;
          }

          // Try to find it in the target playbook (the one we are writing to)
          const targetBullet = findBullet(targetPlaybook, exactMatch.id);

          if (targetBullet) {
            targetBullet.feedbackEvents.push({
              type: "helpful",
              timestamp: now(),
              sessionPath: delta.sourceSession,
              context: "Reinforced by exact duplicate insight"
            });
            targetBullet.helpfulCount++;
            targetBullet.updatedAt = now();
            applied = true;
            logDecision(decisionLog, "dedup", "modified", "Reinforced existing exact duplicate", {
              bulletId: targetBullet.id,
              content: content.slice(0, 100)
            });
          } else {
            // It exists in the context (other layer) but not target. Skip to avoid duplication.
            logDecision(decisionLog, "dedup", "skipped", "Exact duplicate exists in other playbook layer", {
              content: content.slice(0, 100),
              bulletId: exactMatch.id
            });
          }
          break;
        }

        // 2. Semantic duplicate check (Optimized)
        // Uses pre-computed tokens from conflictMeta (which includes newly added bullets)
        const similar = findSimilarBulletFromMeta(newTokenSet, conflictMeta, config.dedupSimilarityThreshold);

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
                details: { similarTo: similar.content.slice(0, 100) }
              }
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
                  details: { similarTo: similar.content.slice(0, 100) }
                }
              );
              break;
            }

            targetSimilar.feedbackEvents.push({
              type: "helpful",
              timestamp: now(),
              sessionPath: delta.sourceSession,
              context: "Reinforced by similar insight"
            });
            targetSimilar.helpfulCount++;
            targetSimilar.updatedAt = now();
            applied = true;
            logDecision(decisionLog, "dedup", "modified", "Reinforced existing similar bullet", {
              bulletId: targetSimilar.id,
              content: content.slice(0, 100),
              details: { similarTo: similar.content.slice(0, 100), similarity: config.dedupSimilarityThreshold }
            });
          } else {
            logDecision(decisionLog, "dedup", "skipped", "Similar bullet exists in repo playbook (or just added)", {
              content: content.slice(0, 100),
              details: { similarTo: similar.content.slice(0, 100) }
            });
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
          config.scoring.decayHalfLifeDays
        );

        if (typeof delta.reason === "string" && delta.reason.trim()) {
          newBullet.reasoning = delta.reason.trim();
        }

        // Update caches to catch duplicates later in this batch
        bulletContentMap.set(hash, newBullet);
        
        // We reuse the already computed tokens for the new bullet metadata
        const newMeta: ConflictMeta = {
          bullet: newBullet,
          tokens: newTokenSet,
          neg: hasMarker(content, NEGATIVE_MARKERS),
          pos: hasMarker(content, POSITIVE_MARKERS),
          exc: hasMarker(content, EXCEPTION_MARKERS)
        };
        conflictMeta.push(newMeta);

        applied = true;
        logDecision(decisionLog, "add", "accepted", "New bullet added to playbook", {
          bulletId: newBullet.id,
          content: content.slice(0, 100),
          details: { category: delta.bullet.category, tags: delta.bullet.tags }
        });
        break;
      }

      case "helpful": {
        const bullet = findBullet(targetPlaybook, delta.bulletId);
        if (!bullet) {
          logDecision(decisionLog, "feedback", "rejected", "Bullet not found for helpful feedback", {
            bulletId: delta.bulletId
          });
          break;
        }

        // Idempotency check
        const alreadyRecorded = bullet.feedbackEvents.some(e =>
          e.type === "helpful" &&
          e.sessionPath &&
          delta.sourceSession &&
          e.sessionPath === delta.sourceSession
        );

        if (alreadyRecorded) {
          logDecision(decisionLog, "feedback", "skipped", "Helpful feedback already recorded for this session", {
            bulletId: delta.bulletId
          });
          break;
        }

        bullet.feedbackEvents.push({
          type: "helpful",
          timestamp: now(),
          sessionPath: delta.sourceSession,
          context: delta.context
        });
        bullet.helpfulCount++;
        bullet.lastValidatedAt = now();
        bullet.updatedAt = now();
        applied = true;
        logDecision(decisionLog, "feedback", "accepted", "Helpful feedback recorded", {
          bulletId: delta.bulletId,
          content: bullet.content.slice(0, 100),
          details: { helpfulCount: bullet.helpfulCount, context: delta.context }
        });
        break;
      }

      case "harmful": {
        const bullet = findBullet(targetPlaybook, delta.bulletId);
        if (!bullet) {
          logDecision(decisionLog, "feedback", "rejected", "Bullet not found for harmful feedback", {
            bulletId: delta.bulletId
          });
          break;
        }

        // Idempotency check
        const alreadyRecorded = bullet.feedbackEvents.some(e =>
          e.type === "harmful" &&
          e.sessionPath &&
          delta.sourceSession &&
          e.sessionPath === delta.sourceSession
        );

        if (alreadyRecorded) {
          logDecision(decisionLog, "feedback", "skipped", "Harmful feedback already recorded for this session", {
            bulletId: delta.bulletId
          });
          break;
        }

        bullet.feedbackEvents.push({
          type: "harmful",
          timestamp: now(),
          sessionPath: delta.sourceSession,
          reason: delta.reason,
          context: delta.context
        });
        bullet.harmfulCount++;
        bullet.updatedAt = now();
        applied = true;
        logDecision(decisionLog, "feedback", "accepted", "Harmful feedback recorded", {
          bulletId: delta.bulletId,
          content: bullet.content.slice(0, 100),
          details: { harmfulCount: bullet.harmfulCount, reason: delta.reason }
        });
        break;
      }

      case "replace": {
        const bullet = findBullet(targetPlaybook, delta.bulletId);
        if (!bullet) {
          logDecision(decisionLog, "add", "rejected", "Bullet not found for replacement", {
            bulletId: delta.bulletId
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
          details: { previousContent: oldContent.slice(0, 100) }
        });
        break;
      }

      case "deprecate": {
        if (deprecateBullet(targetPlaybook, delta.bulletId, delta.reason, delta.replacedBy)) {
          applied = true;
          logDecision(decisionLog, "demotion", "accepted", "Bullet deprecated", {
            bulletId: delta.bulletId,
            details: { reason: delta.reason, replacedBy: delta.replacedBy }
          });
        } else {
          logDecision(decisionLog, "demotion", "rejected", "Failed to deprecate bullet", {
            bulletId: delta.bulletId
          });
        }
        break;
      }
      
      case "merge": {
        // Only merge if all bullets exist in target
        const bulletsToMerge = delta.bulletIds.map(id => findBullet(targetPlaybook, id)).filter(b => b !== undefined) as PlaybookBullet[];

        if (bulletsToMerge.length !== delta.bulletIds.length || bulletsToMerge.length < 2) {
          logDecision(decisionLog, "add", "rejected", "Cannot merge: missing bullets or insufficient count", {
            details: { requested: delta.bulletIds.length, found: bulletsToMerge.length }
          });
          break;
        }

        const merged = addBullet(targetPlaybook, {
          content: delta.mergedContent,
          category: bulletsToMerge[0].category,
          tags: [...new Set(bulletsToMerge.flatMap(b => b.tags))]
        }, "merged", config.scoring?.decayHalfLifeDays ?? config.defaultDecayHalfLife ?? 90);

        bulletsToMerge.forEach(b => {
          deprecateBullet(targetPlaybook, b.id, `Merged into ${merged.id}`, merged.id);
        });

        applied = true;
        logDecision(decisionLog, "add", "accepted", "Bullets merged into new combined bullet", {
          bulletId: merged.id,
          content: delta.mergedContent.slice(0, 100),
          details: { mergedFrom: delta.bulletIds }
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

    if (decayedHarmful >= (pruneThreshold - epsilon) && decayedHarmful > (decayedHelpful * 2)) {
      if (bullet.isNegative) {
        deprecateBullet(targetPlaybook, bullet.id, "Negative rule marked harmful (likely incorrect restriction)");
        result.pruned++;
        logDecision(decisionLog, "inversion", "rejected", "Negative rule deprecated (not inverted) due to harmful feedback", {
          bulletId: bullet.id,
          content: bullet.content.slice(0, 100),
          details: { decayedHarmful, decayedHelpful }
        });
      } else {
        const antiPattern = invertToAntiPattern(bullet, config);
        targetPlaybook.bullets.push(antiPattern);

        deprecateBullet(targetPlaybook, bullet.id, `Inverted to anti-pattern: ${antiPattern.id}`, antiPattern.id);
        invertedBulletIds.add(bullet.id);

        inversions.push({
          originalId: bullet.id,
          originalContent: bullet.content,
          antiPatternId: antiPattern.id,
          antiPatternContent: antiPattern.content,
          bulletId: bullet.id,
          reason: `Marked as blocked/anti-pattern`
        });

        logDecision(decisionLog, "inversion", "accepted", "Positive rule inverted to anti-pattern due to harmful feedback", {
          bulletId: bullet.id,
          content: bullet.content.slice(0, 100),
          details: { antiPatternId: antiPattern.id, decayedHarmful, decayedHelpful }
        });
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
        reason: `Auto-promoted based on feedback`
      });
      
      logDecision(decisionLog, "promotion", "accepted", `Maturity promoted from ${oldMaturity} to ${promoted}`, {
        bulletId: bullet.id,
        content: bullet.content.slice(0, 100),
        details: { from: oldMaturity, to: promoted }
      });
    }

    const demotionCheck = checkForDemotion(bullet, config);
    if (demotionCheck === "auto-deprecate") {
      deprecateBullet(targetPlaybook, bullet.id, "Auto-deprecated due to negative score");
      result.pruned++;
      logDecision(decisionLog, "demotion", "accepted", "Bullet auto-deprecated due to negative effective score", {
        bulletId: bullet.id,
        content: bullet.content.slice(0, 100)
      });
    } else if (demotionCheck !== bullet.maturity) {
      const prevMaturity = bullet.maturity;
      bullet.maturity = demotionCheck;
      logDecision(decisionLog, "demotion", "accepted", `Maturity demoted from ${prevMaturity} to ${demotionCheck}`, {
        bulletId: bullet.id,
        content: bullet.content.slice(0, 100),
        details: { from: prevMaturity, to: demotionCheck }
      });
    }
  }

  return result;
}
