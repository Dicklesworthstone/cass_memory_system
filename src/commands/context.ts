import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import chalk from "chalk";
import { safeCassSearchWithDegraded } from "../cass.js";
import { findBulletConflicts } from "../curate.js";
import { getSanitizeConfig, loadConfig } from "../config.js";
import { withLock } from "../lock.js";
import {
  agentIconPrefix,
  formatRule,
  formatTipPrefix,
  getOutputStyle,
  iconPrefix,
  wrapText,
} from "../output.js";
import { getActiveBullets, loadMergedPlaybookWithSources } from "../playbook.js";
import { createProgress, type ProgressReporter } from "../progress.js";
import { sanitize } from "../sanitize.js";
import { getEffectiveScore, getFeedbackMultiplier } from "../scoring.js";
import {
  cosineSimilarity,
  embedText,
  loadOrComputeEmbeddingsForBullets,
  resolveSemanticEnabled,
} from "../semantic.js";
import { findMatchingTrauma, loadTraumas } from "../trauma.js";
import { workspaceMatches } from "../workspace.js";
import {
  type CassSearchHit,
  type Config,
  type ContextBullet,
  type ContextResult,
  ErrorCode,
  type PlaybookBullet,
  type ScoredBullet,
} from "../types.js";
import {
  atomicWrite,
  cassSearchCommand,
  checkDeprecatedPatterns,
  ensureDir,
  expandPath,
  extractBulletReasoning,
  extractKeywords,
  fileExists,
  formatLastHelpful,
  generateSuggestedQueries,
  getCliName,
  isJsonOutput,
  isToonOutput,
  normalizeSearchPointer,
  printStructuredResult,
  readStdinText,
  reportError,
  resolveGlobalDir,
  resolveRepoDir,
  scoreLexicalRelevance,
  truncateWithIndicator,
  validateNonEmptyString,
  validateOneOf,
  validatePositiveInt,
  warn,
} from "../utils.js";

const MAX_CASS_HISTORY_QUERY_TERMS = 8;
// Fallback only; the effective budget is config.cassHistoryTimeoutSeconds (#78).
const DEFAULT_CASS_HISTORY_TIMEOUT_SECONDS = 20;
const PATHOLOGICAL_CASS_QUERY_TOKEN = /^(?:bd|br)-[a-z0-9]+(?:[.-][a-z0-9]+)+$/i;

/**
 * Resolve the effective workspace path for filtering workspace-scoped bullets.
 *
 * Workspace-scoped bullets store their `workspace` field as an absolute path
 * and are matched with `bulletAppliesToWorkspace`. To make repo-local rules visible:
 *  - default to the current working directory when no workspace is provided, so
 *    running `cm context` inside a repo surfaces that repo's rules; and
 *  - canonicalize any provided value (expand `~`, resolve `.`/relative paths and
 *    symlinks) to an absolute path so the documented `--workspace .` matches.
 *
 * Returns the canonicalized absolute path, or `undefined` only if even cwd
 * cannot be resolved (which should never happen in practice).
 */
