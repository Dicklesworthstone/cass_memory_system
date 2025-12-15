/**
 * stale command - Find bullets without recent feedback
 *
 * Identifies rules that haven't received helpful/harmful feedback in N days.
 * Useful for cleanup sessions and finding outdated practices.
 */
import { loadConfig } from "../config.js";
import { loadMergedPlaybook, getActiveBullets } from "../playbook.js";
import { getEffectiveScore } from "../scoring.js";
import { truncate, getCliName, printJsonResult } from "../utils.js";
import { PlaybookBullet, Config } from "../types.js";
import chalk from "chalk";

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
  daysSinceLastFeedback: number,
  score: number,
  maturity: string,
  cli: string
): string {
  if (score < -2) {
    return `Consider using '${cli} forget' - negative score suggests this rule is harmful`;
  }
  if (daysSinceLastFeedback > 180 && maturity === "candidate") {
    return "Very stale candidate - consider deprecating if no longer relevant";
  }
  if (daysSinceLastFeedback > 120 && score < 1) {
    return "Stale with low score - review for relevance or deprecate";
  }
  if (score > 5) {
    return "Good score despite being stale - may still be valid, review periodically";
  }
  return "Review for current relevance and update if needed";
}

export async function staleCommand(
  flags: StaleFlags = {}
): Promise<void> {
  const threshold = flags.days ?? 90;
  const cli = getCliName();
  const config = await loadConfig();
  const playbook = await loadMergedPlaybook(config);

  let bullets = getActiveBullets(playbook);

  // Apply scope filter
  if (flags.scope && flags.scope !== "all") {
    bullets = bullets.filter(b => b.scope === flags.scope);
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
        recommendation: getRecommendation(staleness.days, score, bullet.maturity || "candidate", cli)
      });
    }
  }

  // Sort by days descending (most stale first)
  staleBullets.sort((a, b) => b.daysSinceLastFeedback - a.daysSinceLastFeedback);

  if (flags.json) {
    printJsonResult({
      timestamp: new Date().toISOString(),
      threshold,
      count: staleBullets.length,
      totalActive: bullets.length,
      filters: {
        scope: flags.scope || "all"
      },
      bullets: staleBullets
    });
    return;
  }

  // Human-readable output
  printStaleBullets(staleBullets, threshold, bullets.length, flags, cli);
}

function printStaleBullets(
  bullets: StaleBullet[],
  threshold: number,
  totalActive: number,
  flags: StaleFlags,
  cli: string
): void {
  if (bullets.length === 0) {
    console.log(chalk.green(`\nNo stale bullets found (threshold: ${threshold} days)`));
    console.log(chalk.gray(`All ${totalActive} active bullets have received recent feedback.`));
    return;
  }

  const filterDesc = [];
  if (flags.scope && flags.scope !== "all") filterDesc.push(`scope: ${flags.scope}`);
  const filterStr = filterDesc.length > 0 ? ` (${filterDesc.join(", ")})` : "";

  console.log(chalk.bold(`\nSTALE BULLETS (no feedback in ${threshold}+ days)${filterStr}`));
  console.log(chalk.gray("═".repeat(60)));
  console.log(chalk.gray(`Found ${bullets.length} stale out of ${totalActive} active bullets\n`));

  for (const b of bullets) {
    const scoreColor = b.score >= 5 ? chalk.green : b.score >= 0 ? chalk.white : chalk.red;
    const daysStr = chalk.yellow(`[${b.daysSinceLastFeedback} days]`);

    console.log(`${daysStr} ${chalk.bold(b.id)}: ${truncate(b.content, 45)}`);
    console.log(chalk.gray(`   ${b.category} | ${b.scope} | ${b.maturity} | Score: ${scoreColor(b.score.toFixed(1))}`));

    if (b.lastFeedback.timestamp) {
      const action = b.lastFeedback.action === "helpful" ? chalk.green("helpful") : chalk.red("harmful");
      console.log(chalk.gray(`   Last feedback: ${b.lastFeedback.timestamp.slice(0, 10)} (marked ${action})`));
    } else {
      console.log(chalk.gray(`   No feedback since creation`));
    }

    console.log(chalk.cyan(`   → ${b.recommendation}`));
    console.log();
  }

  // Summary recommendations
  console.log(chalk.bold("RECOMMENDATIONS:"));
  console.log(chalk.gray("─".repeat(40)));

  const veryStale = bullets.filter(b => b.daysSinceLastFeedback > 180);
  const negative = bullets.filter(b => b.score < 0);
  const candidates = bullets.filter(b => b.maturity === "candidate" && b.daysSinceLastFeedback > 90);

  if (negative.length > 0) {
    console.log(chalk.red(`  • ${negative.length} bullets with negative scores - consider '${cli} forget'`));
  }
  if (veryStale.length > 0) {
    console.log(chalk.yellow(`  • ${veryStale.length} bullets >180 days stale - review for deprecation`));
  }
  if (candidates.length > 0) {
    console.log(chalk.blue(`  • ${candidates.length} stale candidates - validate or remove`));
  }
  if (bullets.length > 10) {
    console.log(chalk.gray(`  • Consider a cleanup session to review these ${bullets.length} bullets`));
  }
}
