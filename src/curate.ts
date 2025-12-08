import { 
  Config, 
  Playbook, 
  PlaybookDelta, 
  CurationResult,
  PlaybookBullet,
  InversionReport
} from "./types.js";
import { 
  findBullet, 
  addBullet, 
  deprecateBullet 
} from "./playbook.js";
import { 
  hashContent, 
  jaccardSimilarity, 
  generateBulletId, 
  now,
  log
} from "./utils.js";
import { 
  checkForPromotion, 
  checkForDemotion, 
  getDecayedCounts 
} from "./scoring.js";

// --- Helper: Build Hash Cache ---

function buildHashCache(playbook: Playbook): Set<string> {
  const cache = new Set<string>();
  for (const b of playbook.bullets) {
    // Include deprecated bullets to prevent re-adding them (zombie rules or blocked content)
    cache.add(hashContent(b.content));
  }
  return cache;
}

function findSimilarBullet(
  content: string, 
  playbook: Playbook, 
  threshold: number
): PlaybookBullet | undefined {
  for (const b of playbook.bullets) {
    // Check deprecated bullets too
    if (jaccardSimilarity(content, b.content) >= threshold) {
      return b;
    }
  }
  return undefined;
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

export function detectConflicts(
  newContent: string,
  existingBullets: PlaybookBullet[]
): { id: string; content: string; reason: string }[] {
  const conflicts: { id: string; content: string; reason: string }[] = [];

  for (const b of existingBullets) {
    if (b.deprecated) continue;

    const overlap = jaccardSimilarity(newContent, b.content);
    
    // Check markers efficiently if overlap is borderline
    const markersInNew = hasMarker(newContent, [...NEGATIVE_MARKERS, ...POSITIVE_MARKERS, ...EXCEPTION_MARKERS]);
    const markersInOld = hasMarker(b.content, [...NEGATIVE_MARKERS, ...POSITIVE_MARKERS, ...EXCEPTION_MARKERS]);
    
    // Optimization: Check overlap first. 
    // When strong markers are present, allow lower overlap threshold.
    const hasDirectiveMarkers = markersInNew || markersInOld;
    const minOverlap = hasDirectiveMarkers ? 0.1 : 0.2;
    if (overlap < minOverlap) continue;

    const newNeg = hasMarker(newContent, NEGATIVE_MARKERS);
    const oldNeg = hasMarker(b.content, NEGATIVE_MARKERS);
    const newPos = hasMarker(newContent, POSITIVE_MARKERS);
    const oldPos = hasMarker(b.content, POSITIVE_MARKERS);
    const newExc = hasMarker(newContent, EXCEPTION_MARKERS);
    const oldExc = hasMarker(b.content, EXCEPTION_MARKERS);

    // Heuristic 1: Negation conflict (one negative, one affirmative)
    if (overlap >= minOverlap && newNeg !== oldNeg) {
      conflicts.push({
        id: b.id,
        content: b.content,
        reason: "Possible negation conflict (one says do, the other says avoid) with high term overlap"
      });
      continue;
    }

    // Heuristic 2: Opposite sentiment (must vs avoid)
    if (overlap >= minOverlap && ((newPos && oldNeg) || (oldPos && newNeg))) {
      conflicts.push({
        id: b.id,
        content: b.content,
        reason: "Opposite directives (must vs avoid) on similar subject matter"
      });
      continue;
    }

    // Heuristic 3: Scope conflict (always vs exception)
    if (overlap >= minOverlap && ((newPos && oldExc) || (oldPos && newExc))) {
      conflicts.push({
        id: b.id,
        content: b.content,
        reason: "Potential scope conflict (always vs exception) on overlapping topic"
      });
      continue;
    }
  }

  return conflicts;
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
    state: "active", 
    maturity: "candidate", 
    createdAt: now(),
    updatedAt: now(),
    sourceSessions: bullet.sourceSessions,
    sourceAgents: bullet.sourceAgents,
    tags: [...bullet.tags, "inverted", "anti-pattern"],
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
  const existingHashes = buildHashCache(referencePlaybook);
  
  const result: CurationResult = {
    playbook: targetPlaybook, // Mutating target
    applied: 0,
    skipped: 0,
    conflicts: [],
    promotions: [],
    inversions: [],
    pruned: 0
  };

  for (const delta of deltas) {
    let applied = false;

    switch (delta.type) {
      case "add": {
        if (!delta.bullet?.content || !delta.bullet?.category) {
          break;
        }
        
        const content = delta.bullet.content;
        const hash = hashContent(content);
        // Conflict detection (warnings only)
        const conflicts = detectConflicts(content, referencePlaybook.bullets);
        for (const c of conflicts) {
          result.conflicts.push({
            newBulletContent: content,
            conflictingBulletId: c.id,
            conflictingContent: c.content,
            reason: c.reason
          });
        }

        // 1. Exact duplicate check (against reference/merged)
        if (existingHashes.has(hash)) {
          // Don't increment skipped here - handled at end of loop when applied=false
          break;
        }
        
        // 2. Semantic duplicate check (against reference/merged)
        const similar = findSimilarBullet(content, referencePlaybook, config.dedupSimilarityThreshold);
        if (similar) {
          // Optimization: Check if 'similar' is in targetPlaybook.
          const targetSimilar = findBullet(targetPlaybook, similar.id);
          if (targetSimilar) {
             targetSimilar.feedbackEvents.push({
                type: "helpful",
                timestamp: now(),
                sessionPath: delta.sourceSession,
                context: "Reinforced by similar insight"
             });
             targetSimilar.helpfulCount++;
             targetSimilar.updatedAt = now();
             applied = true;  // Fix: set applied flag instead of incrementing directly
          } else {
             // Exists in Repo but not Global. Skip adding to Global to avoid duplication.
             // Note: applied remains false, will be counted as skipped at end of loop
          }
          break;
        }
        
        // 3. Add new (to TARGET)
        addBullet(targetPlaybook, {
          content,
          category: delta.bullet.category,
          tags: delta.bullet.tags
        }, delta.sourceSession, config.scoring.decayHalfLifeDays);
        
        existingHashes.add(hash);
        applied = true;
        break;
      }

      case "helpful": {
        const bullet = findBullet(targetPlaybook, delta.bulletId);
        if (bullet) {
          // Idempotency check
          const alreadyRecorded = bullet.feedbackEvents.some(e => 
            e.type === "helpful" && 
            e.sessionPath && 
            delta.sourceSession && 
            e.sessionPath === delta.sourceSession
          );

          if (alreadyRecorded) {
            // Don't increment skipped here - handled at end of loop when applied=false
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
        }
        break;
      }

      case "harmful": {
        const bullet = findBullet(targetPlaybook, delta.bulletId);
        if (bullet) {
          // Idempotency check
          const alreadyRecorded = bullet.feedbackEvents.some(e => 
            e.type === "harmful" && 
            e.sessionPath && 
            delta.sourceSession && 
            e.sessionPath === delta.sourceSession
          );

          if (alreadyRecorded) {
            // Don't increment skipped here - handled at end of loop when applied=false
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
        }
        break;
      }

      case "replace": {
        const bullet = findBullet(targetPlaybook, delta.bulletId);
        if (bullet) {
          bullet.content = delta.newContent;
          bullet.updatedAt = now();
          applied = true;
        }
        break;
      }

      case "deprecate": {
        if (deprecateBullet(targetPlaybook, delta.bulletId, delta.reason, delta.replacedBy)) {
          applied = true;
        }
        break;
      }
      
      case "merge": {
        // Only merge if all bullets exist in target
        const bulletsToMerge = delta.bulletIds.map(id => findBullet(targetPlaybook, id)).filter(b => b !== undefined) as PlaybookBullet[];
        
        if (bulletsToMerge.length === delta.bulletIds.length && bulletsToMerge.length >= 2) {
          const merged = addBullet(targetPlaybook, {
            content: delta.mergedContent,
            category: bulletsToMerge[0].category, 
            tags: [...new Set(bulletsToMerge.flatMap(b => b.tags))]
          }, "merged", config.scoring?.decayHalfLifeDays ?? config.defaultDecayHalfLife ?? 90); 
          
          bulletsToMerge.forEach(b => {
            deprecateBullet(targetPlaybook, b.id, `Merged into ${merged.id}`, merged.id);
          });
          
          applied = true;
        }
        break;
      }
    }

    if (applied) result.applied++;
    else result.skipped++;
  }

  // --- Post-Processing on TARGET ---

  // 1. Anti-Pattern Inversion (must run BEFORE auto-deprecation)
  // Harmful rules should be converted to anti-patterns, not just deprecated
  const inversions: InversionReport[] = [];
  const invertedBulletIds = new Set<string>();

  for (const bullet of targetPlaybook.bullets) {
    if (bullet.deprecated || bullet.pinned || bullet.kind === "anti_pattern") continue;

    const { decayedHarmful, decayedHelpful } = getDecayedCounts(bullet, config);

    if (decayedHarmful >= 3 && decayedHarmful > (decayedHelpful * 2)) {
      if (bullet.isNegative) {
        // Negative rule found harmful -> likely incorrect. Just deprecate, don't invert.
        deprecateBullet(targetPlaybook, bullet.id, "Negative rule marked harmful (likely incorrect restriction)");
        result.pruned++; // Count as pruning since we just killed it
      } else {
        // Positive rule found harmful -> Invert to anti-pattern
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
      }
    }
  }
  result.inversions = inversions;

  // 2. Promotions & Demotions (after inversion so we don't double-deprecate)
  for (const bullet of targetPlaybook.bullets) {
    // Skip deprecated bullets and bullets that were just inverted
    if (bullet.deprecated || invertedBulletIds.has(bullet.id)) continue;

    const oldMaturity = bullet.maturity;
    const newMaturity = checkForPromotion(bullet, config);

    if (newMaturity !== oldMaturity) {
      bullet.maturity = newMaturity;
      result.promotions.push({
        bulletId: bullet.id,
        from: oldMaturity,
        to: newMaturity,
        reason: `Auto-promoted from ${oldMaturity} to ${newMaturity}`
      });
    }

    const demotionCheck = checkForDemotion(bullet, config);
    if (demotionCheck === "auto-deprecate") {
      deprecateBullet(targetPlaybook, bullet.id, "Auto-deprecated due to negative score");
      result.pruned++;
    } else if (demotionCheck !== bullet.maturity) {
      bullet.maturity = demotionCheck;
    }
  }

  return result;
}
