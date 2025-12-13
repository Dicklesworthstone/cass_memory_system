import { loadConfig } from "../config.js";
import { loadPlaybook, savePlaybook, findBullet } from "../playbook.js";
import { getEffectiveScore, calculateMaturityState } from "../scoring.js";
import { now, error as logError, expandPath, resolveRepoDir } from "../utils.js";
import { HarmfulReason, HarmfulReasonEnum, FeedbackEvent } from "../types.js";
import { withLock } from "../lock.js";
import chalk from "chalk";
import path from "node:path";

type MarkFlags = { helpful?: boolean; harmful?: boolean; reason?: string; session?: string; json?: boolean };

/**
 * API-friendly feedback recorder (no console output, throws on error).
 */
export async function recordFeedback(
  bulletId: string,
  flags: MarkFlags
): Promise<{ type: "helpful" | "harmful"; score: number; state: string }> {
  if (!flags.helpful && !flags.harmful) {
    throw new Error("Must specify --helpful or --harmful");
  }

  const config = await loadConfig();

  const globalPath = expandPath(config.playbookPath);
  
  const repoDir = await resolveRepoDir();
  const repoPath = repoDir ? path.join(repoDir, "playbook.yaml") : null;

  let saveTarget = globalPath;
  if (repoPath) {
    try {
      const repoPlaybook = await loadPlaybook(repoPath);
      if (findBullet(repoPlaybook, bulletId)) {
        saveTarget = repoPath;
      }
    } catch {
      // Ignore if repo playbook doesn't exist or load fails, stick to global
    }
  }

  let score = 0;
  let state = "";
  const type: "helpful" | "harmful" = flags.helpful ? "helpful" : "harmful";

  await withLock(saveTarget, async () => {
    const targetPlaybook = await loadPlaybook(saveTarget);
    const targetBullet = findBullet(targetPlaybook, bulletId);

    if (!targetBullet) {
      throw new Error(`Bullet ${bulletId} not found in ${saveTarget} during write lock.`);
    }

    let reason: HarmfulReason | undefined = undefined;
    
    if (type === "harmful") {
      if (flags.reason && HarmfulReasonEnum.safeParse(flags.reason).success) {
        reason = flags.reason as HarmfulReason;
      } else {
        reason = "other";
      }
    }

    const event: FeedbackEvent = { 
      type, 
      timestamp: now(), 
      sessionPath: flags.session, 
      reason,
      context: flags.reason 
    };

    targetBullet.feedbackEvents = targetBullet.feedbackEvents || [];
    targetBullet.feedbackEvents.push(event);

    // Keep legacy counters in sync for backwards compatibility
    if (type === "helpful") {
      targetBullet.helpfulCount = (targetBullet.helpfulCount || 0) + 1;
    } else {
      targetBullet.harmfulCount = (targetBullet.harmfulCount || 0) + 1;
    }

    targetBullet.updatedAt = now();
    const newMaturity = calculateMaturityState(targetBullet, config);
    targetBullet.maturity = newMaturity;

    if (newMaturity === "deprecated" && !targetBullet.deprecated) {
        targetBullet.deprecated = true;
        targetBullet.deprecatedAt = now();
        targetBullet.state = "retired";
        targetBullet.deprecationReason = targetBullet.deprecationReason || "Automatically deprecated due to harmful feedback ratio";
    }

    await savePlaybook(targetPlaybook, saveTarget);
    
    score = getEffectiveScore(targetBullet, config);
    state = targetBullet.maturity;
  });

  return { type, score, state };
}

export async function markCommand(
  bulletId: string,
  flags: MarkFlags
): Promise<void> {
  try {
    const result = await recordFeedback(bulletId, flags);

    if (flags.json) {
      console.log(JSON.stringify({
        success: true,
        bulletId,
        type: result.type,
        newState: result.state,
        effectiveScore: result.score
      }, null, 2));
    } else {
      console.log(chalk.green(`✓ Marked bullet ${bulletId} as ${result.type}`));
      console.log(`  New State: ${result.state}`);
      console.log(`  Effective Score: ${result.score.toFixed(2)}`);
    }
  } catch (err: any) {
    logError(err?.message || String(err));
    process.exit(1);
  }
}
