import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig, getSanitizeConfig } from "../config.js";
import { sanitize } from "../sanitize.js";
import { loadMergedPlaybook, getActiveBullets } from "../playbook.js";
import { safeCassSearchWithDegraded } from "../cass.js";
import { loadTraumas, findMatchingTrauma } from "../trauma.js";
import {
  extractKeywords,
  scoreBulletRelevance,
  checkDeprecatedPatterns,
  generateSuggestedQueries,
  warn,
  isJsonOutput,
  isToonOutput,
  reportError,
  printStructuredResult,
  truncateWithIndicator,
  formatLastHelpful,
  extractBulletReasoning,
  getCliName,
  validateNonEmptyString,
  validateOneOf,
  validatePositiveInt,
  ensureDir,
  expandPath,
  resolveRepoDir,
  fileExists,
  atomicWrite
} from "../utils.js";
import { withLock } from "../lock.js";
import { getEffectiveScore } from "../scoring.js";
import { ContextResult, ScoredBullet, Config, CassSearchHit, PlaybookBullet, ErrorCode } from "../types.js";
import { cosineSimilarity, embedText, loadOrComputeEmbeddingsForBullets } from "../semantic.js";
import chalk from "chalk";
import { agentIconPrefix, formatRule, formatTipPrefix, getOutputStyle, iconPrefix, wrapText } from "../output.js";
import { createProgress, type ProgressReporter } from "../progress.js";

/**
 * ReDoS-safe matcher for deprecated patterns.
 * Supports both literal substring patterns and regex-like patterns.
 */
