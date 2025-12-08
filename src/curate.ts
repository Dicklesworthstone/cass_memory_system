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
    if (!b.deprecated) {
      cache.add(hashContent(b.content));
    }
  }
  return cache;
}

function findSimilarBullet(
  content: string, 
  playbook: Playbook, 
  threshold: number
): PlaybookBullet | undefined {
  for (const b of playbook.bullets) {
    if (b.deprecated) continue;
    if (jaccardSimilarity(content, b.content) >= threshold) {
      return b;
    }
  }
  return undefined;
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
    helpfulEvents: [],
    harmfulEvents: [],
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
        
        // 1. Exact duplicate check (against reference/merged)
        if (existingHashes.has(hash)) {
          result.skipped++;
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
             result.applied++;
          } else {
             // Exists in Repo but not Global. Skip adding to Global to avoid duplication.
             result.skipped++;
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
            result.skipped++;
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
            result.skipped++;
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
        reason: `Marked as toxic/anti-pattern`
      });
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
