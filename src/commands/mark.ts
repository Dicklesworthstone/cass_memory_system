import { loadConfig } from "../config.js";
import {
  loadMergedPlaybook,
  loadPlaybook,
  savePlaybook,
  findBullet,
} from "../playbook.js";
import { getEffectiveScore, calculateMaturityState } from "../scoring.js";
import { now, error as logError, expandPath } from "../utils.js";
import chalk from "chalk";
import { HarmfulReason, FeedbackEvent } from "../types.js";

export async function markCommand(
  bulletId: string,
  flags: { helpful?: boolean; harmful?: boolean; reason?: string; session?: string; json?: boolean }
) {
  if (!flags.helpful && !flags.harmful) {
    logError("Must specify --helpful or --harmful");
    process.exit(1);
  }

  const config = await loadConfig();
  // We need to load the specific playbook where this bullet lives to save it.
  // loadMergedPlaybook gives us a view, but saving back is tricky if it's merged.
  // Simplified V1: Load global playbook. If not found, check repo.
  // Actually, findBullet search in merged, but we need to know WHICH file to save to.
  // For now, let's assume global playbook for V1 or intelligent save in playbook.ts.
  // Let's load the actual file containing the bullet.
  
  // Strategy: search merged for existence, then update whichever file actually contains the bullet.
  const merged = await loadMergedPlaybook(config);
  const mergedBullet = findBullet(merged, bulletId);
  if (!mergedBullet) {
    logError(`Bullet not found: ${bulletId}`);
    process.exit(1);
  }

  const globalPath = expandPath(config.playbookPath);
  const repoPath = expandPath(".cass/playbook.yaml");

  let targetPlaybook = await loadPlaybook(globalPath);
  let targetBullet = findBullet(targetPlaybook, bulletId);
  let saveTarget = globalPath;

  if (!targetBullet) {
    targetPlaybook = await loadPlaybook(repoPath);
    targetBullet = findBullet(targetPlaybook, bulletId);
    saveTarget = repoPath;
  }

  if (!targetBullet) {
    logError(`Critical error: Bullet ${bulletId} found in merged view but not in files.`);
    process.exit(1);
  }

  // Apply Update
  const type: "helpful" | "harmful" = flags.helpful ? "helpful" : "harmful";
  const reason: HarmfulReason | undefined =
    type === "harmful"
      ? (["caused_bug","wasted_time","contradicted_requirements","wrong_context","outdated","other"] as const)
          .includes((flags.reason ?? "other") as HarmfulReason)
          ? (flags.reason as HarmfulReason)
          : "other"
      : undefined;

  const event: FeedbackEvent = { type, timestamp: now(), sessionPath: flags.session, reason };

  if (type === "helpful") {
    targetBullet.helpfulEvents.push(event);
    targetBullet.helpfulCount++;
  } else {
    targetBullet.harmfulEvents.push(event);
    targetBullet.harmfulCount++;
  }

  // Maintain legacy combined list for compatibility
  targetBullet.feedbackEvents = targetBullet.feedbackEvents || [];
  targetBullet.feedbackEvents.push(event);

  targetBullet.updatedAt = now();
  
  // Update State
  targetBullet.maturity = calculateMaturityState(targetBullet, config);

  // Save
  await savePlaybook(targetPlaybook, saveTarget);

  // Log Usage? (skip for V1 minimalist)

  // Output
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
}
