import { loadConfig } from "../config.js";
import { loadMergedPlaybook, loadPlaybook, savePlaybook, findBullet, addBullet, loadToxicLog } from "../playbook.js";
import { withLock } from "../lock.js";
import { expandPath, error as logError, now } from "../utils.js";
import fs from "node:fs/promises";
import chalk from "chalk";

export interface ForgetCommandOptions {
  /** Reason for forgetting (required unless --list) */
  reason?: string;
  /** Create an anti-pattern from the forgotten bullet */
  invert?: boolean;
  /** List all toxic bullets */
  list?: boolean;
  /** Output as JSON */
  json?: boolean;
}

/**
 * List all toxic bullets from the toxic log.
 */
async function listToxicBullets(json: boolean): Promise<void> {
  const toxicLogPath = expandPath("~/.cass-memory/toxic_bullets.log");
  const toxicEntries = await loadToxicLog(toxicLogPath);

  if (json) {
    console.log(JSON.stringify({ toxicBullets: toxicEntries }, null, 2));
    return;
  }

  if (toxicEntries.length === 0) {
    console.log(chalk.yellow("No toxic bullets found."));
    return;
  }

  console.log(chalk.bold.red("\nTOXIC BULLETS (permanently blocked):\n"));

  for (const entry of toxicEntries) {
    const date = entry.forgottenAt ? new Date(entry.forgottenAt).toLocaleDateString() : "unknown";
    console.log(chalk.bold(`[${entry.id}] ${date}`));
    console.log(chalk.dim(`  "${entry.content}"`));
    console.log(`  Reason: ${entry.reason || "not provided"}`);
    console.log();
  }
}

/**
 * Main entry point for the 'cass-memory forget' command.
 *
 * Permanently blocks a pattern that should NEVER be suggested again.
 * More severe than deprecation - removes bullet from playbook entirely
 * and adds to toxic log to prevent future re-learning.
 *
 * @param bulletId - ID of the bullet to forget (ignored if --list)
 * @param options - Command options
 *
 * @example
 * cass-memory forget b-abc123 --reason "Caused production outage"
 * cass-memory forget --list
 * cass-memory forget b-abc123 --reason "Security issue" --invert
 */
export async function forgetCommand(
  bulletId: string,
  options: ForgetCommandOptions = {}
): Promise<void> {
  // Handle --list flag
  if (options.list) {
    await listToxicBullets(options.json || false);
    return;
  }

  // Validate required parameters
  if (!bulletId || bulletId.trim() === "") {
    logError("Bullet ID is required");
    process.exit(1);
  }

  if (!options.reason || options.reason.trim() === "") {
    logError("Reason is required for forget command (use --reason)");
    process.exit(1);
  }

  const config = await loadConfig();
  const globalPath = expandPath(config.playbookPath);

  // Lock global playbook for safe modification
  await withLock(globalPath, async () => {
    // Try to find bullet in global playbook first
    let playbook = await loadPlaybook(globalPath);
    let bullet = findBullet(playbook, bulletId);
    let savePath = globalPath;

    if (!bullet) {
      // Check repo-level playbook
      const repoPath = expandPath(".cass/playbook.yaml");
      try {
        playbook = await loadPlaybook(repoPath);
        bullet = findBullet(playbook, bulletId);
        savePath = repoPath;
      } catch {
        // Repo playbook doesn't exist, that's fine
      }
    }

    if (!bullet) {
      logError(`Bullet ${bulletId} not found in any playbook`);
      process.exit(1);
    }

    // Store bullet info before removal
    const bulletContent = bullet.content;
    const bulletCategory = bullet.category;
    const bulletScope = bullet.scope;

    // 1. Add to toxic log BEFORE removing (for audit trail)
    const toxicLogPath = expandPath("~/.cass-memory/toxic_bullets.log");
    const toxicEntry = {
      id: bullet.id,
      content: bulletContent,
      reason: options.reason,
      forgottenAt: now(),
      originalBullet: {
        category: bulletCategory,
        scope: bulletScope,
        kind: bullet.kind,
        type: bullet.type,
        feedbackEvents: bullet.feedbackEvents
      }
    };

    // Ensure directory exists
    const toxicDir = expandPath("~/.cass-memory");
    await fs.mkdir(toxicDir, { recursive: true });
    await fs.appendFile(toxicLogPath, JSON.stringify(toxicEntry) + "\n");

    // 2. Create anti-pattern if --invert requested (before removing original)
    let antiPatternId: string | undefined;
    if (options.invert) {
      const antiPattern = addBullet(playbook, {
        content: `AVOID: ${bulletContent}. ${options.reason}`,
        category: bulletCategory,
        kind: "anti_pattern",
        type: "anti-pattern",
        isNegative: true,
        scope: bulletScope
      }, "manual-forget", config.scoring.decayHalfLifeDays);
      antiPatternId = antiPattern.id;
    }

    // 3. REMOVE bullet entirely from playbook (not just deprecate)
    playbook.bullets = playbook.bullets.filter(b => b.id !== bulletId);

    // Save updated playbook
    await savePlaybook(playbook, savePath);

    // Output result
    if (options.json) {
      console.log(JSON.stringify({
        success: true,
        bulletId,
        action: "forgotten",
        content: bulletContent,
        reason: options.reason,
        antiPatternId,
        toxicLogPath
      }, null, 2));
    } else {
      console.log(chalk.green(`✓ Forgot bullet ${bulletId}`));
      console.log(chalk.dim(`  "${bulletContent}"`));
      if (antiPatternId) {
        console.log(chalk.green(`  Created anti-pattern ${antiPatternId}`));
      }
      console.log(chalk.dim("  Removed from playbook and added to toxic log."));
      console.log(chalk.dim("  This pattern will be blocked from future proposals."));
    }
  });
}