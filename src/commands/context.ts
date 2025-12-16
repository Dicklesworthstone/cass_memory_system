import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig, getSanitizeConfig } from "../config.js";
import { sanitize } from "../sanitize.js";
import { loadMergedPlaybook, getActiveBullets } from "../playbook.js";
import { safeCassSearchWithDegraded } from "../cass.js";
import {
  extractKeywords,
  scoreBulletRelevance,
  checkDeprecatedPatterns,
  generateSuggestedQueries,
  warn,
  isJsonOutput,
  printJsonResult,
  truncate,
  formatLastHelpful,
  extractBulletReasoning,
  getCliName,
  ensureDir,
  expandPath,
  resolveRepoDir,
  fileExists,
  atomicWrite
} from "../utils.js";
import { withLock } from "../lock.js";
import { getEffectiveScore } from "../scoring.js";
import { ContextResult, ScoredBullet, Config, CassSearchHit, PlaybookBullet } from "../types.js";
import { cosineSimilarity, embedText, loadOrComputeEmbeddingsForBullets } from "../semantic.js";
import chalk from "chalk";
import { agentIconPrefix, formatRule, formatTipPrefix, getOutputStyle, iconPrefix, wrapText } from "../output.js";

// ============================================================================ 
// buildContextResult - Assemble final ContextResult output
// ============================================================================ 

/**
 * Build the final ContextResult from gathered components.
 */
export function buildContextResult(
  task: string,
  rules: ScoredBullet[],
  antiPatterns: ScoredBullet[],
  history: CassSearchHit[],
  warnings: string[],
  suggestedQueries: string[],
  config: Config
): ContextResult {
  // Apply size limits
  const maxBullets = config.maxBulletsInContext || 10;
  const maxHistory = config.maxHistoryInContext || 10;

  // Transform rules with additional metadata for LLM consumption
  const relevantBullets = rules.slice(0, maxBullets).map(b => ({
    ...b,
    lastHelpful: formatLastHelpful(b),
    reasoning: extractBulletReasoning(b)
  }));

  // Transform anti-patterns with additional metadata
  const transformedAntiPatterns = antiPatterns.slice(0, maxBullets).map(b => ({
    ...b,
    lastHelpful: formatLastHelpful(b),
    reasoning: extractBulletReasoning(b)
  }));

  // Transform history snippets - simplify structure, truncate long snippets
  const historySnippets = history.slice(0, maxHistory).map(h => ({
    ...h,
    snippet: truncate(h.snippet.trim().replace(/\n/g, " "), 300)
  }));

  return {
    task,
    relevantBullets,
    antiPatterns: transformedAntiPatterns,
    historySnippets,
    deprecatedWarnings: warnings,
    suggestedCassQueries: suggestedQueries
  };
}

export interface ContextFlags {
  json?: boolean;
  top?: number;
  history?: number;
  days?: number;
  workspace?: string;
  format?: "json" | "markdown";
  logContext?: boolean;
  session?: string;
}

