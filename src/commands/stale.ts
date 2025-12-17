/**
 * stale command - Find bullets without recent feedback
 *
 * Identifies rules that haven't received helpful/harmful feedback in N days.
 * Useful for cleanup sessions and finding outdated practices.
 */
import { loadConfig } from "../config.js";
import { loadMergedPlaybook, getActiveBullets } from "../playbook.js";
import { getEffectiveScore } from "../scoring.js";
import { getCliName, printJsonResult, reportError, validateOneOf, validatePositiveInt } from "../utils.js";
import { ErrorCode, PlaybookBullet } from "../types.js";
import chalk from "chalk";
import { formatRule, formatTipPrefix, getOutputStyle, wrapText } from "../output.js";

export interface StaleFlags {
  days?: number;
  scope?: "global" | "workspace" | "all";
  json?: boolean;
}

interface StaleBullet {
  id: string;
  daysSinceLastFeedback: number;
  content: string;
  category: string;
  scope: string;
  score: number;
  maturity: string;
  lastFeedback: {
    action: "helpful" | "harmful" | null;
    timestamp: string | null;
  };
  recommendation: string;
}

/**
 * Calculate days since a given date string
 */
function daysSince(dateStr: string): number {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

/**
 * Calculate staleness for a bullet
 * Returns days since last feedback, or days since creation if no feedback
 */
function calculateStaleness(bullet: PlaybookBullet): {
  days: number;
  lastAction: "helpful" | "harmful" | null;
  lastTimestamp: string | null;
} {
  const events = bullet.feedbackEvents || [];

  if (events.length === 0) {
    // No feedback - use creation date
    return {
      days: daysSince(bullet.createdAt),
      lastAction: null,
      lastTimestamp: null
    };
  }

  // Find most recent feedback event
  const sorted = [...events].sort((a, b) =>
    new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );
  const latest = sorted[0];

  return {
    days: daysSince(latest.timestamp),
    lastAction: latest.type,
    lastTimestamp: latest.timestamp
  };
}

/**
 * Generate recommendation based on staleness and score
 */
function getRecommendation(
  bulletId: string,
  daysSinceLastFeedback: number,
  score: number,
  maturity: string,
  cli: string
): string {
  if (score < -2) {
    return `Consider: ${cli} forget ${bulletId} --reason "<why>" (negative score suggests harm)`;
  }
  if (daysSinceLastFeedback > 180 && maturity === "candidate") {
    return `Very stale candidate - consider deprecating if no longer relevant (${cli} playbook remove ${bulletId} --reason "<why>")`;
  }
  if (daysSinceLastFeedback > 120 && score < 1) {
    return `Stale with low score - review for relevance (${cli} playbook get ${bulletId})`;
  }
  if (score > 5) {
    return "Good score despite being stale - may still be valid, review periodically";
  }
  return `Review for current relevance (${cli} playbook get ${bulletId})`;
}

export async function staleCommand(
  flags: StaleFlags = {}
): Promise<void> {
  const startedAtMs = Date.now();
  const command = "stale";
  const cli = getCliName();

  const daysCheck = validatePositiveInt(flags.days, "days", { min: 0, allowUndefined: true });
  if (!daysCheck.ok) {
    reportError(daysCheck.message, {
      code: ErrorCode.INVALID_INPUT,
      details: daysCheck.details,
      hint: `Example: ${cli} stale --days 90 --json`,
      json: flags.json,
      command,
      startedAtMs,
    });
    return;
  }

  const scopeCheck = validateOneOf(flags.scope, "scope", ["global", "workspace", "all"] as const, {
    allowUndefined: true,
    caseInsensitive: true,
  });
  if (!scopeCheck.ok) {
    reportError(scopeCheck.message, {
      code: ErrorCode.INVALID_INPUT,
      details: scopeCheck.details,
      hint: `Valid scopes: global, workspace, all`,
      json: flags.json,
      command,
      startedAtMs,
    });
    return;
  }

  const normalizedFlags: StaleFlags = {
    ...flags,
    ...(scopeCheck.value !== undefined ? { scope: scopeCheck.value } : {}),
  };

  const threshold = daysCheck.value ?? 90;
  const config = await loadConfig();
  const playbook = await loadMergedPlaybook(config);

  let bullets = getActiveBullets(playbook);

  // Apply scope filter
  if (normalizedFlags.scope && normalizedFlags.scope !== "all") {
    bullets = bullets.filter(b => b.scope === normalizedFlags.scope);
  }

  // Calculate staleness for each bullet
  const staleBullets: StaleBullet[] = [];

  for (const bullet of bullets) {
    const staleness = calculateStaleness(bullet);

    if (staleness.days >= threshold) {
      const score = getEffectiveScore(bullet, config);
      staleBullets.push({
        id: bullet.id,
        daysSinceLastFeedback: staleness.days,
        content: bullet.content,
        category: bullet.category || "uncategorized",
        scope: bullet.scope || "global",
        score: Number(score.toFixed(2)),
        maturity: bullet.maturity || "candidate",
        lastFeedback: {
          action: staleness.lastAction,
          timestamp: staleness.lastTimestamp
        },
        recommendation: getRecommendation(bullet.id, staleness.days, score, bullet.maturity || "candidate", cli)
      });
    }
  }

  // Sort by days descending (most stale first)
  staleBullets.sort((a, b) => b.daysSinceLastFeedback - a.daysSinceLastFeedback);

  if (flags.json) {
    printJsonResult(command, {
      threshold,
      count: staleBullets.length,
      totalActive: bullets.length,
      filters: {
        scope: normalizedFlags.scope || "all"
      },
      bullets: staleBullets
    }, { startedAtMs });
    return;
  }

  // Human-readable output
  printStaleBullets(staleBullets, threshold, bullets.length, normalizedFlags, cli);
}

function printStaleBullets(
  bullets: StaleBullet[],
  threshold: number,
  totalActive: number,
  flags: StaleFlags,
  cli: string
): void {
  const style = getOutputStyle();
  const maxWidth = Math.min(style.width, 84);
  const divider = chalk.dim(formatRule("─", { maxWidth }));
  const wrapWidth = Math.max(24, maxWidth - 6);

  const filterDesc: string[] = [];
  if (flags.scope && flags.scope !== "all") filterDesc.push(`scope: ${flags.scope}`);
  const filterStr = filterDesc.length > 0 ? ` • ${filterDesc.join(", ")}` : "";

  console.log(chalk.bold("STALE"));
  console.log(divider);
  console.log(chalk.dim(`Threshold: ${threshold}+ days • Found: ${bullets.length}/${totalActive}${filterStr}`));
  console.log("");

  if (bullets.length === 0) {
    console.log(chalk.green("No stale bullets found."));
    console.log(chalk.gray(`All ${totalActive} active bullets have recent feedback.`));
    console.log(chalk.gray(`${formatTipPrefix()}Try '${cli} stale --days 0' to review everything.`));
    return;
  }

  for (const b of bullets) {
    const scoreColor = b.score >= 5 ? chalk.green : b.score >= 0 ? chalk.white : chalk.red;
    const daysLabel = chalk.yellow(`${b.daysSinceLastFeedback}d`);
    const scoreLabel = scoreColor(b.score.toFixed(1));

    console.log(
      `${daysLabel} ${chalk.bold(`[${b.id}]`)}${chalk.dim(
        ` ${b.category}/${b.scope} • ${b.maturity} • score ${scoreLabel}`
      )}`
    );

    for (const line of wrapText(b.content.trim().replace(/\s+/g, " "), wrapWidth)) {
      console.log(chalk.gray(`  ${line}`));
    }

    if (b.lastFeedback.timestamp) {
      const action =
        b.lastFeedback.action === "helpful" ? chalk.green("helpful") : chalk.red("harmful");
      console.log(chalk.dim(`  Last feedback: ${b.lastFeedback.timestamp.slice(0, 10)} (${action})`));
    } else {
      console.log(chalk.dim("  Last feedback: (none yet)"));
    }

    for (const line of wrapText(b.recommendation, wrapWidth)) {
      console.log(chalk.cyan(`  ${line}`));
    }
    console.log("");
  }

  const veryStale = bullets.filter((b) => b.daysSinceLastFeedback > 180);
  const negative = bullets.filter((b) => b.score < 0);
  const candidates = bullets.filter((b) => b.maturity === "candidate" && b.daysSinceLastFeedback > 90);

  console.log(chalk.bold("Next actions"));
  console.log(divider);
  if (negative.length > 0) {
    const ids = negative.slice(0, 5).map((b) => b.id).join(", ");
    const suffix = negative.length > 5 ? ` (+${negative.length - 5} more)` : "";
    console.log(
      chalk.red(
        `- ${negative.length} with negative scores → review/forget (${cli} forget <id> --reason \"...\")`
      )
    );
    console.log(chalk.dim(`  IDs: ${ids}${suffix}`));
  }
  if (veryStale.length > 0) {
    console.log(chalk.yellow(`- ${veryStale.length} >180 days stale → consider deprecating candidates`));
  }
  if (candidates.length > 0) {
    console.log(chalk.blue(`- ${candidates.length} stale candidates → validate or remove`));
  }
  console.log(chalk.gray(`${formatTipPrefix()}Use '${cli} playbook get <id>' to inspect, then '${cli} mark <id> --helpful|--harmful'.`));
}
