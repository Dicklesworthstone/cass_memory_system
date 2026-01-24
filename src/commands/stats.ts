import { loadConfig } from "../config.js";
import { loadMergedPlaybook, getActiveBullets } from "../playbook.js";
import {
  analyzeScoreDistribution,
  getEffectiveScore,
  isStale
} from "../scoring.js";
import { findSemanticDuplicates } from "../semantic.js";
import { isJsonOutput, isToonOutput, tokenize, printStructuredResult, reportError, validateOneOf } from "../utils.js";
import chalk from "chalk";
import { iconPrefix } from "../output.js";
import { ErrorCode } from "../types.js";

export async function statsCommand(options: { json?: boolean; format?: "json" | "toon"; stats?: boolean }): Promise<void> {
  const startedAtMs = Date.now();
  const formatCheck = validateOneOf(options.format, "format", ["json", "toon"] as const, {
    allowUndefined: true,
    caseInsensitive: true,
  });
  if (!formatCheck.ok) {
    reportError(formatCheck.message, {
      code: ErrorCode.INVALID_INPUT,
      details: formatCheck.details,
      hint: "Valid formats: json, toon",
      json: options.json,
      format: options.format,
      command: "stats",
      startedAtMs,
    });
    return;
  }
  const normalizedOptions = {
    ...options,
    ...(formatCheck.value !== undefined ? { format: formatCheck.value } : {}),
  };
  const config = await loadConfig();
  const playbook = await loadMergedPlaybook(config);
  const bullets = playbook.bullets;
  const activeBullets = getActiveBullets(playbook);

  const distribution = analyzeScoreDistribution(activeBullets, config);
  const total = bullets.length;

  const byScope = countBy(bullets, (b) => b.scope ?? "unknown");
  const byState = countBy(bullets, (b) => b.state ?? "unknown");
  const byKind = countBy(bullets, (b) => b.kind ?? "unknown");

  // Health metrics should reflect active bullets (aligned with scoreDistribution and merge candidates).
  const scores = activeBullets.map((b) => ({
    bullet: b,
    score: getEffectiveScore(b, config)
  }));

  const topPerformers = scores
    .filter((s) => Number.isFinite(s.score))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, 5)
    .map(({ bullet, score }) => ({
      id: bullet.id,
      content: bullet.content,
      score,
      helpfulCount: bullet.helpfulCount || 0
    }));

  const mostHelpful = [...activeBullets]
    .sort((a, b) => (b.helpfulCount || 0) - (a.helpfulCount || 0))
    .slice(0, 5)
    .map((b) => ({ id: b.id, content: b.content, helpfulCount: b.helpfulCount || 0 }));

  const atRisk = scores.filter((s) => s.score < 0).map((s) => s.bullet);
  
  // Use config-aware staleness check
  const staleThresholdDays = config.scoring?.decayHalfLifeDays || 90;
  const stale = activeBullets.filter((b) => isStale(b, staleThresholdDays));

  // Only check active bullets for merge candidates to improve performance and relevance
  // Prioritize recent bullets (reverse order) for merge checks
  const mergeCandidates = findMergeCandidates([...activeBullets].reverse(), 0.8, 10);

  let semanticMergeCandidates: Array<{ a: string; b: string; similarity: number }> = [];
  if (config.semanticSearchEnabled && config.embeddingModel !== "none") {
    try {
      const dupes = await findSemanticDuplicates(activeBullets, 0.85, {
        model: config.embeddingModel,
      });
      semanticMergeCandidates = dupes.slice(0, 5).map((d) => ({
        a: d.pair[0],
        b: d.pair[1],
        similarity: Number(d.similarity.toFixed(2)),
      }));
    } catch {
      semanticMergeCandidates = [];
    }
  }

  const stats = {
    total,
    byScope,
    byState,
    byKind,
    scoreDistribution: distribution,
    topPerformers,
    mostHelpful,
    atRiskCount: atRisk.length,
    staleCount: stale.length,
    mergeCandidates,
    semanticMergeCandidates
  };

  const wantsJson = isJsonOutput(normalizedOptions);
  const wantsToon = isToonOutput(normalizedOptions);
  if (wantsJson || wantsToon) {
    printStructuredResult("stats", stats, normalizedOptions, { startedAtMs });
    return;
  }

  printHumanStats(stats, staleThresholdDays);
}

