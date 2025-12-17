/**
 * undo command - Revert bad curation decisions
 *
 * Supports:
 * - Un-deprecate a bullet that was accidentally forgotten/deprecated
 * - Undo the most recent feedback event on a bullet
 * - Remove a bullet entirely (hard delete)
 */
import { loadConfig } from "../config.js";
import { loadPlaybook, savePlaybook, findBullet, removeFromBlockedLog } from "../playbook.js";
import { ErrorCode, PlaybookBullet, Config, FeedbackEvent } from "../types.js";
import { now, expandPath, getCliName, truncate, confirmDangerousAction, resolveRepoDir, fileExists, printJsonResult, reportError } from "../utils.js";
import { withLock } from "../lock.js";
import chalk from "chalk";
import { icon } from "../output.js";
import path from "node:path";

export interface UndoFlags {
  feedback?: boolean;
  hard?: boolean;
  yes?: boolean;
  dryRun?: boolean;
  json?: boolean;
  reason?: string;
}

interface UndoResult {
  bulletId: string;
  action: "un-deprecate" | "undo-feedback" | "hard-delete";
  path?: string;
  preview?: string;
  before: {
    deprecated?: boolean;
    deprecatedAt?: string;
    deprecationReason?: string;
    state?: string;
    maturity?: string;
    helpfulCount?: number;
    harmfulCount?: number;
    lastFeedback?: FeedbackEvent | null;
  };
  after: {
    deprecated?: boolean;
    state?: string;
    maturity?: string;
    helpfulCount?: number;
    harmfulCount?: number;
    feedbackEventsCount?: number;
    deleted?: boolean;
  };
  message: string;
}

/**
 * Un-deprecate a bullet - restore it to active state
 */
function undeprecateBullet(bullet: PlaybookBullet): UndoResult["before"] {
  const before = {
    deprecated: bullet.deprecated,
    deprecatedAt: bullet.deprecatedAt,
    deprecationReason: bullet.deprecationReason,
    state: bullet.state,
    maturity: bullet.maturity
  };

  // Restore to active state
  bullet.deprecated = false;
  bullet.deprecatedAt = undefined;
  bullet.deprecationReason = undefined;
  bullet.state = "active";
  // Restore to candidate if it was deprecated, otherwise keep current
  if (bullet.maturity === "deprecated") {
    bullet.maturity = "candidate";
  }
  bullet.updatedAt = now();

  return before;
}

/**
 * Undo the most recent feedback event on a bullet
 */
function undoLastFeedback(bullet: PlaybookBullet): {
  before: UndoResult["before"];
  removedEvent: FeedbackEvent | null;
} {
  const events = bullet.feedbackEvents || [];
  const lastEvent = events.length > 0 ? events[events.length - 1] : null;

  const before = {
    helpfulCount: bullet.helpfulCount,
    harmfulCount: bullet.harmfulCount,
    lastFeedback: lastEvent
  };

  if (lastEvent) {
    // Remove the last event
    bullet.feedbackEvents = events.slice(0, -1);

    // Adjust counts
    if (lastEvent.type === "helpful") {
      bullet.helpfulCount = Math.max(0, (bullet.helpfulCount || 0) - 1);
    } else if (lastEvent.type === "harmful") {
      bullet.harmfulCount = Math.max(0, (bullet.harmfulCount || 0) - 1);
    }

    bullet.updatedAt = now();
  }

  return { before, removedEvent: lastEvent };
}

/**
 * Get the playbook path where the bullet lives (global or repo)
 */
async function findBulletLocation(
  bulletId: string,
  config: Config
): Promise<{ playbook: ReturnType<typeof loadPlaybook> extends Promise<infer T> ? T : never; path: string; location: "global" | "repo" } | null> {
  // Check repo-level first (git root). Only use it when `.cass/playbook.yaml` exists.
  const repoDir = await resolveRepoDir();
  const repoPath = repoDir ? path.join(repoDir, "playbook.yaml") : null;
  if (repoPath && await fileExists(repoPath)) {
    const repoPlaybook = await loadPlaybook(repoPath);
    const bullet = findBullet(repoPlaybook, bulletId);
    if (bullet) {
      return { playbook: repoPlaybook, path: repoPath, location: "repo" };
    }
  }

  // Check global
  const globalPath = expandPath(config.playbookPath);
  const globalPlaybook = await loadPlaybook(globalPath);
  const bullet = findBullet(globalPlaybook, bulletId);
  if (bullet) {
    return { playbook: globalPlaybook, path: globalPath, location: "global" };
  }

  return null;
}