function safeDeprecatedPatternMatcher(pattern: string): (text: string) => boolean {
  if (!pattern) return () => false;

  const wrappedRegex = pattern.startsWith("/") && pattern.endsWith("/") && pattern.length > 2;
  const looksLikeRegex = /\\/.test(pattern) || /[()[\]|?*+^$]/.test(pattern);
  const body = wrappedRegex ? pattern.slice(1, -1) : pattern;

  if (!wrappedRegex && !looksLikeRegex) {
    const needle = pattern.toLowerCase();
    return (text: string) => text.toLowerCase().includes(needle);
  }

  // ReDoS protection
  if (body.length > 256) {
    warn(`[context] Skipped excessively long deprecated pattern regex: ${pattern}`);
    return () => false;
  }
  if (/\([^)]*[*+][^)]*\)[*+?]/.test(body)) {
    warn(`[context] Skipped potentially unsafe deprecated pattern regex: ${pattern}`);
    return () => false;
  }

  try {
    const regex = new RegExp(body, "i");
    return (text: string) => regex.test(text);
  } catch {
    warn(`[context] Invalid deprecated pattern regex: ${pattern}`);
    return () => false;
  }
}

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
  limits: { maxBullets: number; maxHistory: number }
): ContextResult {
  // Apply size limits
  const maxBullets = Number.isFinite(limits.maxBullets) && limits.maxBullets > 0 ? limits.maxBullets : 10;
  const maxHistory = Number.isFinite(limits.maxHistory) && limits.maxHistory > 0 ? limits.maxHistory : 10;

  // Transform rules with additional metadata for LLM consumption
  // Exclude embedding vectors from output - they bloat JSON and are internal implementation detail
  const relevantBullets = rules.slice(0, maxBullets).map(b => {
    const { embedding: _embedding, ...withoutEmbedding } = b;
    return {
      ...withoutEmbedding,
      lastHelpful: formatLastHelpful(b),
      reasoning: extractBulletReasoning(b)
    };
  });

  // Transform anti-patterns with additional metadata
  // Exclude embedding vectors from output
  const transformedAntiPatterns = antiPatterns.slice(0, maxBullets).map(b => {
    const { embedding: _embedding, ...withoutEmbedding } = b;
    return {
      ...withoutEmbedding,
      lastHelpful: formatLastHelpful(b),
      reasoning: extractBulletReasoning(b)
    };
  });

  // Transform history snippets - simplify structure, truncate long snippets
  const historySnippets = history.slice(0, maxHistory).map(h => ({
    ...h,
    snippet: truncateWithIndicator(h.snippet.trim().replace(/\n/g, " "), 300)
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
  limit?: number;
  top?: number;
  history?: number;
  days?: number;
  workspace?: string;
  format?: "json" | "markdown" | "toon";
  stats?: boolean;
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

export type ContextProgressEvent =
  | {
    phase: "semantic_embeddings";
    kind: "start" | "progress" | "done";
    current: number;
    total: number;
    reused: number;
    computed: number;
    skipped: number;
    message: string;
  }
  | { phase: "cass_search"; kind: "start" | "done"; message: string };

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
  options: {
    json?: boolean;
    queryEmbedding?: number[];
    skipEmbeddingLoad?: boolean;
    onSemanticProgress?: (event: {
      phase: "start" | "progress" | "done";
      current: number;
      total: number;
      reused: number;
      computed: number;
      skipped: number;
      message: string;
    }) => void;
  } = {}
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
        await loadOrComputeEmbeddingsForBullets(bullets, {
          model: embeddingModel,
          onProgress: options.onSemanticProgress,
        });
      }
    } catch (err: any) {
      // Best-effort: ensure any pending progress UI is finalized to avoid stray spinners/logs.
      try {
        options.onSemanticProgress?.({
          phase: "done",
          current: bullets.length,
          total: bullets.length,
          reused: 0,
          computed: 0,
          skipped: bullets.length,
          message: "Semantic embeddings unavailable; using keyword-only scoring",
        });
      } catch {
        // ignore
      }
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

  // Sort by finalScore descending, with relevanceScore as tie-breaker for deterministic ordering
  scored.sort((a, b) => {
    const scoreDiff = (b.finalScore ?? 0) - (a.finalScore ?? 0);
    if (scoreDiff !== 0) return scoreDiff;
    return (b.relevanceScore ?? 0) - (a.relevanceScore ?? 0);
  });
  return scored;
}

/**
 * Programmatic context builder (no console output).
 */
export async function generateContextResult(
  task: string,
  flags: ContextFlags,
  options: { onProgress?: (event: ContextProgressEvent) => void } = {}
): Promise<ContextComputation> {
  const config = await loadConfig();
  const playbook = await loadMergedPlaybook(config);

  const keywords = extractKeywords(task);

  const activeBullets = getActiveBullets(playbook).filter((b) => {
    // Always include global rules
    if (b.scope !== "workspace") return true;
    
    // For workspace rules, only include if a workspace is specified AND matches
    if (!flags.workspace) return false;
    return b.workspace === flags.workspace;
  });

  const scoredBullets = await scoreBulletsEnhanced(activeBullets, task, keywords, config, {
    json: flags.json,
    onSemanticProgress: options.onProgress
      ? (event) =>
        options.onProgress?.({
          phase: "semantic_embeddings",
          kind: event.phase,
          current: event.current,
          total: event.total,
          reused: event.reused,
          computed: event.computed,
          skipped: event.skipped,
          message: event.message,
        })
      : undefined,
  });

  const maxBullets = flags.limit ?? flags.top ?? config.maxBulletsInContext;
  // scoredBullets is already sorted by finalScore with relevanceScore tie-breaker
  const topBullets = scoredBullets
    .filter(b => (b.finalScore || 0) > 0)
    .slice(0, maxBullets);

  const rules = topBullets.filter(b => !b.isNegative && b.kind !== "anti_pattern");
  const antiPatterns = topBullets.filter(b => b.isNegative || b.kind === "anti_pattern");

  let cassHits: CassSearchHit[] = [];
  let degraded: ContextResult["degraded"] | undefined;

  const cassQuery = keywords.join(" ");
  options.onProgress?.({ phase: "cass_search", kind: "start", message: "Searching history..." });
  const cassResult = await safeCassSearchWithDegraded(cassQuery, {
    limit: flags.history ?? config.maxHistoryInContext,
    days: flags.days ?? config.sessionLookbackDays,
    workspace: flags.workspace,
  }, config.cassPath, config);
  options.onProgress?.({ phase: "cass_search", kind: "done", message: "History search complete" });
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
    // Use safeDeprecatedPatternMatcher for ReDoS-safe regex matching
    const matches = safeDeprecatedPatternMatcher(pattern.pattern);
    if (matches(task)) {
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
    {
      maxBullets: flags.limit ?? flags.top ?? config.maxBulletsInContext,
      maxHistory: flags.history ?? config.maxHistoryInContext,
    }
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
      .slice(0, maxBullets ?? config.maxBulletsInContext);

    const rules = topBullets.filter(b => !b.isNegative && b.kind !== "anti_pattern");
    const antiPatterns = topBullets.filter(b => b.isNegative || b.kind === "anti_pattern");

    const warnings: string[] = ["Context generated without historical data (cass unavailable)"];
    for (const pattern of playbook.deprecatedPatterns) {
      // Use safeDeprecatedPatternMatcher for ReDoS-safe regex matching
      const matches = safeDeprecatedPatternMatcher(pattern.pattern);
      if (matches(task)) {
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
  const startedAtMs = Date.now();
  const command = "context";
  const cli = getCliName();
  const wantsJsonForErrors = isJsonOutput(flags);

  const taskCheck = validateNonEmptyString(task, "task", { trim: true });
  if (!taskCheck.ok) {
    reportError(taskCheck.message, {
      code: ErrorCode.INVALID_INPUT,
      details: taskCheck.details,
      hint: `Example: ${cli} context \"fix the login bug\" --json`,
      json: wantsJsonForErrors,
      format: flags.format,
      command,
      startedAtMs,
    });
    return;
  }
  const normalizedTask = taskCheck.value;

  // === TRAUMA CHECK (Pain Injection) ===
  let traumaWarning: ContextResult["traumaWarning"] | undefined;
  try {
    const traumas = await loadTraumas();
    const traumaMatch = findMatchingTrauma(normalizedTask, traumas);
    
    if (traumaMatch) {
      const msg = traumaMatch.trigger_event.human_message || "You previously caused a catastrophe with this pattern.";
      const ref = traumaMatch.trigger_event.session_path;
      
      // VISCERAL SCREAM TO STDERR (Always visible)
      const mark = iconPrefix("warning").trim();
      const marks = mark ? mark.repeat(3) : "";
      const banner = marks
        ? `${marks} CRITICAL WARNING: VISCERAL SAFETY INTERVENTION ${marks}`
        : "CRITICAL WARNING: VISCERAL SAFETY INTERVENTION";
      console.error(chalk.bgRed.white.bold(`\n${banner}`));
      console.error(chalk.red.bold(`You are inquiring about a pattern that has previously caused TRAUMA.`));
      console.error(chalk.red(`Pattern: ${traumaMatch.pattern}`));
      console.error(chalk.red(`Reason:  ${msg}`));
      console.error(chalk.red(`Ref:     ${ref}`));
      console.error(chalk.bgRed.white.bold("DO NOT PROCEED WITHOUT EXTREME CAUTION.\n"));
      
      traumaWarning = {
        pattern: traumaMatch.pattern,
        reason: msg,
        reference: ref
      };
    }
  } catch (e) {
    // Non-blocking
  }

  const limitCheck = validatePositiveInt(flags.limit, "limit", { min: 1, allowUndefined: true });
  if (!limitCheck.ok) {
    reportError(limitCheck.message, {
      code: ErrorCode.INVALID_INPUT,
      details: limitCheck.details,
      hint: `Example: ${cli} context \"<task>\" --limit 10 --json`,
      json: wantsJsonForErrors,
      format: flags.format,
      command,
      startedAtMs,
    });
    return;
  }

  const topCheck = validatePositiveInt(flags.top, "top", { min: 1, allowUndefined: true });
  if (!topCheck.ok) {
    reportError(topCheck.message, {
      code: ErrorCode.INVALID_INPUT,
      details: topCheck.details,
      hint: `Example: ${cli} context \"<task>\" --limit 10 --json`,
      json: wantsJsonForErrors,
      format: flags.format,
      command,
      startedAtMs,
    });
    return;
  }

  if (topCheck.value !== undefined) {
    if (limitCheck.value !== undefined) {
      warn("[context] Ignoring deprecated --top because --limit was also provided.");
    } else {
      warn("[context] --top is deprecated; use --limit.");
    }
  }

  const historyCheck = validatePositiveInt(flags.history, "history", { min: 1, allowUndefined: true });
  if (!historyCheck.ok) {
    reportError(historyCheck.message, {
      code: ErrorCode.INVALID_INPUT,
      details: historyCheck.details,
      hint: `Example: ${cli} context \"<task>\" --history 3 --json`,
      json: wantsJsonForErrors,
      format: flags.format,
      command,
      startedAtMs,
    });
    return;
  }

  const daysCheck = validatePositiveInt(flags.days, "days", { min: 1, allowUndefined: true });
  if (!daysCheck.ok) {
    reportError(daysCheck.message, {
      code: ErrorCode.INVALID_INPUT,
      details: daysCheck.details,
      hint: `Example: ${cli} context \"<task>\" --days 30 --json`,
      json: wantsJsonForErrors,
      format: flags.format,
      command,
      startedAtMs,
    });
    return;
  }

  const formatCheck = validateOneOf(flags.format, "format", ["json", "markdown", "toon"] as const, {
    allowUndefined: true,
    caseInsensitive: true,
  });
  if (!formatCheck.ok) {
    reportError(formatCheck.message, {
      code: ErrorCode.INVALID_INPUT,
      details: formatCheck.details,
      hint: `Valid formats: json, markdown, toon`,
      json: wantsJsonForErrors,
      format: flags.format,
      command,
      startedAtMs,
    });
    return;
  }

  const workspaceCheck = validateNonEmptyString(flags.workspace, "workspace", { allowUndefined: true });
  if (!workspaceCheck.ok) {
    reportError(workspaceCheck.message, {
      code: ErrorCode.INVALID_INPUT,
      details: workspaceCheck.details,
      hint: `Example: ${cli} context \"<task>\" --workspace . --json`,
      json: wantsJsonForErrors,
      format: flags.format,
      command,
      startedAtMs,
    });
    return;
  }

  const sessionCheck = validateNonEmptyString(flags.session, "session", { allowUndefined: true });
  if (!sessionCheck.ok) {
    reportError(sessionCheck.message, {
      code: ErrorCode.INVALID_INPUT,
      details: sessionCheck.details,
      hint: `Example: ${cli} context \"<task>\" --session <id> --log-context --json`,
      json: wantsJsonForErrors,
      format: flags.format,
      command,
      startedAtMs,
    });
    return;
  }

  const normalizedFlags: ContextFlags = {
    ...flags,
    ...((limitCheck.value ?? topCheck.value) !== undefined ? { limit: limitCheck.value ?? topCheck.value } : {}),
    ...(historyCheck.value !== undefined ? { history: historyCheck.value } : {}),
    ...(daysCheck.value !== undefined ? { days: daysCheck.value } : {}),
    ...(formatCheck.value !== undefined ? { format: formatCheck.value } : {}),
    ...(workspaceCheck.value !== undefined ? { workspace: workspaceCheck.value } : {}),
    ...(sessionCheck.value !== undefined ? { session: sessionCheck.value } : {}),
  };

  const wantsJson = isJsonOutput(normalizedFlags);
  const wantsToon = isToonOutput(normalizedFlags);
  const wantsMarkdown = normalizedFlags.format === "markdown";
  const progressFormat = (wantsJson || wantsToon) ? "json" : "text";
  const embeddingsProgressRef: { current: ProgressReporter | null } = { current: null };
  const cassProgressRef: { current: ProgressReporter | null } = { current: null };

  try {
    const { result, rules, antiPatterns, cassHits, warnings, suggestedQueries } = await generateContextResult(normalizedTask, normalizedFlags, {
      onProgress: (event) => {
        if (event.phase === "semantic_embeddings") {
          if (event.total <= 0) return;

          if (!embeddingsProgressRef.current && event.kind === "start") {
            embeddingsProgressRef.current = createProgress({
              message: event.message,
              total: event.total,
              showEta: true,
              format: progressFormat,
              stream: process.stderr,
            });
          }

          embeddingsProgressRef.current?.update(event.current, event.message);

          if (event.kind === "done") {
            const counts = `(${event.computed} computed, ${event.reused} cached, ${event.skipped} skipped)`;
            embeddingsProgressRef.current?.complete(event.message ? `${event.message} ${counts}` : counts);
            embeddingsProgressRef.current = null;
          }
          return;
        }

        if (event.phase === "cass_search") {
          if (event.kind === "start") {
            cassProgressRef.current = createProgress({
              message: event.message,
              format: progressFormat,
              stream: process.stderr,
            });
            cassProgressRef.current.update(0, event.message);
            return;
          }
          cassProgressRef.current?.complete(event.message);
          cassProgressRef.current = null;
        }
      },
    });

    // Merge trauma warning
    if (traumaWarning) {
      result.traumaWarning = traumaWarning;
    }

  if (wantsJson || wantsToon) {
    printStructuredResult(command, result, normalizedFlags, { startedAtMs });
    return;
  }

  const maxWidth = Math.min(getOutputStyle().width, 84);
  const divider = chalk.dim(formatRule("─", { maxWidth }));

  if (wantsMarkdown) {
    const snippetWidth = 300;
    console.log(`# Context for: ${normalizedTask}\n`);

    console.log(`## Playbook rules (${rules.length})\n`);
    if (rules.length === 0) {
      console.log(`(No relevant playbook rules found)\n`);
    } else {
      for (const b of rules) {
        const score = Number.isFinite(b.effectiveScore) ? b.effectiveScore.toFixed(1) : "n/a";
        console.log(`- **${b.id}** (${b.category}/${b.kind}, score ${score}): ${b.content.trim()}`);
      }
      console.log("");
    }

    console.log(`## Pitfalls (${antiPatterns.length})\n`);
    if (antiPatterns.length === 0) {
      console.log(`(No pitfalls detected)\n`);
    } else {
      for (const b of antiPatterns) {
        console.log(`- **${b.id}** (${b.category}/${b.kind}): ${b.content.trim()}`);
      }
      console.log("");
    }

    console.log(`## History (${cassHits.length})\n`);
    if (cassHits.length === 0) {
      console.log(`(No relevant history found)\n`);
    } else {
      const shown = Math.min(cassHits.length, 3);
      for (const h of cassHits.slice(0, shown)) {
        const agent = h.agent || "unknown";
        const host = h.origin?.kind === "remote" && h.origin.host ? ` (${h.origin.host})` : "";
        const snippet = truncateWithIndicator(h.snippet.trim().replace(/\s+/g, " "), snippetWidth);
        console.log(`- **${agent}${host}** \`${h.source_path}\`: "${snippet}"`);
      }
      if (cassHits.length > shown) {
        console.log(`- … and ${cassHits.length - shown} more`);
      }
      console.log("");
    }

    if (warnings.length > 0) {
      console.log(`## Warnings (${warnings.length})\n`);
      for (const w of warnings) console.log(`- ${w}`);
      console.log("");
    }

    if (suggestedQueries.length > 0) {
      console.log(`## Suggested searches\n`);
      for (const q of suggestedQueries) console.log(`- ${q}`);
      console.log("");
    }
    return;
  }

  // Human Output (premium, width-aware)
  console.log(chalk.bold(`CONTEXT FOR: ${normalizedTask}`));
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
  } catch (err: any) {
    const message = err?.message || String(err);
    embeddingsProgressRef.current?.fail(message);
    cassProgressRef.current?.fail(message);
    throw err;
  }
}