export function resolveWorkspaceFilter(workspace?: string): string | undefined {
  const raw =
    typeof workspace === "string" && workspace.trim() !== "" ? workspace.trim() : process.cwd();
  // Expand ~ first, then resolve relative segments against cwd.
  const expanded = expandPath(raw);
  let resolved: string;
  try {
    resolved = path.resolve(expanded);
  } catch {
    return undefined;
  }
  // Best-effort symlink canonicalization so a symlinked repo path still matches
  // a stored real path (and vice versa). Falls back to the resolved path when
  // the directory does not exist yet.
  try {
    return fsSync.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/**
 * Should a bullet be offered in `effectiveWorkspace`?
 *
 * Non-workspace scopes always apply. A `scope: workspace` bullet applies when
 * the working directory is its workspace or below it, with linked git
 * worktrees mapped onto the main worktree (#81). A workspace-scoped bullet
 * from the repo playbook may omit `workspace` (so the file stays portable
 * across clones); it is scoped to the repository that playbook belongs to.
 */
export function bulletAppliesToWorkspace(
  bullet: PlaybookBullet,
  effectiveWorkspace: string | undefined,
  repo: { repoRoot: string | null; repoBulletIds: Set<string> } = {
    repoRoot: null,
    repoBulletIds: new Set(),
  },
): boolean {
  if (bullet.scope !== "workspace") return true;
  if (!effectiveWorkspace) return false;
  const scopeDir =
    bullet.workspace && bullet.workspace.trim() !== ""
      ? bullet.workspace
      : repo.repoRoot && repo.repoBulletIds.has(bullet.id)
        ? repo.repoRoot
        : undefined;
  if (!scopeDir) return false;
  return workspaceMatches(scopeDir, effectiveWorkspace);
}

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
 * Project a scored bullet onto what `cm context` returns (see ContextBulletSchema):
 * no feedback-event log, source-session list or embedding.
 */
export function toContextBullet(b: ScoredBullet): ContextBullet {
  return {
    id: b.id,
    scope: b.scope,
    ...(b.workspace ? { workspace: b.workspace } : {}),
    category: b.category,
    content: b.content,
    type: b.type,
    isNegative: b.isNegative,
    kind: b.kind,
    state: b.state,
    maturity: b.maturity,
    ...(b.pinned ? { pinned: true } : {}),
    tags: b.tags ?? [],
    helpfulCount: b.helpfulCount ?? 0,
    harmfulCount: b.harmfulCount ?? 0,
    ...(b.searchPointer ? { searchPointer: b.searchPointer } : {}),
    relevanceScore: roundScore(b.relevanceScore),
    effectiveScore: roundScore(b.effectiveScore),
    ...(b.finalScore !== undefined ? { finalScore: roundScore(b.finalScore) } : {}),
    lastHelpful: formatLastHelpful(b),
    reasoning: extractBulletReasoning(b),
  };
}

function roundScore(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.round(value * 1000) / 1000;
}

/** ~4 chars per token, the same estimate `--stats` uses. */
function estimateTokensOf(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4);
}

export interface ContextSelectionOptions {
  maxBullets: number;
  /** Absolute relevance floor (config.minRelevanceScore). */
  minRelevance: number;
  /** Relative floor as a fraction of the best relevance (config.minRelativeRelevance). */
  minRelativeRelevance: number;
  /** Approximate token budget for the selected bullets; 0 = unlimited. */
  tokenBudget: number;
}

export interface ContextSelectionStats {
  candidates: number;
  returned: number;
  droppedByRelevance: number;
  droppedByLimit: number;
  droppedByTokenBudget: number;
  tokenBudget: number;
  estimatedTokens: number;
}

/**
 * Choose which ranked bullets go into a context result (#89).
 *
 * `scored` must already be sorted best-first. Bullets below the absolute
 * relevance floor, or below `minRelativeRelevance` × the best bullet's
 * relevance, are dropped; then at most `maxBullets` are kept, in rank order,
 * while their compact projection fits the token budget. The top bullet is
 * always kept even if it alone exceeds the budget, so a tiny budget degrades
 * to "the single best rule" rather than to nothing.
 */
export function selectContextBullets(
  scored: ScoredBullet[],
  options: ContextSelectionOptions,
): { selected: ScoredBullet[]; stats: ContextSelectionStats } {
  const maxBullets =
    Number.isFinite(options.maxBullets) && options.maxBullets > 0 ? options.maxBullets : 10;
  const tokenBudget =
    Number.isFinite(options.tokenBudget) && options.tokenBudget > 0 ? options.tokenBudget : 0;
  const minRelevance = Number.isFinite(options.minRelevance) ? options.minRelevance : 0;
  const relative = Number.isFinite(options.minRelativeRelevance)
    ? Math.min(1, Math.max(0, options.minRelativeRelevance))
    : 0;

  const aboveFloor = scored.filter((b) => (b.relevanceScore ?? 0) >= minRelevance);
  const bestRelevance = aboveFloor.reduce((max, b) => Math.max(max, b.relevanceScore ?? 0), 0);
  const relevant = aboveFloor.filter(
    (b) => (b.relevanceScore ?? 0) >= bestRelevance * relative,
  );

  const capped = relevant.slice(0, maxBullets);
  const selected: ScoredBullet[] = [];
  let estimatedTokens = 0;
  let droppedByTokenBudget = 0;
  for (const b of capped) {
    const cost = estimateTokensOf(toContextBullet(b));
    if (tokenBudget > 0 && selected.length > 0 && estimatedTokens + cost > tokenBudget) {
      droppedByTokenBudget = capped.length - selected.length;
      break;
    }
    selected.push(b);
    estimatedTokens += cost;
  }

  return {
    selected,
    stats: {
      candidates: scored.length,
      returned: selected.length,
      droppedByRelevance: scored.length - relevant.length,
      droppedByLimit: relevant.length - capped.length,
      droppedByTokenBudget,
      tokenBudget,
      estimatedTokens,
    },
  };
}

/**
 * Contradicting pairs among the bullets being returned together, so an agent
 * is told when it is handed opposing advice instead of silently picking one.
 */
export function conflictsAmong(bullets: ScoredBullet[]): NonNullable<ContextResult["conflicts"]> {
  return findBulletConflicts(bullets).map((p) => ({ ids: [p.a.id, p.b.id], reason: p.reason }));
}

function conflictWarning(c: { ids: string[]; reason: string }): string {
  const cli = getCliName();
  return `Rules ${c.ids[0]} and ${c.ids[1]} may contradict each other (${c.reason}). Follow the one that fits this task; resolve with '${cli} playbook conflicts'.`;
}

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
  limits: { maxBullets: number; maxHistory: number },
): ContextResult {
  // Apply size limits
  const maxBullets =
    Number.isFinite(limits.maxBullets) && limits.maxBullets > 0 ? limits.maxBullets : 10;
  const maxHistory =
    Number.isFinite(limits.maxHistory) && limits.maxHistory > 0 ? limits.maxHistory : 10;

  const relevantBullets = rules.slice(0, maxBullets).map(toContextBullet);
  const transformedAntiPatterns = antiPatterns.slice(0, maxBullets).map(toContextBullet);

  // Transform history snippets - simplify structure, truncate long snippets
  const historySnippets = history.slice(0, maxHistory).map((h) => ({
    ...h,
    snippet: truncateWithIndicator(h.snippet.trim().replace(/\n/g, " "), 300),
  }));

  return {
    task,
    relevantBullets,
    antiPatterns: transformedAntiPatterns,
    historySnippets,
    deprecatedWarnings: warnings,
    suggestedCassQueries: suggestedQueries,
  };
}

