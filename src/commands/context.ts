import { loadConfig } from "../config.js";
import { loadMergedPlaybook, getActiveBullets } from "../playbook.js";
import { safeCassSearch } from "../cass.js";
import { extractKeywords, scoreBulletRelevance, checkDeprecatedPatterns, generateSuggestedQueries, warn, formatRelativeTime, truncate } from "../utils.js";
import { getEffectiveScore } from "../scoring.js";
import { ContextResult, ScoredBullet, Config, CassSearchHit } from "../types.js";
import chalk from "chalk";

// ============================================================================
// buildContextResult - Assemble final ContextResult output
// ============================================================================

/**
 * Format the "last helpful" timestamp for a bullet.
 * Returns 'Never' if no helpful events, otherwise relative time like '2 days ago'.
 */
function formatLastHelpful(bullet: ScoredBullet): string {
  if (bullet.feedbackEvents && bullet.feedbackEvents.length > 0) {
    // Find the most recent helpful event
    const helpfulEvents = bullet.feedbackEvents.filter(e => e.type === "helpful");
    if (helpfulEvents.length > 0) {
      // Sort by timestamp descending and get most recent
      const sorted = [...helpfulEvents].sort((a, b) =>
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      );
      return formatRelativeTime(sorted[0].timestamp);
    }
  }
  return "Never";
}

/**
 * Extract reasoning/provenance for why a rule exists.
 * Combines reasoning field with source session info.
 */
function extractBulletReasoning(bullet: ScoredBullet): string {
  if (bullet.reasoning) {
    return bullet.reasoning;
  }

  // Build reasoning from provenance if no explicit reasoning
  const parts: string[] = [];

  if (bullet.sourceAgents && bullet.sourceAgents.length > 0) {
    parts.push(`Learned from ${bullet.sourceAgents.join(", ")}`);
  }

  if (bullet.sourceSessions && bullet.sourceSessions.length > 0) {
    const sessionCount = bullet.sourceSessions.length;
    parts.push(`based on ${sessionCount} session${sessionCount > 1 ? "s" : ""}`);
  }

  if (bullet.createdAt) {
    parts.push(`created ${formatRelativeTime(bullet.createdAt)}`);
  }

  return parts.length > 0 ? parts.join(", ") : "No provenance available";
}

/**
 * Build the final ContextResult from gathered components.
 *
 * This function assembles all context components into a structured output
 * optimized for LLM consumption, with proper formatting and transformations.
 *
 * TRANSFORMATIONS:
 * - rules/antiPatterns → Extract only needed fields (strip internal metadata)
 * - lastHelpful → formatLastHelpful(bullet) for human readability
 * - reasoning → extractBulletReasoning(bullet) for context
 * - history → Map to simpler structure (truncate long snippets)
 * - Respect size limits from config
 *
 * @param task - Original task description
 * @param rules - Top-scored relevant rules (already filtered/sorted)
 * @param antiPatterns - Pitfalls to avoid (already filtered/sorted)
 * @param history - Relevant past sessions from cass search
 * @param warnings - Deprecated pattern warnings
 * @param suggestedQueries - Follow-up cass search suggestions
 * @param config - Configuration for size limits
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

// ============================================================================
// Helper exports for testing and external use
// ============================================================================

export { formatLastHelpful, extractBulletReasoning };

/**
 * Graceful degradation when cass is unavailable - provide playbook-only context.
 *
 * When cass binary is not found or cass searches fail, this function provides
 * useful context from the playbook alone. The system remains functional even
 * without historical data.
 *
 * @param task - The task description to get context for
 * @param config - The loaded configuration
 * @param options - Optional configuration
 * @param options.workspace - Workspace to filter by
 * @param options.maxBullets - Maximum bullets to return
 * @param options.reason - Why cass is unavailable (for logging)
 * @returns ContextResult with playbook data only (no history)
 */
export async function contextWithoutCass(
  task: string,
  config: Config,
  options: { workspace?: string; maxBullets?: number; reason?: string } = {}
): Promise<ContextResult> {
  const { workspace, maxBullets, reason } = options;

  // Log warning about degraded mode
  warn(`cass unavailable - showing playbook only${reason ? ` (${reason})` : ""}`);

  try {
    // Load playbook
    const playbook = await loadMergedPlaybook(config);

    // Extract keywords using simple heuristics (no LLM)
    const keywords = extractKeywords(task);

    // Filter active bullets by workspace
    const activeBullets = getActiveBullets(playbook).filter((b) => {
      if (!workspace) return true;
      if (b.scope !== "workspace") return true;
      return b.workspace === workspace;
    });

    // Score bullets by keyword relevance
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

    // Sort by final score
    scoredBullets.sort((a, b) => (b.finalScore || 0) - (a.finalScore || 0));

    // Filter top N bullets with positive scores
    const topBullets = scoredBullets
      .filter(b => (b.finalScore || 0) > 0)
      .slice(0, maxBullets || config.maxBulletsInContext);

    // Separate rules from anti-patterns
    const rules = topBullets.filter(b => !b.isNegative && b.kind !== "anti_pattern");
    const antiPatterns = topBullets.filter(b => b.isNegative || b.kind === "anti_pattern");

    // Check for deprecated patterns in task text (can still do this without cass)
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
      historySnippets: [], // Empty - cass unavailable
      deprecatedWarnings: warnings,
      suggestedCassQueries: [] // Empty - no point suggesting if cass unavailable
    };
  } catch (err) {
    // If playbook also unavailable, return minimal result
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

  // 3. Warnings (deprecated patterns seen in history or task text)
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

  // 4. Suggested Queries
  const suggestedQueries = generateSuggestedQueries(task, keywords, {
    maxSuggestions: 5
  });

  // 5. Build Context Result using dedicated function
  // This adds transformations like lastHelpful formatting and reasoning extraction
  const result = buildContextResult(
    task,
    rules,
    antiPatterns,
    cassHits,
    warnings,
    suggestedQueries,
    config
  );

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
      // Zero-config friendly message: guide users to start learning
      console.log(chalk.gray("(No relevant playbook rules found)"));
      console.log(chalk.gray(`  💡 Run 'cm reflect' to start learning from your agent sessions.\n`));
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
