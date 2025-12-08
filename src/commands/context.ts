import { loadConfig } from "../config.js";
import { loadMergedPlaybook, getActiveBullets } from "../playbook.js";
import { safeCassSearch } from "../cass.js";
import { extractKeywords, scoreBulletRelevance } from "../utils.js";
import { getEffectiveScore } from "../scoring.js";
import { ContextResult, ScoredBullet } from "../types.js";
import chalk from "chalk";

export async function contextCommand(
  task: string, 
  flags: { json?: boolean; top?: number; history?: number; days?: number; workspace?: string }
) {
  const config = await loadConfig();
  // Fix: Use loadMergedPlaybook(config) instead of loadPlaybook(config)
  // Or if we want specific path, loadPlaybook(config.playbookPath).
  // Context should use merged playbook (global + repo).
  const playbook = await loadMergedPlaybook(config);
  
  // 1. Keywords & Scoring
  const keywords = extractKeywords(task);
  
  const activeBullets = getActiveBullets(playbook).filter((b) => {
    if (!flags.workspace) return true;
    // keep globals and non-workspace-scoped bullets; filter workspace-scoped to match
    if (b.scope !== "workspace") return true;
    return b.workspace === flags.workspace;
  });
  
  const scoredBullets: ScoredBullet[] = activeBullets.map(b => {
    const relevance = scoreBulletRelevance(b.content, b.tags, keywords);
    const effective = getEffectiveScore(b, config);
    const final = relevance * Math.max(0.1, effective);
    
    return {
      ...b,
      relevanceScore: relevance,
      effectiveScore: effective,
      finalScore: final
    };
  });

  // Sort
  scoredBullets.sort((a, b) => (b.finalScore || 0) - (a.finalScore || 0));
  
  // Filter top N
  const topBullets = scoredBullets
    .filter(b => (b.finalScore || 0) > 0)
    .slice(0, flags.top || config.maxBulletsInContext);

  // Separate Anti-Patterns
  const rules = topBullets.filter(b => !b.isNegative && b.kind !== "anti_pattern");
  const antiPatterns = topBullets.filter(b => b.isNegative || b.kind === "anti_pattern");

  // 2. History Search
  const cassQuery = keywords.join(" ");
  const cassHits = await safeCassSearch(cassQuery, {
    limit: flags.history || config.maxHistoryInContext,
    days: flags.days || config.sessionLookbackDays,
    workspace: flags.workspace
  }, config.cassPath);

  // 3. Warnings
  const warnings: string[] = [];
  for (const pattern of playbook.deprecatedPatterns) {
    if (new RegExp(pattern.pattern, "i").test(task)) {
      warnings.push(`Deprecated pattern detected: "${pattern.pattern}". Reason: ${pattern.reason}. ${pattern.replacement ? `Use ${pattern.replacement} instead.` : ""}`);
    }
  }

  // 4. Suggested Queries
  const suggestedQueries = [
    `cass search "${keywords.slice(0, 2).join(" ")}" --days 30`,
    `cass search "${keywords[0] || "task"} error" --days 30`
  ];

  // 5. Format Output
  const result: ContextResult = {
    task,
    relevantBullets: rules,
    antiPatterns,
    historySnippets: cassHits,
    deprecatedWarnings: warnings,
    suggestedCassQueries: suggestedQueries
  };

  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    // Human Output
    console.log(chalk.bold(`═══════════════════════════════════════════════════════════════`));
    console.log(chalk.bold(`CONTEXT FOR: ${task}`));
    console.log(chalk.bold(`═══════════════════════════════════════════════════════════════
`));

    if (rules.length > 0) {
      console.log(chalk.blue.bold(`RELEVANT PLAYBOOK RULES (${rules.length}):
`));
      rules.forEach(b => {
        console.log(chalk.bold(`[${b.id}] ${b.category}/${b.kind} (score: ${b.effectiveScore.toFixed(1)})`));
        console.log(`  ${b.content}`);
        console.log("");
      });
    } else {
      console.log(chalk.gray("(No relevant playbook rules found)\n"));
    }

    if (antiPatterns.length > 0) {
      console.log(chalk.red.bold(`PITFALLS TO AVOID (${antiPatterns.length}):
`));
      antiPatterns.forEach(b => {
        console.log(chalk.red(`[${b.id}] ${b.content}`));
      });
      console.log("");
    }

    if (cassHits.length > 0) {
      console.log(chalk.blue.bold(`HISTORICAL CONTEXT (${cassHits.length} sessions):
`));
      cassHits.slice(0, 3).forEach((h, i) => {
        console.log(`${i + 1}. ${h.source_path} (${h.agent || "unknown"})`);
        console.log(chalk.gray(`   "${h.snippet.trim().replace(/\n/g, " ")}"`));
        console.log("");
      });
    } else {
      console.log(chalk.gray("(No relevant history found)\n"));
    }

    if (warnings.length > 0) {
      console.log(chalk.yellow.bold(`⚠️  WARNINGS:
`));
      warnings.forEach(w => console.log(chalk.yellow(`  • ${w}`)));
      console.log("");
    }

    console.log(chalk.blue.bold(`SUGGESTED SEARCHES:`));
    suggestedQueries.forEach(q => console.log(`  ${q}`));
  }
}
