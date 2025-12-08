import { loadConfig } from "../config.js";
import { loadPlaybook, savePlaybook, findBullet } from "../playbook.js";
import { getEffectiveScore, calculateMaturityState } from "../scoring.js";
import { now, error as logError, expandPath } from "../utils.js";
import { HarmfulReason, HarmfulReasonEnum, FeedbackEvent } from "../types.js";
import { withLock } from "../lock.js";
import chalk from "chalk";

export async function markCommand(
  bulletId: string,
  flags: { helpful?: boolean; harmful?: boolean; reason?: string; session?: string; json?: boolean }
) {
  if (!flags.helpful && !flags.harmful) {
    logError("Must specify --helpful or --harmful");
    process.exit(1);
  }

  const config = await loadConfig();
  
  // Determine source file location
  const globalPath = expandPath(config.playbookPath);
  const repoPath = expandPath(".cass/playbook.yaml");

  let saveTarget = globalPath;
  try {
    const repoPlaybook = await loadPlaybook(repoPath);
    if (findBullet(repoPlaybook, bulletId)) {
      saveTarget = repoPath;
    }
  } catch {
    // Ignore if repo playbook doesn't exist, stick to global
  }

  await withLock(saveTarget, async () => {
    const targetPlaybook = await loadPlaybook(saveTarget);
    const targetBullet = findBullet(targetPlaybook, bulletId);

    if (!targetBullet) {
      logError(`Bullet ${bulletId} not found in ${saveTarget} during write lock.`);
      process.exit(1);
    }

    const type: "helpful" | "harmful" = flags.helpful ? "helpful" : "harmful";
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

    targetBullet.updatedAt = now();
    targetBullet.maturity = calculateMaturityState(targetBullet, config);

    await savePlaybook(targetPlaybook, saveTarget);
    
    // For output
    const score = getEffectiveScore(targetBullet, config);
    
    if (flags.json) {
      console.log(JSON.stringify({
        success: true,
        bulletId,
        type,
        newState: targetBullet.maturity,
        effectiveScore: score
      }, null, 2));
    } else {
      console.log(chalk.green(`✓ Marked bullet ${bulletId} as ${type}`));
      console.log(`  New State: ${targetBullet.maturity}`);
      console.log(`  Effective Score: ${score.toFixed(2)}`);
    }
  });
}
