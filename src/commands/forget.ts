import { loadConfig } from "../config.js";
import { loadPlaybook, savePlaybook, findBullet, addBullet } from "../playbook.js";
import { appendBlockedLog } from "../playbook.js";
import path from "node:path";
import { fileExists, now, error as logError, resolveRepoDir, expandPath, printJsonResult, printJsonError } from "../utils.js";
import { ErrorCode } from "../types.js";
import { withLock } from "../lock.js";
import chalk from "chalk";
import { icon } from "../output.js";

export async function forgetCommand(
  bulletId: string, 
  flags: { reason?: string; invert?: boolean; json?: boolean }
) {
  if (!flags.reason) {
    if (flags.json) {
      printJsonError("Reason required for forget", {
        code: ErrorCode.MISSING_REQUIRED,
        details: { missing: "reason", usage: "cm forget <bulletId> --reason <reason>" }
      });
    } else {
      logError("Reason required for forget");
    }
    process.exitCode = 1;
    return;
  }

  const config = await loadConfig();
  
  // Resolve save path safely
  const globalPath = expandPath(config.playbookPath);
  const repoDir = await resolveRepoDir();
  const repoPath = repoDir ? path.join(repoDir, "playbook.yaml") : null;

  let savePath = globalPath;
  
  // Check if bullet exists in repo first (pre-check, repeated inside lock)
  if (repoPath && (await fileExists(repoPath))) {
    try {
      const repoPlaybook = await loadPlaybook(repoPath);
      if (findBullet(repoPlaybook, bulletId)) {
        savePath = repoPath;
      }
    } catch {
      // Ignore
    }
  }

  await withLock(savePath, async () => {
    const playbook = await loadPlaybook(savePath);
    const bullet = findBullet(playbook, bulletId);

    if (!bullet) {
      // Throwing error allows lock to be released
      throw new Error(`Bullet ${bulletId} not found`);
    }

    // 1. Add to blocked log
    const blockedLogPath = savePath === repoPath
      ? path.join(path.dirname(repoPath!), "blocked.log")
      : "~/.cass-memory/blocked.log";

    await withLock(blockedLogPath, async () => {
      await appendBlockedLog({
        id: bullet.id,
        content: bullet.content,
        reason: flags.reason!,
        forgottenAt: now()
      }, blockedLogPath);
    });

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
    // Use dynamic import deprecated/removed or update import
    const { deprecateBullet } = await import("../playbook.js");
    deprecateBullet(playbook, bulletId, flags.reason!, antiPatternId);

    await savePlaybook(playbook, savePath);

    if (flags.json) {
      printJsonResult({
        bulletId,
        action: "forgotten",
        inverted: !!antiPatternId,
        antiPatternId
      });
    } else {
      console.log(chalk.green(`${icon("success")} Forgot bullet ${bulletId}`));
      if (antiPatternId) {
        console.log(chalk.blue(`  Inverted to anti-pattern: ${antiPatternId}`));
      }
    }
  });
}