export interface ContextComputation {
  result: ContextResult;
  rules: ScoredBullet[];
  antiPatterns: ScoredBullet[];
  cassHits: CassSearchHit[];
  warnings: string[];
  suggestedQueries: string[];
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export async function scoreBulletsEnhanced(
  bullets: PlaybookBullet[],
  task: string,
  keywords: string[],
  config: Config,
  options: { json?: boolean; queryEmbedding?: number[]; skipEmbeddingLoad?: boolean } = {}
): Promise<ScoredBullet[]> {
  if (bullets.length === 0) return [];

  const embeddingModel =
    typeof config.embeddingModel === "string" && config.embeddingModel.trim() !== ""
      ? config.embeddingModel.trim()
      : undefined;
  const semanticEnabled = config.semanticSearchEnabled && embeddingModel !== "none";

  const semanticWeight = clamp01(
    typeof config.semanticWeight === "number" ? config.semanticWeight : 0.6
  );

  let queryEmbedding: number[] | null = null;
  if (semanticEnabled) {
    try {
      queryEmbedding =
        Array.isArray(options.queryEmbedding) && options.queryEmbedding.length > 0
          ? options.queryEmbedding
          : await embedText(task, { model: embeddingModel });

      if (!options.skipEmbeddingLoad) {
        await loadOrComputeEmbeddingsForBullets(bullets, { model: embeddingModel });
      }
    } catch (err: any) {
      queryEmbedding = null;
      if (!options.json) {
        warn(
          `[context] Semantic search unavailable; using keyword-only scoring. ${err?.message || ""}`.trim()
        );
      }
    }
  }

  const scored: ScoredBullet[] = bullets.map((b) => {
    const keywordScore = scoreBulletRelevance(b.content, b.tags, keywords);

    const hasSemantic =
      semanticEnabled &&
      queryEmbedding &&
      queryEmbedding.length > 0 &&
      Array.isArray(b.embedding) &&
      b.embedding.length > 0;

    const semanticSimilarity = hasSemantic
      ? Math.max(0, cosineSimilarity(queryEmbedding!, b.embedding!))
      : 0;
    const semanticScore = semanticSimilarity * 10;

    const w = hasSemantic ? semanticWeight : 0;
    const relevanceScore = keywordScore * (1 - w) + semanticScore * w;
    const effectiveScore = getEffectiveScore(b, config);
    const finalScore = relevanceScore * Math.max(0.1, effectiveScore);

    return {
      ...b,
      relevanceScore,
      effectiveScore,
      finalScore,
    };
  });

  scored.sort((a, b) => (b.finalScore || 0) - (a.finalScore || 0));
  return scored;
}

/**
 * Programmatic context builder (no console output).
 */
export async function generateContextResult(
  task: string,
  flags: ContextFlags
): Promise<ContextComputation> {
  const config = await loadConfig();
  const playbook = await loadMergedPlaybook(config);

  const keywords = extractKeywords(task);

  const activeBullets = getActiveBullets(playbook).filter((b) => {
    if (!flags.workspace) return true;
    if (b.scope !== "workspace") return true;
    return b.workspace === flags.workspace;
  });

  const scoredBullets = await scoreBulletsEnhanced(activeBullets, task, keywords, config, {
    json: flags.json,
  });

  const topBullets = scoredBullets
    .filter(b => (b.finalScore || 0) > 0)
    .slice(0, flags.top || config.maxBulletsInContext);

  const rules = topBullets.filter(b => !b.isNegative && b.kind !== "anti_pattern");
  const antiPatterns = topBullets.filter(b => b.isNegative || b.kind === "anti_pattern");

  let cassHits: CassSearchHit[] = [];
  let degraded: ContextResult["degraded"] | undefined;

  const cassQuery = keywords.join(" ");
  const cassResult = await safeCassSearchWithDegraded(cassQuery, {
    limit: flags.history || config.maxHistoryInContext,
    days: flags.days || config.sessionLookbackDays,
    workspace: flags.workspace,
  }, config.cassPath, config);
  cassHits = cassResult.hits;
  if (cassResult.degraded || cassResult.remoteDegraded) {
    degraded = {
      cass: cassResult.degraded,
      remoteCass: cassResult.remoteDegraded
    };
  }

  const warnings: string[] = [];
  const historyWarnings = checkDeprecatedPatterns(cassHits, playbook.deprecatedPatterns);
  warnings.push(...historyWarnings);

  for (const pattern of playbook.deprecatedPatterns) {
    if (new RegExp(pattern.pattern, "i").test(task)) {
      const reason = pattern.reason ? ` (Reason: ${pattern.reason})` : "";
      const replacement = pattern.replacement ? ` - use ${pattern.replacement} instead` : "";
      warnings.push(`Task matches deprecated pattern "${pattern.pattern}"${replacement}${reason}`);
    }
  }

  // Keep suggestedCassQueries semantically pure: only search queries, no remediation
  // Remediation commands (cm doctor, cass health, etc.) are in degraded.cass.suggestedFix
  const suggestedQueries = generateSuggestedQueries(task, keywords, {
    maxSuggestions: 5
  });

  const result = buildContextResult(
    task,
    rules,
    antiPatterns,
    cassHits,
    warnings,
    suggestedQueries,
    config
  );
  if (degraded) {
    result.degraded = degraded;
  }

  const shouldLog =
    flags.logContext ||
    process.env.CASS_CONTEXT_LOG === "1" ||
    process.env.CASS_CONTEXT_LOG === "true";

  if (shouldLog) {
    await appendContextLog({
      task,
      ruleIds: rules.map((r) => r.id),
      antiPatternIds: antiPatterns.map((r) => r.id),
      workspace: flags.workspace,
      session: flags.session,
    });
  }

  return { result, rules, antiPatterns, cassHits, warnings, suggestedQueries };
}

async function appendContextLog(entry: {
  task: string;
  ruleIds: string[];
  antiPatternIds: string[];
  workspace?: string;
  session?: string;
}) {
  try {
    // Resolve log path: prefer repo-local .cass/ if available
    const repoDir = await resolveRepoDir();
    const useRepoLog = repoDir ? await fileExists(repoDir) : false;
    const repoLog = useRepoLog ? path.join(repoDir!, "context-log.jsonl") : null;

    const logPath = repoLog
      ? repoLog
      : expandPath("~/.cass-memory/context-log.jsonl");

    await ensureDir(path.dirname(logPath));

    // Sanitize content before logging
    const config = await loadConfig();
    const sanitizeConfig = getSanitizeConfig(config);
    const safeTask = sanitize(entry.task, sanitizeConfig);

    const payload = {
      ...entry,
      task: safeTask,
      timestamp: new Date().toISOString(),
      source: "context",
    };
    
    // Use withLock to prevent race conditions during concurrent appends
    await withLock(logPath, async () => {
      await fs.appendFile(logPath, JSON.stringify(payload) + "\n", "utf-8");
    });
  } catch {
    // Best-effort logging; never block context generation
  }
}

/**
 * Graceful degradation when cass is unavailable - provide playbook-only context.
 */
export async function contextWithoutCass(
  task: string,
  config: Config,
  options: { workspace?: string; maxBullets?: number; reason?: string } = {}
): Promise<ContextResult> {
  const { workspace, maxBullets, reason } = options;

  warn(`cass unavailable - showing playbook only${reason ? ` (${reason})` : ""}`);

  try {
    const playbook = await loadMergedPlaybook(config);
    const keywords = extractKeywords(task);

    const activeBullets = getActiveBullets(playbook).filter((b) => {
      if (!workspace) return true;
      if (b.scope !== "workspace") return true;
      return b.workspace === workspace;
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

    scoredBullets.sort((a, b) => (b.finalScore || 0) - (a.finalScore || 0));

    const topBullets = scoredBullets
      .filter(b => (b.finalScore || 0) > 0)
      .slice(0, maxBullets || config.maxBulletsInContext);

    const rules = topBullets.filter(b => !b.isNegative && b.kind !== "anti_pattern");
    const antiPatterns = topBullets.filter(b => b.isNegative || b.kind === "anti_pattern");

    const warnings: string[] = ["Context generated without historical data (cass unavailable)"];
    for (const pattern of playbook.deprecatedPatterns) {
      if (new RegExp(pattern.pattern, "i").test(task)) {
        const reasonSuffix = pattern.reason ? ` (Reason: ${pattern.reason})` : "";
        const replacement = pattern.replacement ? ` - use ${pattern.replacement} instead` : "";
        warnings.push(`Task matches deprecated pattern "${pattern.pattern}"${replacement}${reasonSuffix}`);
      }
    }

    return {
      task,
      relevantBullets: rules,
      antiPatterns,
      historySnippets: [],
      deprecatedWarnings: warnings,
      suggestedCassQueries: []
    };
  } catch (err) {
    warn(`Playbook also unavailable: ${err}`);
    return {
      task,
      relevantBullets: [],
      antiPatterns: [],
      historySnippets: [],
      deprecatedWarnings: ["Context unavailable - both cass and playbook failed to load"],
      suggestedCassQueries: []
    };
  }
}

// Legacy export wrapper
export async function getContext(
  task: string, 
  flags: ContextFlags = {}
) {
  const { result, rules, antiPatterns, cassHits, warnings, suggestedQueries } = await generateContextResult(task, flags);
  return { result, rules, antiPatterns, cassHits, warnings, suggestedQueries };
}

export async function contextCommand(
  task: string, 
  flags: ContextFlags
) {
  const { result, rules, antiPatterns, cassHits, warnings, suggestedQueries } = await generateContextResult(task, flags);

  const wantsJson = isJsonOutput(flags);

  if (wantsJson) {
    printJsonResult(result);
    return;
  }

  const cli = getCliName();
  const maxWidth = Math.min(getOutputStyle().width, 84);
  const divider = chalk.dim(formatRule("─", { maxWidth }));

  // Human Output (premium, width-aware)
  console.log(chalk.bold(`CONTEXT FOR: ${task}`));
  console.log(divider);

  if (result.degraded?.cass && !result.degraded.cass.available) {
    const cass = result.degraded.cass;
    const suggested = Array.isArray(cass.suggestedFix) ? cass.suggestedFix.filter(Boolean) : [];
    const primaryHint = suggested[0] || `${cli} doctor`;
    const remoteOnlyNote = cassHits.length > 0 ? " (showing remote history only)" : "";
    console.log(chalk.yellow(`${iconPrefix("warning")}Local history unavailable (cass: ${cass.reason})${remoteOnlyNote}.`));
    console.log(chalk.yellow(`  Next: ${primaryHint}`));
    console.log("");
  }

  // Playbook rules
  if (rules.length > 0) {
    console.log(chalk.bold(`PLAYBOOK RULES (${rules.length})`));
    console.log(divider);
    const contentWidth = Math.max(24, maxWidth - 2);

    for (const b of rules) {
      const score = Number.isFinite(b.effectiveScore) ? b.effectiveScore.toFixed(1) : "n/a";
      const maturity = b.maturity ? ` • ${b.maturity}` : "";
      console.log(chalk.bold(`[${b.id}]`) + chalk.dim(` ${b.category}/${b.kind} • score ${score}${maturity}`));
      for (const line of wrapText(b.content, contentWidth)) {
        console.log(`  ${line}`);
      }
      console.log("");
    }
  } else {
    console.log(chalk.bold("PLAYBOOK RULES (0)"));
    console.log(divider);
    console.log(chalk.gray("(No relevant playbook rules found)"));
    console.log(chalk.gray(`  ${formatTipPrefix()}Run '${cli} reflect' to start learning from your agent sessions.`));
    console.log("");
  }

  // Pitfalls
  if (antiPatterns.length > 0) {
    console.log(chalk.yellow.bold(`${iconPrefix("warning")}PITFALLS TO AVOID (${antiPatterns.length})`));
    console.log(divider);
    const contentWidth = Math.max(24, maxWidth - 4);
    for (const b of antiPatterns) {
      console.log(chalk.yellow(`- [${b.id}]`));
      for (const line of wrapText(b.content, contentWidth)) {
        console.log(chalk.yellow(`  ${line}`));
      }
    }
    console.log("");
  }

  // History (explicit truncation)
  if (cassHits.length > 0) {
    const total = cassHits.length;
    const shown = Math.min(total, 3);
    const showing = total > shown ? ` (showing ${shown} of ${total})` : "";
    console.log(chalk.bold(`HISTORY${showing}`));
    console.log(divider);

    const snippetWidth = Math.max(24, maxWidth - 4);
    cassHits.slice(0, shown).forEach((h, i) => {
      const agent = h.agent || "unknown";
      const agentLabel = `${agentIconPrefix(agent)}${agent}`;
      const isRemote = h.origin?.kind === "remote";
      const hostLabel = isRemote && h.origin?.host ? ` [${h.origin.host}]` : "";

      // Remote hits get dimmer styling
      const headerStyle = isRemote ? chalk.dim : chalk.bold;
      const snippetStyle = isRemote ? chalk.dim : chalk.gray;
      const pathStyle = isRemote ? chalk.dim : chalk.dim;

      console.log(headerStyle(`${i + 1}. ${agentLabel}${hostLabel}`) + pathStyle(` • ${h.source_path}`));
      const snippet = h.snippet.trim().replace(/\s+/g, " ");
      for (const line of wrapText(`"${snippet}"`, snippetWidth)) {
        console.log(snippetStyle(`  ${line}`));
      }
      console.log("");
    });
  } else if (!result.degraded?.cass || result.degraded.cass.available) {
    console.log(chalk.bold("HISTORY (0)"));
    console.log(divider);
    console.log(chalk.gray("(No relevant history found)"));
    console.log(chalk.gray(`  ${formatTipPrefix()}Use Claude Code, Cursor, Codex, or PI to build session history.`));
    console.log("");
  }

  // Warnings
  if (warnings.length > 0) {
    console.log(chalk.yellow.bold(`${iconPrefix("warning")}WARNINGS (${warnings.length})`));
    console.log(divider);
    warnings.forEach((w) => console.log(chalk.yellow(`- ${w}`)));
    console.log("");
  }

  // Suggested searches
  if (suggestedQueries.length > 0) {
    console.log(chalk.bold("SUGGESTED SEARCHES"));
    console.log(divider);
    suggestedQueries.forEach((q) => console.log(`- ${q}`));
  }
}