function isSafeCassHistoryKeyword(token: string): boolean {
  const normalized = token.trim().toLowerCase();
  if (!normalized || normalized.length < 2) {
    return false;
  }
  if (/^\d+$/.test(normalized)) {
    return false;
  }
  if (PATHOLOGICAL_CASS_QUERY_TOKEN.test(normalized)) {
    return false;
  }
  if (/[./\\]/.test(normalized)) {
    return false;
  }
  return true;
}

export function buildCassHistoryQuery(
  task: string,
  maxTerms = MAX_CASS_HISTORY_QUERY_TERMS,
): string {
  const keywords = extractKeywords(task)
    .filter(isSafeCassHistoryKeyword)
    .slice(0, Math.max(1, maxTerms));

  if (keywords.length === 0) {
    return "";
  }

  if (keywords.length === 1) {
    return keywords[0];
  }

  return keywords.join(" OR ");
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
  /** Approximate token budget for returned bullets; overrides config.contextTokenBudget. 0 = unlimited. */
  maxTokens?: number;
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

export interface ScoreBulletsMeta {
  /** Mode actually used: "semantic" when query+bullet embeddings were loaded, else "keyword". */
  semanticMode: "semantic" | "keyword";
  /** If the user asked for semantic but we fell back, this holds the underlying error message. */
  semanticError?: string;
  /**
   * Why semantic search never ran in *automatic* mode (`semanticSearchEnabled`
   * unset, backend not ready offline). Mutually exclusive with
   * `semanticError`, which only ever describes a failure of a run we attempted.
   */
  semanticNotice?: string;
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
    /** Optional out-param: receives which scoring mode ran + why it degraded. */
    meta?: ScoreBulletsMeta;
  } = {},
): Promise<ScoredBullet[]> {
  if (bullets.length === 0) {
    if (options.meta) {
      options.meta.semanticMode = "keyword";
    }
    return [];
  }

  const embeddingModel =
    typeof config.embeddingModel === "string" && config.embeddingModel.trim() !== ""
      ? config.embeddingModel.trim()
      : undefined;
  // Never read `semanticSearchEnabled` by truthiness: unset means "automatic"
  // (#75), which only the resolver can settle (it probes backend readiness).
  const semanticStatus = await resolveSemanticEnabled(config);
  const semanticEnabled = semanticStatus.enabled;

  const semanticWeight = clamp01(
    typeof config.semanticWeight === "number" ? config.semanticWeight : 0.6,
  );

  let queryEmbedding: number[] | null = null;
  let semanticError: string | undefined;
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
      semanticError = err?.message ? String(err.message) : String(err);
      // ALWAYS warn (not just in human output). Silent fallback hid a
      // major runtime regression in v0.2.5 (standalone binary WASM init
      // failures). Stderr warnings don't pollute JSON stdout.
      warn(
        `[context] Semantic search unavailable; using keyword-only scoring. ${semanticError || ""}`.trim(),
      );
    }
  }

  // Record which mode we actually ran.
  if (options.meta) {
    const ran =
      semanticEnabled && queryEmbedding && queryEmbedding.length > 0
        ? ("semantic" as const)
        : ("keyword" as const);
    options.meta.semanticMode = ran;
    if (semanticEnabled && ran === "keyword") {
      options.meta.semanticError =
        semanticError || "Semantic search requested but no query embedding produced";
    } else if (semanticStatus.posture === "auto-off") {
      // Nobody asked for semantic search, so this is not an error — but it
      // must still be visible, or "keyword-only" looks like a deliberate
      // choice the user never made (#75).
      options.meta.semanticNotice = semanticStatus.enableHint
        ? `${semanticStatus.reason}. ${semanticStatus.enableHint}`
        : semanticStatus.reason;
    }
  }

  const keywordScores = scoreLexicalRelevance(bullets, keywords);
  const scored: ScoredBullet[] = bullets.map((b) => {
    const keywordScore = keywordScores.get(b.id) ?? 0;

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
    return {
      ...b,
      relevanceScore,
      effectiveScore: getEffectiveScore(b, config),
      // Relevance decides what is retrieved; the track record only reorders
      // it within a bounded band (#89).
      finalScore: relevanceScore * getFeedbackMultiplier(b, config),
    };
  });

  return sortScoredBullets(scored);
}

