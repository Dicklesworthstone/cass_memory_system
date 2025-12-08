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
    .replace(/^(always |prefer |use |try |consider )/i, "")
    .trim();
  const invertedContent = `AVOID: ${cleaned}. ${reason}`;

  const halfLife = config.scoring?.decayHalfLifeDays ?? config.defaultDecayHalfLife ?? 90;

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
    helpfulEvents: [], // Fixed: Added missing field
    harmfulEvents: [], // Fixed: Added missing field
    helpfulCount: 0,
    harmfulCount: 0,
    deprecated: false,
    pinned: false,
    confidenceDecayHalfLifeDays: halfLife 
  };
}

// --- Main Curator ---

export function curatePlaybook(
  playbook: Playbook,
  deltas: PlaybookDelta[],
  config: Config
): CurationResult {
  const existingHashes = buildHashCache(playbook);
  
  const result: CurationResult = {
    playbook, // Reference
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
        
        // 1. Exact duplicate check
        if (existingHashes.has(hash)) {
          result.skipped++;
          break;
        }
        
        // 2. Semantic duplicate check
        const similar = findSimilarBullet(content, playbook, config.dedupSimilarityThreshold);
        if (similar) {
          // Boost existing instead of adding
          similar.feedbackEvents.push({
            type: "helpful",
            timestamp: now(),
            sessionPath: delta.sourceSession,
            context: "Reinforced by similar insight"
          });
          similar.helpfulCount++;
          similar.updatedAt = now();
          result.applied++; 
          break;
        }
        
        // 3. Add new
        addBullet(playbook, {
          content,
          category: delta.bullet.category,
          tags: delta.bullet.tags
        }, delta.sourceSession, config.scoring?.decayHalfLifeDays ?? config.defaultDecayHalfLife ?? 90);
        
        existingHashes.add(hash);
        applied = true;
        break;
      }

      case "helpful": {
        const bullet = findBullet(playbook, delta.bulletId);
        if (bullet) {
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
        const bullet = findBullet(playbook, delta.bulletId);
        if (bullet) {
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
        const bullet = findBullet(playbook, delta.bulletId);
        if (bullet) {
          bullet.content = delta.newContent;
          bullet.updatedAt = now();
          applied = true;
        }
        break;
      }

      case "deprecate": {
        if (deprecateBullet(playbook, delta.bulletId, delta.reason, delta.replacedBy)) {
          applied = true;
        }
        break;
      }
      
      case "merge": {
        const bulletsToMerge = delta.bulletIds.map(id => findBullet(playbook, id)).filter(b => b !== undefined) as PlaybookBullet[];
        if (bulletsToMerge.length >= 2) {
          const merged = addBullet(playbook, {
            content: delta.mergedContent,
            category: bulletsToMerge[0].category, 
            tags: [...new Set(bulletsToMerge.flatMap(b => b.tags))]
          }, "merged", config.scoring?.decayHalfLifeDays ?? config.defaultDecayHalfLife ?? 90); 
          
          bulletsToMerge.forEach(b => {
            deprecateBullet(playbook, b.id, `Merged into ${merged.id}`, merged.id);
          });
          
          applied = true;
        }
        break;
      }
    }

    if (applied) result.applied++;
    else result.skipped++;
  }

  // --- Post-Processing ---

  // 1. Promotions & Demotions
  for (const bullet of playbook.bullets) {
    if (bullet.deprecated) continue;

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
      deprecateBullet(playbook, bullet.id, "Auto-deprecated due to negative score");
      result.pruned++;
    } else if (demotionCheck !== bullet.maturity) {
      bullet.maturity = demotionCheck;
    }
  }

  // 2. Anti-Pattern Inversion
  const inversions: InversionReport[] = [];
  for (const bullet of playbook.bullets) {
    if (bullet.deprecated || bullet.pinned || bullet.kind === "anti_pattern") continue;
    
    const { decayedHarmful, decayedHelpful } = getDecayedCounts(bullet, config);
    
    if (decayedHarmful >= 3 && decayedHarmful > (decayedHelpful * 2)) {
      const antiPattern = invertToAntiPattern(bullet, config);
      playbook.bullets.push(antiPattern);
      
      deprecateBullet(playbook, bullet.id, `Inverted to anti-pattern: ${antiPattern.id}`, antiPattern.id);
      
      inversions.push({
        originalId: bullet.id,
        originalContent: bullet.content,
        antiPatternId: antiPattern.id,
        antiPatternContent: antiPattern.content,
        bulletId: bullet.id 
      });
    }
  }
  result.inversions = inversions;

  return result;
}
