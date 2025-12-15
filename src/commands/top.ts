/**
 * top command - Show most effective playbook bullets
 *
 * Quick command to see which rules are most effective based on
 * current scores with decay applied.
 */
import { loadConfig } from "../config.js";
import { loadMergedPlaybook, getActiveBullets } from "../playbook.js";
import { getEffectiveScore } from "../scoring.js";
import { truncate, formatLastHelpful, printJsonResult } from "../utils.js";
import { PlaybookBullet, Config } from "../types.js";
import chalk from "chalk";
import { formatMaturityIcon, formatRule } from "../output.js";

export interface TopFlags {
  scope?: "global" | "workspace" | "all";
  category?: string;
  json?: boolean;
}

interface RankedBullet {
  rank: number;
  id: string;
  score: number;
  content: string;
  category: string;
  scope: string;
  maturity: string;
  feedback: { helpful: number; harmful: number };
  lastUsed: string;
}

export async function topCommand(
  count: number = 10,
  flags: TopFlags = {}
): Promise<void> {
  const config = await loadConfig();
  const playbook = await loadMergedPlaybook(config);

  let bullets = getActiveBullets(playbook);

  // Apply filters
  if (flags.scope && flags.scope !== "all") {
    bullets = bullets.filter(b => b.scope === flags.scope);
  }
  if (flags.category) {
    const cat = flags.category.toLowerCase();
    bullets = bullets.filter(b => b.category?.toLowerCase() === cat);
  }

  // Calculate scores and rank
  const scored = bullets.map(b => ({
    bullet: b,
    score: getEffectiveScore(b, config)
  }));

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Take top N
  const topN = scored.slice(0, count);

  // Format output
  const ranked: RankedBullet[] = topN.map((s, i) => ({
    rank: i + 1,
    id: s.bullet.id,
    score: Number(s.score.toFixed(2)),
    content: s.bullet.content,
    category: s.bullet.category || "uncategorized",
    scope: s.bullet.scope || "global",
    maturity: s.bullet.maturity || "candidate",
    feedback: {
      helpful: s.bullet.helpfulCount || 0,
      harmful: s.bullet.harmfulCount || 0
    },
    lastUsed: formatLastHelpful(s.bullet)
  }));

  if (flags.json) {
    printJsonResult({
      timestamp: new Date().toISOString(),
      count: ranked.length,
      filters: {
        scope: flags.scope || "all",
        category: flags.category || null
      },
      bullets: ranked
    });
    return;
  }

  // Human-readable output
  printTopBullets(ranked, flags);
}

function printTopBullets(bullets: RankedBullet[], flags: TopFlags): void {
  if (bullets.length === 0) {
    console.log(chalk.yellow("No bullets found matching the criteria."));
    if (flags.scope || flags.category) {
      console.log(chalk.gray(`Filters: scope=${flags.scope || "all"}, category=${flags.category || "any"}`));
    }
    return;
  }

  const filterDesc = [];
  if (flags.scope && flags.scope !== "all") filterDesc.push(`scope: ${flags.scope}`);
  if (flags.category) filterDesc.push(`category: ${flags.category}`);
  const filterStr = filterDesc.length > 0 ? ` (${filterDesc.join(", ")})` : "";

  console.log(chalk.bold(`\nTOP ${bullets.length} MOST EFFECTIVE BULLETS${filterStr}`));
  console.log(chalk.gray(formatRule("═", { maxWidth: 60 })));
  console.log();

  for (const b of bullets) {
    const maturityIcon = formatMaturityIcon(b.maturity);
    const maturityPrefix = maturityIcon ? `${maturityIcon} ` : "";
    const scoreColor = b.score >= 10 ? chalk.green : b.score >= 5 ? chalk.blue : b.score >= 0 ? chalk.white : chalk.red;

    console.log(`${chalk.bold(`${b.rank}.`)} ${scoreColor(`[Score: ${b.score.toFixed(1)}]`)} ${truncate(b.content, 50)}`);
    console.log(chalk.gray(`   ${maturityPrefix}${b.maturity} | ${b.category} | ${b.scope}`));
    console.log(chalk.gray(`   Feedback: ${b.feedback.helpful}× helpful, ${b.feedback.harmful}× harmful`));
    console.log(chalk.gray(`   Last used: ${b.lastUsed}`));
    console.log();
  }
}