export async function undoCommand(
  bulletId: string,
  flags: UndoFlags = {}
): Promise<void> {
  const startedAtMs = Date.now();
  const command = "undo";
  const config = await loadConfig();
  const cli = getCliName();
  const repoDir = await resolveRepoDir();

  // Find which playbook contains this bullet
  let location: Awaited<ReturnType<typeof findBulletLocation>>;
  try {
    location = await findBulletLocation(bulletId, config);
  } catch (err: any) {
    const message = err?.message || String(err);
    reportError(err instanceof Error ? err : message, {
      code: ErrorCode.PLAYBOOK_CORRUPT,
      hint: repoDir
        ? `Fix or remove the repo playbook at ${path.join(repoDir, "playbook.yaml")} (or run from outside the repo).`
        : "Fix your playbook file and re-run.",
      details: { bulletId },
      json: flags.json,
      command,
      startedAtMs,
    });
    return;
  }

  if (!location) {
    reportError(`Bullet not found: ${bulletId}`, {
      code: ErrorCode.BULLET_NOT_FOUND,
      details: { bulletId },
      json: flags.json,
      command,
      startedAtMs,
    });
    return;
  }

  const { playbook, path: playbookPath, location: loc } = location;

  // Use withLock for consistent concurrent access safety
  try {
    await withLock(playbookPath, async () => {
      // Reload inside lock to prevent race conditions
      const currentPlaybook = await loadPlaybook(playbookPath);
      const bullet = findBullet(currentPlaybook, bulletId);

      if (!bullet) {
        // Throw to release lock and propagate error to outer try/catch
        throw new Error(`Bullet ${bulletId} not found in ${playbookPath} during write lock.`);
      }

    const preview = truncate(bullet.content.trim().replace(/\s+/g, " "), 100);

    // Handle --dry-run: show what would happen without making changes
    if (flags.dryRun) {
      const events = bullet.feedbackEvents || [];
      const lastEvent = events.length > 0 ? events[events.length - 1] : null;

      let actionType: string;
      let wouldChange: string;
      let applyCommand: string;

      if (flags.hard) {
        actionType = "hard-delete";
        wouldChange = "Bullet would be permanently removed from playbook";
        applyCommand = `${cli} undo ${bulletId} --hard --yes`;
      } else if (flags.feedback) {
        if (!lastEvent) {
          reportError(`No feedback events to undo for bullet ${bulletId}`, {
            code: ErrorCode.INVALID_INPUT,
            details: { bulletId, action: "undo-feedback" },
            json: flags.json,
            command,
            startedAtMs,
          });
          return;
        }
        actionType = "undo-feedback";
        wouldChange = `Would remove last ${lastEvent.type} feedback from ${lastEvent.timestamp?.slice(0, 10) || "unknown"}`;
        applyCommand = `${cli} undo ${bulletId} --feedback`;
      } else {
        if (!bullet.deprecated) {
          reportError(`Bullet ${bulletId} is not deprecated`, {
            code: ErrorCode.INVALID_INPUT,
            hint: "Use --feedback to undo the last feedback event, or --hard to delete",
            details: { bulletId, action: "un-deprecate" },
            json: flags.json,
            command,
            startedAtMs,
          });
          return;
        }
        actionType = "un-deprecate";
        wouldChange = "Bullet would be restored to active state (deprecated → active, maturity reset to candidate if needed)";
        applyCommand = `${cli} undo ${bulletId}`;
      }

      const plan = {
        dryRun: true,
        action: actionType,
        bulletId,
        path: playbookPath,
        location: loc,
        preview,
        category: bullet.category,
        before: {
          deprecated: bullet.deprecated,
          state: bullet.state,
          maturity: bullet.maturity,
          helpfulCount: bullet.helpfulCount,
          harmfulCount: bullet.harmfulCount,
          ...(flags.feedback && lastEvent ? { lastFeedback: lastEvent } : {}),
        },
        wouldChange,
        applyCommand,
      };

      if (flags.json) {
        printJsonResult(command, { plan }, { startedAtMs });
      } else {
        console.log(chalk.bold.yellow("DRY RUN - No changes will be made"));
        console.log(chalk.gray("─".repeat(50)));
        console.log();
        console.log(`Action: ${chalk.bold(actionType.toUpperCase())}`);
        console.log(`Bullet ID: ${chalk.cyan(bulletId)}`);
        console.log(`File: ${chalk.gray(playbookPath)} (${loc})`);
        console.log(`Preview: ${chalk.cyan(`"${preview}"`)}`);
        console.log(`Category: ${chalk.cyan(bullet.category)}`);
        console.log(`Feedback: ${bullet.helpfulCount || 0}+ / ${bullet.harmfulCount || 0}-`);
        console.log(`State: ${bullet.state}, Maturity: ${bullet.maturity}, Deprecated: ${bullet.deprecated}`);
        if (flags.feedback && lastEvent) {
          console.log(`Last feedback: ${chalk.yellow(lastEvent.type)} at ${lastEvent.timestamp?.slice(0, 10) || "unknown"}`);
        }
        console.log();
        console.log(chalk.yellow(`Would: ${wouldChange}`));
        console.log();
        console.log(chalk.gray(`To apply: ${applyCommand}`));
      }
      return;
    }

    let result: UndoResult;

    if (flags.hard) {
      const confirmed = await confirmDangerousAction({
        action: `Permanently delete bullet ${bulletId} (${loc} playbook)`,
        details: [
          `File: ${playbookPath}`,
          `Preview: "${preview}"`,
          `Tip: Use --yes to confirm in non-interactive mode`,
        ],
        confirmPhrase: "DELETE",
        yes: flags.yes,
        json: flags.json,
      });

      if (!confirmed) {
        reportError("Confirmation required for --hard deletion", {
          code: ErrorCode.MISSING_REQUIRED,
          hint: "Re-run with --yes in non-interactive mode",
          details: { confirmPhrase: "DELETE" },
          json: flags.json,
          command,
          startedAtMs,
        });
        return;
      }

      // Hard delete - remove the bullet entirely
      const before = {
        deprecated: bullet.deprecated,
        state: bullet.state,
        maturity: bullet.maturity,
        helpfulCount: bullet.helpfulCount,
        harmfulCount: bullet.harmfulCount
      };

      const index = currentPlaybook.bullets.findIndex(b => b.id === bulletId);
      if (index === -1) {
        throw new Error(`Bullet ${bulletId} not found in ${playbookPath} during deletion.`);
      }
      currentPlaybook.bullets.splice(index, 1);
      await savePlaybook(currentPlaybook, playbookPath);

      result = {
        bulletId,
        action: "hard-delete",
        path: playbookPath,
        preview,
        before,
        after: { deleted: true },
        message: `Permanently deleted bullet ${bulletId} from ${loc} playbook`
      };
    } else if (flags.feedback) {
      // Undo last feedback event
      const { before, removedEvent } = undoLastFeedback(bullet);

      if (!removedEvent) {
        reportError(`No feedback events to undo for bullet ${bulletId}`, {
          code: ErrorCode.INVALID_INPUT,
          details: { bulletId, action: "undo-feedback" },
          json: flags.json,
          command,
          startedAtMs,
        });
        return;
      }

      await savePlaybook(currentPlaybook, playbookPath);

      result = {
        bulletId,
        action: "undo-feedback",
        before,
        after: {
          helpfulCount: bullet.helpfulCount,
          harmfulCount: bullet.harmfulCount,
          feedbackEventsCount: (bullet.feedbackEvents || []).length
        },
        message: `Removed last ${removedEvent.type} feedback from ${bulletId}`
      };
    } else {
      // Default: un-deprecate
      if (!bullet.deprecated) {
        reportError(`Bullet ${bulletId} is not deprecated`, {
          code: ErrorCode.INVALID_INPUT,
          hint: "Use --feedback to undo the last feedback event, or --hard to delete",
          details: { bulletId, action: "un-deprecate" },
          json: flags.json,
          command,
          startedAtMs,
        });
        return;
      }

      const before = undeprecateBullet(bullet);

      // Also remove from blocklist(s) so it doesn't get re-blocked on next load
      await removeFromBlockedLog(bulletId, "~/.cass-memory/blocked.log");
      if (repoDir) {
        const repoBlockedLog = path.join(repoDir, "blocked.log");
        await removeFromBlockedLog(bulletId, repoBlockedLog);
      }

      await savePlaybook(currentPlaybook, playbookPath);

      result = {
        bulletId,
        action: "un-deprecate",
        before,
        after: {
          deprecated: bullet.deprecated,
          state: bullet.state,
          maturity: bullet.maturity
        },
        message: `Restored bullet ${bulletId} from deprecated state`
      };
    }

    if (flags.json) {
      printJsonResult(command, result, { startedAtMs });
    } else {
      printUndoResult(result, bullet);
    }
    });
  } catch (err: any) {
    const message = err?.message || String(err);
    const code = message.includes("not found") ? ErrorCode.BULLET_NOT_FOUND : ErrorCode.INTERNAL_ERROR;
    reportError(err instanceof Error ? err : message, { code, details: { bulletId }, json: flags.json, command, startedAtMs });
  }
}

