import { loadConfig } from "../config.js";
import { loadMergedPlaybook, deprecateBullet, savePlaybook, findBullet, addBullet } from "../playbook.js";
import { loadToxicLog, appendToxicLog } from "../playbook.js";
import { now, error as logError } from "../utils.js";
import { InversionReport } from "../types.js";
import chalk from "chalk";

export async function forgetCommand(
  bulletId: string, 
  flags: { reason?: string; invert?: boolean; json?: boolean }
) {
  if (!flags.reason) {
    logError("Reason required for forget");
    process.exit(1);
  }

  const config = await loadConfig();
  
  // We need to target the specific playbook
  const { loadPlaybook } = await import("../playbook.js");
  let playbook = await loadPlaybook(config.playbookPath);
  let savePath = config.playbookPath;
  let bullet = findBullet(playbook, bulletId);

  if (!bullet) {
    const repoPath = ".cass/playbook.yaml";
    playbook = await loadPlaybook(repoPath);
    bullet = findBullet(playbook, bulletId);
    savePath = repoPath;
  }

  if (!bullet) {
    logError(`Bullet ${bulletId} not found`);
    process.exit(1);
  }

  // 1. Add to toxic log
  await appendToxicLog({
    id: bullet.id,
    content: bullet.content,
    reason: flags.reason,
    forgottenAt: now()
  }, "~/.cass-memory/toxic_bullets.log");

  // 2. Invert if requested
  let antiPatternId: string | undefined;
  if (flags.invert) {
    const antiPattern = addBullet(playbook, {
      content: `AVOID: ${bullet.content}. ${flags.reason}`,
      category: bullet.category,
      type: "anti-pattern",
      isNegative: true,
      tags: [...bullet.tags, "inverted"]
    }, "forget-command", config.defaultDecayHalfLife);
    antiPatternId = antiPattern.id;
  }

  // 3. Deprecate original
  deprecateBullet(playbook, bulletId, flags.reason, antiPatternId);

  await savePlaybook(playbook, savePath);

  if (flags.json) {
    console.log(JSON.stringify({
      success: true,
      bulletId,
      action: "forgotten",
      inverted: !!antiPatternId,
      antiPatternId
    }, null, 2));
  } else {
    console.log(chalk.green(`✓ Forgot bullet ${bulletId}`));
    if (antiPatternId) {
      console.log(chalk.blue(`  Inverted to anti-pattern: ${antiPatternId}`));
    }
  }
}