/**
 * Keyword-only scoring (no embeddings), for paths that must not touch the
 * semantic backend. Same scale and ranking rule as `scoreBulletsEnhanced`.
 */
export function scoreBulletsKeyword(
  bullets: PlaybookBullet[],
  keywords: string[],
  config: Config,
): ScoredBullet[] {
  const keywordScores = scoreLexicalRelevance(bullets, keywords);
  return sortScoredBullets(
    bullets.map((b) => {
      const relevanceScore = keywordScores.get(b.id) ?? 0;
      return {
        ...b,
        relevanceScore,
        effectiveScore: getEffectiveScore(b, config),
        finalScore: relevanceScore * getFeedbackMultiplier(b, config),
      };
    }),
  );
}

/** finalScore descending; relevance, then id, as deterministic tie-breakers. */
function sortScoredBullets(scored: ScoredBullet[]): ScoredBullet[] {
  return scored.sort((a, b) => {
    const scoreDiff = (b.finalScore ?? 0) - (a.finalScore ?? 0);
    if (scoreDiff !== 0) return scoreDiff;
    const relDiff = (b.relevanceScore ?? 0) - (a.relevanceScore ?? 0);
    if (relDiff !== 0) return relDiff;
    return a.id.localeCompare(b.id);
  });
}

function contextSelectionOptions(
  config: Config,
  flags: { limit?: number; top?: number; maxTokens?: number },
): ContextSelectionOptions {
  return {
    maxBullets: flags.limit ?? flags.top ?? config.maxBulletsInContext,
    minRelevance: config.minRelevanceScore,
    minRelativeRelevance: config.minRelativeRelevance,
    tokenBudget: flags.maxTokens ?? config.contextTokenBudget,
  };
}

/**
 * Programmatic context builder (no console output).
 */