function printUndoResult(result: UndoResult, bullet?: PlaybookBullet): void {
  console.log();

  if (result.action === "hard-delete") {
    console.log(chalk.red.bold("HARD DELETE"));
    console.log(chalk.gray("─".repeat(40)));
    console.log(`Bullet ${chalk.bold(result.bulletId)} has been permanently deleted.`);
    if (result.path) {
      console.log(`File: ${chalk.gray(result.path)}`);
    }
    if (result.preview) {
      console.log(`Preview: ${chalk.cyan(`"${result.preview}"`)}`);
    }
    console.log(chalk.yellow("This action cannot be undone."));
  } else if (result.action === "undo-feedback") {
    console.log(chalk.blue.bold("UNDO FEEDBACK"));
    console.log(chalk.gray("─".repeat(40)));
    console.log(`Bullet: ${chalk.bold(result.bulletId)}`);
    if (bullet) {
      console.log(`Content: ${chalk.cyan(`"${bullet.content.slice(0, 60)}${bullet.content.length > 60 ? "..." : ""}"`)}`)
    }
    console.log();
    console.log(`Removed: ${result.before.lastFeedback?.type} feedback from ${result.before.lastFeedback?.timestamp?.slice(0, 10) || "unknown"}`);
    console.log(`Counts: ${result.before.helpfulCount}+ / ${result.before.harmfulCount}- → ${result.after.helpfulCount}+ / ${result.after.harmfulCount}-`);
  } else {
    console.log(chalk.green.bold("UN-DEPRECATE"));
    console.log(chalk.gray("─".repeat(40)));
    console.log(`Bullet: ${chalk.bold(result.bulletId)}`);
    if (bullet) {
      console.log(`Content: ${chalk.cyan(`"${bullet.content.slice(0, 60)}${bullet.content.length > 60 ? "..." : ""}"`)}`)
    }
    console.log();
    console.log(`State: ${chalk.red(result.before.state || "retired")} → ${chalk.green(result.after.state)}`);
    console.log(`Maturity: ${chalk.red(result.before.maturity || "deprecated")} → ${chalk.green(result.after.maturity)}`);
    if (result.before.deprecationReason) {
      console.log(`Original reason: ${chalk.gray(result.before.deprecationReason)}`);
    }
  }

  console.log();
  console.log(chalk.green(`${icon("success")} ${result.message}`));
  console.log();
}