function countBy<T>(items: T[], keyFn: (item: T) => string): Record<string, number> {
  return items.reduce<Record<string, number>>((acc, item) => {
    const key = keyFn(item);
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function findMergeCandidates(
  bullets: any[],
  threshold: number,
  limit: number
): Array<{ a: string; b: string; similarity: number }> {
  // Pre-tokenize to avoid O(N^2) tokenization overhead
  const tokenized = bullets.map(b => ({
    id: b.id,
    tokens: new Set(tokenize(b.content))
  }));

  const pairs: Array<{ a: string; b: string; similarity: number }> = [];
  
  // Cap comparisons to prevent hanging on huge playbooks
  // Comparing top 2000 bullets = 2M checks, manageable with pre-tokenization
  const maxScan = Math.min(tokenized.length, 2000); 

  for (let i = 0; i < maxScan; i++) {
    for (let j = i + 1; j < maxScan; j++) {
      const tA = tokenized[i].tokens;
      const tB = tokenized[j].tokens;
      
      if (tA.size === 0 || tB.size === 0) continue;
      
      let intersection = 0;
      for (const t of tA) {
        if (tB.has(t)) intersection++;
      }
      
      const union = tA.size + tB.size - intersection;
      const sim = intersection / union;

      if (sim >= threshold) {
        pairs.push({
          a: tokenized[i].id,
          b: tokenized[j].id,
          similarity: Number(sim.toFixed(2))
        });
      }
      if (pairs.length >= limit) break;
    }
    if (pairs.length >= limit) break;
  }
  return pairs;
}

function printHumanStats(stats: {
  total: number;
  byScope: Record<string, number>;
  byState: Record<string, number>;
  byKind: Record<string, number>;
  scoreDistribution: ReturnType<typeof analyzeScoreDistribution>;
  topPerformers: Array<{ id: string; content: string; score: number; helpfulCount?: number }>;
  mostHelpful: Array<{ id: string; content: string; helpfulCount: number }>;
  atRiskCount: number;
  staleCount: number;
  mergeCandidates: Array<{ a: string; b: string; similarity: number }>;
  semanticMergeCandidates: Array<{ a: string; b: string; similarity: number }>;
}, staleThresholdDays: number) {
  console.log(chalk.bold(`\n${iconPrefix("chart")}Playbook Health Dashboard`));
  console.log(`Total Bullets: ${stats.total}`);

  console.log(chalk.bold("\nBy Scope:"));
  for (const [scope, count] of Object.entries(stats.byScope)) {
    console.log(`  ${scope}: ${count}`);
  }

  console.log(chalk.bold("\nBy State:"));
  for (const [state, count] of Object.entries(stats.byState)) {
    console.log(`  ${state}: ${count}`);
  }

  console.log(chalk.bold("\nBy Kind:"));
  for (const [kind, count] of Object.entries(stats.byKind)) {
    console.log(`  ${kind}: ${count}`);
  }

  console.log(chalk.bold("\nScore Distribution:"));
  console.log(`  ${iconPrefix("star")}Excellent (>=10): ${stats.scoreDistribution.excellent}`);
  console.log(`  ${iconPrefix("check")}Good (5-<10):     ${stats.scoreDistribution.good}`);
  console.log(`  ${iconPrefix("neutral")}Neutral (0-5):  ${stats.scoreDistribution.neutral}`);
  console.log(`  ${iconPrefix("warning")}At Risk (<0):   ${stats.scoreDistribution.atRisk}`);

  if (stats.topPerformers.length > 0) {
    console.log(chalk.bold(`\n${iconPrefix("trophy")}Top Performers (effective score):`));
    stats.topPerformers.forEach((b, i) => {
      console.log(`  ${i + 1}. [${b.id}] ${b.content.slice(0, 60)}... (${b.score.toFixed(1)})`);
    });
  }

  if (stats.mostHelpful.length > 0) {
    console.log(chalk.bold(`\n${iconPrefix("thumbsUp")}Most Helpful (feedback count):`));
    stats.mostHelpful.forEach((b, i) => {
      console.log(`  ${i + 1}. [${b.id}] ${b.content.slice(0, 60)}... (${b.helpfulCount})`);
    });
  }

  console.log(chalk.bold(`\n${iconPrefix("warning")}At Risk: ${stats.atRiskCount}`));
  console.log(chalk.bold(`${iconPrefix("clock")}Stale (${staleThresholdDays}d+): ${stats.staleCount}`));

  if (stats.mergeCandidates.length > 0) {
    console.log(chalk.bold(`\n${iconPrefix("merge")}Merge Candidates (similarity ≥ 0.8):`));
    stats.mergeCandidates.forEach((p) => {
      console.log(`  - ${p.a} ↔ ${p.b} (sim ${p.similarity})`);
    });
  }

  if (stats.semanticMergeCandidates.length > 0) {
    console.log(chalk.bold(`\n${iconPrefix("brain")}Semantic Merge Candidates (similarity ≥ 0.85):`));
    stats.semanticMergeCandidates.forEach((p) => {
      console.log(`  - ${p.a} ↔ ${p.b} (sim ${p.similarity})`);
    });
  }
}