export async function generateContextResult(
  task: string,
  flags: ContextFlags,
  options: { onProgress?: (event: ContextProgressEvent) => void } = {},
): Promise<ContextComputation> {
  const config = await loadConfig();

  // Default workspace to cwd and canonicalize so repo-local (workspace-scoped)
  // rules surface automatically, and `--workspace .`/relative paths match the
  // absolute paths stored on bullets.
  const effectiveWorkspace = resolveWorkspaceFilter(flags.workspace);

  // The repo playbook comes from the workspace being asked about, not from
  // wherever this process happens to run (matters for `cm serve`, #81).
  const sources = await loadMergedPlaybookWithSources(
    config,
    effectiveWorkspace ? { cwd: effectiveWorkspace } : {},
  );
  const playbook = sources.playbook;

  const keywords = extractKeywords(task);
  const cassQuery = buildCassHistoryQuery(task);

  const activeBullets = getActiveBullets(playbook).filter((b) =>
    bulletAppliesToWorkspace(b, effectiveWorkspace, sources),
  );

  const scoringMeta: ScoreBulletsMeta = { semanticMode: "keyword" };
  const scoredBullets = await scoreBulletsEnhanced(activeBullets, task, keywords, config, {
    json: flags.json,
    meta: scoringMeta,
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

  const selectionOptions = contextSelectionOptions(config, flags);
  const { selected: topBullets, stats: selectionStats } = selectContextBullets(
    scoredBullets,
    selectionOptions,
  );

  const rules = topBullets.filter((b) => !b.isNegative && b.kind !== "anti_pattern");
  const antiPatterns = topBullets.filter((b) => b.isNegative || b.kind === "anti_pattern");

  let cassHits: CassSearchHit[] = [];
  let degraded: ContextResult["degraded"] | undefined;

  options.onProgress?.({ phase: "cass_search", kind: "start", message: "Searching history..." });
  const cassResult = await safeCassSearchWithDegraded(
    cassQuery,
    {
      limit: flags.history ?? config.maxHistoryInContext,
      days: flags.days ?? config.historyLookbackDays,
      workspace: flags.workspace,
      timeout: config.cassHistoryTimeoutSeconds ?? DEFAULT_CASS_HISTORY_TIMEOUT_SECONDS,
    },
    config.cassPath,
    config,
  );
  options.onProgress?.({ phase: "cass_search", kind: "done", message: "History search complete" });
  cassHits = cassResult.hits;
  if (cassResult.degraded || cassResult.remoteDegraded) {
    degraded = {
      cass: cassResult.degraded,
      remoteCass: cassResult.remoteDegraded,
    };
  }

  const warnings: string[] = [];
  const historyWarnings = checkDeprecatedPatterns(cassHits, playbook.deprecatedPatterns);
  warnings.push(...historyWarnings);
  const conflicts = conflictsAmong(topBullets);
  warnings.push(...conflicts.map(conflictWarning));

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
  // The top rules' search pointers lead straight to the sessions that taught
  // them, so they come first; task-derived queries fill the rest.
  const pointerQueries = topBullets
    .map((b) => normalizeSearchPointer(b.searchPointer))
    .filter((q) => q !== "")
    .slice(0, 2)
    .map((q) => cassSearchCommand(q, config.historyLookbackDays));
  const suggestedQueries = Array.from(
    new Set([...pointerQueries, ...generateSuggestedQueries(task, keywords, { maxSuggestions: 5 })]),
  ).slice(0, 6);

  const result = buildContextResult(
    task,
    rules,
    antiPatterns,
    cassHits,
    warnings,
    suggestedQueries,
    {
      maxBullets: selectionOptions.maxBullets,
      maxHistory: flags.history ?? config.maxHistoryInContext,
    },
  );
  if (degraded) {
    result.degraded = degraded;
  }
  result.retrieval = selectionStats;
  if (conflicts.length > 0) result.conflicts = conflicts;

  // Surface which mode actually ran + why we degraded (if applicable).
  // This makes silent semantic-search fallback visible to agents consuming
  // JSON/TOON output (e.g. `cm context ... --json | jq '.data.semanticMode'`).
  result.semanticMode = scoringMeta.semanticMode;
  if (scoringMeta.semanticError) {
    result.semanticError = scoringMeta.semanticError;
  } else if (scoringMeta.semanticNotice) {
    result.semanticNotice = scoringMeta.semanticNotice;
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

    const logPath = repoLog ? repoLog : path.join(resolveGlobalDir(), "context-log.jsonl");

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
  options: { workspace?: string; maxBullets?: number; reason?: string } = {},
): Promise<ContextResult> {
  const { workspace, maxBullets, reason } = options;

  warn(`cass unavailable - showing playbook only${reason ? ` (${reason})` : ""}`);

  try {
    // Mirror generateContextResult: default workspace to cwd and canonicalize
    // so workspace-scoped rules surface in the cass-unavailable fallback too.
    const effectiveWorkspace = resolveWorkspaceFilter(workspace);

    const sources = await loadMergedPlaybookWithSources(
      config,
      effectiveWorkspace ? { cwd: effectiveWorkspace } : {},
    );
    const playbook = sources.playbook;
    const keywords = extractKeywords(task);

    const activeBullets = getActiveBullets(playbook).filter((b) =>
      bulletAppliesToWorkspace(b, effectiveWorkspace, sources),
    );

    const scoredBullets = scoreBulletsKeyword(activeBullets, keywords, config);
    const { selected: topBullets, stats: selectionStats } = selectContextBullets(
      scoredBullets,
      contextSelectionOptions(config, { limit: maxBullets }),
    );

    const rules = topBullets.filter((b) => !b.isNegative && b.kind !== "anti_pattern");
    const antiPatterns = topBullets.filter((b) => b.isNegative || b.kind === "anti_pattern");

    const warnings: string[] = ["Context generated without historical data (cass unavailable)"];
    const conflicts = conflictsAmong(topBullets);
    warnings.push(...conflicts.map(conflictWarning));
    for (const pattern of playbook.deprecatedPatterns) {
      // Use safeDeprecatedPatternMatcher for ReDoS-safe regex matching
      const matches = safeDeprecatedPatternMatcher(pattern.pattern);
      if (matches(task)) {
        const reasonSuffix = pattern.reason ? ` (Reason: ${pattern.reason})` : "";
        const replacement = pattern.replacement ? ` - use ${pattern.replacement} instead` : "";
        warnings.push(
          `Task matches deprecated pattern "${pattern.pattern}"${replacement}${reasonSuffix}`,
        );
      }
    }

    return {
      task,
      relevantBullets: rules.map(toContextBullet),
      antiPatterns: antiPatterns.map(toContextBullet),
      historySnippets: [],
      deprecatedWarnings: warnings,
      suggestedCassQueries: [],
      retrieval: selectionStats,
      ...(conflicts.length > 0 ? { conflicts } : {}),
    };
  } catch (err) {
    warn(`Playbook also unavailable: ${err}`);
    return {
      task,
      relevantBullets: [],
      antiPatterns: [],
      historySnippets: [],
      deprecatedWarnings: ["Context unavailable - both cass and playbook failed to load"],
      suggestedCassQueries: [],
    };
  }
}

// Legacy export wrapper
export async function getContext(task: string, flags: ContextFlags = {}) {
  const { result, rules, antiPatterns, cassHits, warnings, suggestedQueries } =
    await generateContextResult(task, flags);
  return { result, rules, antiPatterns, cassHits, warnings, suggestedQueries };
}

export async function contextCommand(task: string | undefined, flags: ContextFlags) {
  const startedAtMs = Date.now();
  const command = "context";
  const cli = getCliName();
  const wantsJsonForErrors = isJsonOutput(flags);

  // `echo "fix CORS" | cm context --json` and `cm context - --json`: the task
  // comes from stdin when it is not given (or is "-") and stdin is piped.
  if ((task === undefined || task.trim() === "" || task === "-") && !process.stdin.isTTY) {
    try {
      task = await readStdinText({ firstByteTimeoutMs: 2000 });
    } catch {
      task = "";
    }
  }

  const taskCheck = validateNonEmptyString(task, "task", { trim: true });
  if (!taskCheck.ok) {
    reportError(taskCheck.message, {
      code: ErrorCode.INVALID_INPUT,
      details: taskCheck.details,
      hint: `Example: ${cli} context "fix the login bug" --json`,
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
      const msg =
        traumaMatch.trigger_event.human_message ||
        "You previously caused a catastrophe with this pattern.";
      const ref = traumaMatch.trigger_event.session_path;

      // VISCERAL SCREAM TO STDERR (Always visible)
      const mark = iconPrefix("warning").trim();
      const marks = mark ? mark.repeat(3) : "";
      const banner = marks
        ? `${marks} CRITICAL WARNING: VISCERAL SAFETY INTERVENTION ${marks}`
        : "CRITICAL WARNING: VISCERAL SAFETY INTERVENTION";
      console.error(chalk.bgRed.white.bold(`\n${banner}`));
      console.error(
        chalk.red.bold(`You are inquiring about a pattern that has previously caused TRAUMA.`),
      );
      console.error(chalk.red(`Pattern: ${traumaMatch.pattern}`));
      console.error(chalk.red(`Reason:  ${msg}`));
      console.error(chalk.red(`Ref:     ${ref}`));
      console.error(chalk.bgRed.white.bold("DO NOT PROCEED WITHOUT EXTREME CAUTION.\n"));

      traumaWarning = {
        pattern: traumaMatch.pattern,
        reason: msg,
        reference: ref,
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
      hint: `Example: ${cli} context "<task>" --limit 10 --json`,
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
      hint: `Example: ${cli} context "<task>" --limit 10 --json`,
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

  const historyCheck = validatePositiveInt(flags.history, "history", {
    min: 1,
    allowUndefined: true,
  });
  if (!historyCheck.ok) {
    reportError(historyCheck.message, {
      code: ErrorCode.INVALID_INPUT,
      details: historyCheck.details,
      hint: `Example: ${cli} context "<task>" --history 3 --json`,
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
      hint: `Example: ${cli} context "<task>" --days 30 --json`,
      json: wantsJsonForErrors,
      format: flags.format,
      command,
      startedAtMs,
    });
    return;
  }

  const maxTokensCheck = validatePositiveInt(flags.maxTokens, "max-tokens", {
    min: 0,
    allowUndefined: true,
  });
  if (!maxTokensCheck.ok) {
    reportError(maxTokensCheck.message, {
      code: ErrorCode.INVALID_INPUT,
      details: maxTokensCheck.details,
      hint: `Example: ${cli} context "<task>" --max-tokens 2000 --json (0 = unlimited)`,
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

  const workspaceCheck = validateNonEmptyString(flags.workspace, "workspace", {
    allowUndefined: true,
  });
  if (!workspaceCheck.ok) {
    reportError(workspaceCheck.message, {
      code: ErrorCode.INVALID_INPUT,
      details: workspaceCheck.details,
      hint: `Example: ${cli} context "<task>" --workspace . --json`,
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
      hint: `Example: ${cli} context "<task>" --session <id> --log-context --json`,
      json: wantsJsonForErrors,
      format: flags.format,
      command,
      startedAtMs,
    });
    return;
  }

  const normalizedFlags: ContextFlags = {
    ...flags,
    ...((limitCheck.value ?? topCheck.value) !== undefined
      ? { limit: limitCheck.value ?? topCheck.value }
      : {}),
    ...(historyCheck.value !== undefined ? { history: historyCheck.value } : {}),
    ...(daysCheck.value !== undefined ? { days: daysCheck.value } : {}),
    ...(maxTokensCheck.value !== undefined ? { maxTokens: maxTokensCheck.value } : {}),
    ...(formatCheck.value !== undefined ? { format: formatCheck.value } : {}),
    ...(workspaceCheck.value !== undefined ? { workspace: workspaceCheck.value } : {}),
    ...(sessionCheck.value !== undefined ? { session: sessionCheck.value } : {}),
  };

  const wantsJson = isJsonOutput(normalizedFlags);
  const wantsToon = isToonOutput(normalizedFlags);
  const wantsMarkdown = normalizedFlags.format === "markdown";
  const progressFormat = wantsJson || wantsToon ? "json" : "text";
  const embeddingsProgressRef: { current: ProgressReporter | null } = { current: null };
  const cassProgressRef: { current: ProgressReporter | null } = { current: null };

  try {
    const { result, rules, antiPatterns, cassHits, warnings, suggestedQueries } =
      await generateContextResult(normalizedTask, normalizedFlags, {
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
              embeddingsProgressRef.current?.complete(
                event.message ? `${event.message} ${counts}` : counts,
              );
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
          const relevance = Number.isFinite(b.relevanceScore) ? b.relevanceScore.toFixed(1) : "n/a";
          const confidence = Number.isFinite(b.effectiveScore)
            ? b.effectiveScore.toFixed(1)
            : "n/a";
          console.log(
            `- **${b.id}** (${b.category}/${b.kind}, relevance ${relevance}, confidence ${confidence}): ${b.content.trim()}`,
          );
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
          const snippet = truncateWithIndicator(
            h.snippet.trim().replace(/\s+/g, " "),
            snippetWidth,
          );
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

    // Loud, one-line banner when semantic search was requested but we fell
    // back to keyword-only. Silent fallback hid a binary-build regression
    // for an entire release cycle — never again.
    if (result.semanticError) {
      console.log(
        chalk.yellow(
          `${iconPrefix("warning")}Semantic search unavailable; using keyword-only scoring.`,
        ),
      );
      console.log(chalk.yellow(`  Reason: ${result.semanticError}`));
      console.log(
        chalk.yellow(
          `  Fix:    set "embeddingBackend": "ollama" in ~/.cass-memory/config.json, ` +
            `or build from source (install.sh --from-source), ` +
            `or disable: semanticSearchEnabled: false`,
        ),
      );
      console.log("");
    } else if (result.semanticNotice) {
      // Automatic mode, backend not ready: informational, not a failure.
      console.log(chalk.dim(`${iconPrefix("tip")}Keyword-only search. ${result.semanticNotice}`));
      console.log("");
    }

    if (result.degraded?.cass && !result.degraded.cass.available) {
      const cass = result.degraded.cass;
      const suggested = Array.isArray(cass.suggestedFix) ? cass.suggestedFix.filter(Boolean) : [];
      const primaryHint = suggested[0] || `${cli} doctor`;
      const remoteOnlyNote = cassHits.length > 0 ? " (showing remote history only)" : "";
      console.log(
        chalk.yellow(
          `${iconPrefix("warning")}Local history unavailable (cass: ${cass.reason})${remoteOnlyNote}.`,
        ),
      );
      console.log(chalk.yellow(`  Next: ${primaryHint}`));
      console.log("");
    }

    // Playbook rules
    if (rules.length > 0) {
      console.log(chalk.bold(`PLAYBOOK RULES (${rules.length})`));
      console.log(divider);
      const contentWidth = Math.max(24, maxWidth - 2);

      for (const b of rules) {
        const relevance = Number.isFinite(b.relevanceScore) ? b.relevanceScore.toFixed(1) : "n/a";
        const confidence = Number.isFinite(b.effectiveScore) ? b.effectiveScore.toFixed(1) : "n/a";
        const maturity = b.maturity ? ` • ${b.maturity}` : "";
        console.log(
          chalk.bold(`[${b.id}]`) +
            chalk.dim(
              ` ${b.category}/${b.kind} • relevance ${relevance} • confidence ${confidence}${maturity}`,
            ),
        );
        for (const line of wrapText(b.content, contentWidth)) {
          console.log(`  ${line}`);
        }
        console.log("");
      }
    } else {
      console.log(chalk.bold("PLAYBOOK RULES (0)"));
      console.log(divider);
      console.log(chalk.gray("(No relevant playbook rules found)"));
      console.log(
        chalk.gray(
          `  ${formatTipPrefix()}Run '${cli} reflect' to start learning from your agent sessions.`,
        ),
      );
      console.log("");
    }

    // Pitfalls
    if (antiPatterns.length > 0) {
      console.log(
        chalk.yellow.bold(`${iconPrefix("warning")}PITFALLS TO AVOID (${antiPatterns.length})`),
      );
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

        console.log(
          headerStyle(`${i + 1}. ${agentLabel}${hostLabel}`) + pathStyle(` • ${h.source_path}`),
        );
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
      console.log(
        chalk.gray(
          `  ${formatTipPrefix()}Use Claude Code, Cursor, Codex, or PI to build session history.`,
        ),
      );
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
