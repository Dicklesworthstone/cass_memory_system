import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig, getSanitizeConfig } from "../config.js";
import { sanitize } from "../sanitize.js";
import { loadMergedPlaybook, getActiveBullets } from "../playbook.js";
import { safeCassSearchWithDegraded } from "../cass.js";
import {
  extractKeywords,
  scoreBulletRelevance,
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
import {
  ContextResult, ScoredBullet, Config, CassSearchHit, PlaybookBullet, ErrorCode,
  KnowledgeSearchHit, TopicExcerpt, RecentSession, RelatedTopic,
} from "../types.js";
import { cosineSimilarity, embedText, loadOrComputeEmbeddingsForBullets } from "../semantic.js";
import { loadTopics, loadKnowledgePage, parseKnowledgePage, listSubPages } from "../knowledge-page.js";
import { findUnprocessedSessionNotes, loadProcessingState, parseSessionNote } from "../session-notes.js";
import { listUserNotes, loadUserNote } from "../user-notes.js";
import chalk from "chalk";
import { agentIconPrefix, formatRule, formatTipPrefix, getOutputStyle, iconPrefix, wrapText } from "../output.js";
import { createProgress, type ProgressReporter } from "../progress.js";

const MAX_CASS_HISTORY_QUERY_TERMS = 8;
const CASS_HISTORY_TIMEOUT_SECONDS = 8;
const PATHOLOGICAL_CASS_QUERY_TOKEN = /^(?:bd|br)-[a-z0-9]+(?:[.-][a-z0-9]+)+$/i;

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
  searchHits: KnowledgeSearchHit[],
  warnings: string[],
  suggestedQueries: string[],
  limits: { maxBullets: number; maxHistory: number },
  phase4?: {
    topicExcerpts?: TopicExcerpt[];
    recentSessions?: RecentSession[];
    relatedTopics?: RelatedTopic[];
    suggestedDeepDives?: string[];
    lastReflectionRun?: string;
    knowledgePages?: KnowledgePageMatch[];
    knowledgePageSummaries?: KnowledgePageMatch[];
    userNotes?: { id: string; title: string; content: string }[];
    sessionSummaries?: { id: string; title: string; abstract: string; topics: string[]; date: string; processed: boolean }[];
  }
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

  // Truncate search result snippets
  const searchResults = searchHits.slice(0, maxHistory).map(h => ({
    ...h,
    snippet: truncateWithIndicator(h.snippet.trim().replace(/\n/g, " "), 300)
  }));

  const result: ContextResult = {
    task,
    relevantBullets,
    antiPatterns: transformedAntiPatterns,
    searchResults,
    deprecatedWarnings: warnings,
    suggestedCassQueries: suggestedQueries
  };

  // Phase 4 extensions
  if (phase4?.topicExcerpts?.length) result.topicExcerpts = phase4.topicExcerpts;
  if (phase4?.recentSessions?.length) result.recentSessions = phase4.recentSessions;
  if (phase4?.relatedTopics?.length) result.relatedTopics = phase4.relatedTopics;
  if (phase4?.suggestedDeepDives?.length) result.suggestedDeepDives = phase4.suggestedDeepDives;
  if (phase4?.lastReflectionRun) result.lastReflectionRun = phase4.lastReflectionRun;

  // Knowledge pages: full content for high-relevance, summaries for others
  if (phase4?.knowledgePages?.length) {
    (result as any).knowledgePageContent = phase4.knowledgePages.map(kp => ({
      topic: kp.topic, slug: kp.slug, subPage: kp.subPage, content: kp.content,
      relevance: kp.relevance,
    }));
  }
  if (phase4?.knowledgePageSummaries?.length) {
    (result as any).knowledgePageSummaries = phase4.knowledgePageSummaries.map(kp => ({
      topic: kp.topic, slug: kp.slug, subPage: kp.subPage,
      description: kp.description, wordCount: kp.wordCount,
      relevance: kp.relevance, path: kp.path,
    }));
  }
  if (phase4?.userNotes?.length) {
    (result as any).userNotes = phase4.userNotes;
  }
  if (phase4?.sessionSummaries?.length) {
    (result as any).sessionSummaries = phase4.sessionSummaries;
  }

  return result;
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

export function buildCassHistoryQuery(task: string, maxTerms = MAX_CASS_HISTORY_QUERY_TERMS): string {
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
}

export interface ContextComputation {
  result: ContextResult;
  rules: ScoredBullet[];
  antiPatterns: ScoredBullet[];
  cassHits: CassSearchHit[]; // Legacy — will be empty; use result.searchResults
  searchHits: KnowledgeSearchHit[];
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

// ============================================================================
// Phase 4: Knowledge Base Search + Context Retrieval
// ============================================================================

/**
 * Normalize FTS5 rank score to 0-1 (higher = better).
 * FTS5 rank is negative, lower = better match.
 */
function normalizeFtsRank(rank: number): number {
  return 1 / (1 + Math.abs(rank));
}

/**
 * Search the knowledge base via SQLite FTS, with optional semantic re-ranking.
 * Returns KnowledgeSearchHit[] with combined FTS + semantic scores.
 */
async function searchKnowledgeBase(
  query: string,
  config: Config,
  options: { limit?: number; semanticEnabled?: boolean } = {}
): Promise<{ hits: KnowledgeSearchHit[]; degraded?: ContextResult["degraded"] }> {
  const limit = options.limit ?? 10;
  const hits: KnowledgeSearchHit[] = [];
  let degraded: ContextResult["degraded"] | undefined;

  try {
    const { openSearchIndex } = await import("../search.js");
    const searchIndex = openSearchIndex(expandPath(config.searchDbPath));

    const rawResults = searchIndex.search(query, {
      tables: ["knowledge", "sessions", "notes", "digests"],
      limit: limit * 2, // over-fetch for re-ranking
    });

    // Normalize FTS scores
    const ftsNormalized = rawResults.map(r => ({
      ...r,
      ftsScore: normalizeFtsRank(r.rank),
    }));

    // Optional semantic re-ranking
    if (options.semanticEnabled !== false && config.semanticSearchEnabled) {
      try {
        const queryEmbedding = await embedText(query);
        for (const r of ftsNormalized) {
          try {
            const snippetEmbedding = await embedText(r.snippet.replace(/<\/?b>/g, "").slice(0, 300));
            const semanticScore = Math.max(0, cosineSimilarity(queryEmbedding, snippetEmbedding));
            // Combined: 0.6 FTS + 0.4 semantic (Gap 2)
            (r as any).combinedScore = 0.6 * r.ftsScore + 0.4 * semanticScore;
          } catch {
            (r as any).combinedScore = r.ftsScore;
          }
        }
      } catch {
        // Semantic unavailable — use FTS alone
        for (const r of ftsNormalized) {
          (r as any).combinedScore = r.ftsScore;
        }
      }
    } else {
      for (const r of ftsNormalized) {
        (r as any).combinedScore = r.ftsScore;
      }
    }

    // Sort by combined score, take top N
    ftsNormalized.sort((a, b) => ((b as any).combinedScore ?? 0) - ((a as any).combinedScore ?? 0));

    for (const r of ftsNormalized.slice(0, limit)) {
      hits.push({
        type: r.table === "sessions" ? "session_note" : r.table === "notes" ? "session_note" : r.table as any,
        id: r.id,
        snippet: r.snippet.replace(/<\/?b>/g, ""), // Strip FTS highlight tags
        score: (r as any).combinedScore ?? r.ftsScore,
        title: r.table === "knowledge" ? r.id : undefined,
      });
    }

    searchIndex.close();
  } catch (err) {
    // search.db missing or FTS table missing — graceful degradation
    degraded = {
      cass: {
        available: false,
        reason: "FTS_TABLE_MISSING",
        message: `Knowledge search unavailable: ${err instanceof Error ? err.message : String(err)}`,
        suggestedFix: ["cm reflect", "cm doctor"],
      },
    };
  }

  return { hits, degraded };
}

/**
 * Gather topic excerpts matching the task description.
 * Keyword + semantic match against topic names/descriptions, then load matching pages.
 */
interface KnowledgePageMatch {
  topic: string;
  slug: string;
  subPage: string;
  description: string;
  wordCount: number;
  relevance: number; // 0-1, higher = more relevant to query
  content?: string;  // only set for auto-included high-relevance pages
  path: string;      // for cm_detail
}

/**
 * Gather knowledge page summaries ranked by relevance.
 * Uses 3 signals: topic name/description keyword match, sub-page matching, FTS body match.
 * High-relevance pages (top matches) get full content auto-included.
 * Others get summaries so the agent can cm_detail as needed.
 */
async function gatherKnowledgePages(
  task: string,
  keywords: string[],
  config: Config
): Promise<KnowledgePageMatch[]> {
  const results: KnowledgePageMatch[] = [];
  try {
    const topics = await loadTopics(config);
    if (topics.length === 0) return results;

    const keywordLower = keywords.map(k => k.toLowerCase());

    // Score each topic by multiple signals
    for (const topic of topics) {
      const subPageText = (topic.subpages || []).map(sp =>
        `${sp.slug.replace(/-/g, " ")} ${sp.name} ${sp.description}`
      ).join(" ");
      const combinedText = `${topic.slug.replace(/-/g, " ")} ${topic.name} ${topic.description} ${subPageText}`.toLowerCase();
      const words = combinedText.split(/\s+/);

      // Signal 1: keyword match against topic metadata
      const keywordMatches = keywordLower.filter(k =>
        words.some(w => w === k || (k.length >= 4 && w.startsWith(k)))
      ).length;
      const keywordScore = keywordMatches / Math.max(keywordLower.length, 1);

      // Signal 2: semantic similarity (if available)
      let semanticScore = 0;
      try {
        const taskEmbedding = await embedText(task);
        const descEmbedding = await embedText(`${topic.name}: ${topic.description}`);
        semanticScore = Math.max(0, cosineSimilarity(taskEmbedding, descEmbedding));
      } catch { /* semantic unavailable */ }

      // Metadata relevance (before body check)
      const metadataRelevance = Math.max(keywordScore, semanticScore);

      // Load sub-pages for this topic — always check body content too
      const subPages = await listSubPages(topic.slug, config);
      const pagesToCheck = subPages.length > 0 ? subPages : ["_index"];

      for (const sp of pagesToCheck) {
        const page = await loadKnowledgePage(topic.slug, config, sp);
        if (!page) continue;
        const body = page.raw.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/)?.[1]?.trim();
        if (!body) continue;

        // Signal 3: keyword match against page body (word-boundary aware)
        const bodyWords = new Set(body.toLowerCase().split(/\W+/).filter(w => w.length > 2));
        const bodyMatches = keywordLower.filter(k => bodyWords.has(k)).length;
        const bodyScore = bodyMatches / Math.max(keywordLower.length, 1);
        const finalRelevance = Math.max(metadataRelevance, bodyScore * 0.8);

        // Skip pages with no relevance at all
        if (finalRelevance < 0.1) continue;

        const spDef = (topic.subpages || []).find(s => s.slug === sp);
        const wordCount = body.split(/\s+/).length;
        const pagePath = subPages.length > 0
          ? `knowledge/${topic.slug}/${sp}.md`
          : `knowledge/${topic.slug}.md`;

        results.push({
          topic: topic.name,
          slug: topic.slug,
          subPage: sp,
          description: spDef?.description || topic.description,
          wordCount,
          relevance: Math.round(finalRelevance * 100) / 100,
          path: pagePath,
          // Auto-include full content for high-relevance pages (top matches)
          content: finalRelevance >= 0.4 ? body : undefined,
        });
      }
    }
  } catch {
    // Empty knowledge base
  }

  // Sort by relevance descending
  results.sort((a, b) => b.relevance - a.relevance);
  return results;
}

/**
 * Find matching user notes — returns full note content for matches.
 */
async function findMatchingUserNotes(
  keywords: string[],
  config: Config
): Promise<{ id: string; title: string; content: string }[]> {
  const results: { id: string; title: string; content: string }[] = [];
  try {
    const notes = await listUserNotes(config);
    const keywordLower = keywords.map(k => k.toLowerCase());

    for (const noteMeta of notes) {
      const titleLower = noteMeta.title.toLowerCase();
      const topicsLower = noteMeta.topics.join(" ").toLowerCase();
      if (keywordLower.some(k => titleLower.includes(k) || topicsLower.includes(k))) {
        const full = await loadUserNote(noteMeta.id, config);
        if (full) {
          results.push({ id: noteMeta.id, title: full.frontmatter.title, content: full.body });
        }
      }
    }
  } catch { /* no user notes */ }
  return results;
}

/**
 * Get session note summaries (title, abstract, topics, date).
 * Used for both unprocessed and processed notes in the tiered system.
 */
async function getSessionNoteSummaries(
  config: Config,
  options?: { processedOnly?: boolean; unprocessedOnly?: boolean; limit?: number }
): Promise<{ id: string; title: string; abstract: string; topics: string[]; date: string; processed: boolean }[]> {
  const summaries: { id: string; title: string; abstract: string; topics: string[]; date: string; processed: boolean }[] = [];
  try {
    const notesDir = expandPath(config.sessionNotesDir);
    const files = await (await import("node:fs/promises")).readdir(notesDir);

    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      try {
        const raw = await (await import("node:fs/promises")).readFile(
          (await import("node:path")).join(notesDir, file), "utf-8"
        );
        const parsed = parseSessionNote(raw);
        const fm = parsed.frontmatter;

        if (options?.processedOnly && !fm.processed) continue;
        if (options?.unprocessedOnly && fm.processed) continue;

        summaries.push({
          id: fm.id,
          title: fm.title || "",
          abstract: fm.abstract || "",
          topics: fm.topics_touched || [],
          date: fm.last_updated || fm.created || "",
          processed: fm.processed,
        });
      } catch { /* skip */ }
    }

    summaries.sort((a, b) => b.date.localeCompare(a.date));
    if (options?.limit) return summaries.slice(0, options.limit);
  } catch { /* no notes dir */ }
  return summaries;
}

/**
 * Find related topics by semantic similarity to the task.
 */
async function findRelatedTopics(
  task: string,
  config: Config
): Promise<RelatedTopic[]> {
  const related: RelatedTopic[] = [];
  try {
    const topics = await loadTopics(config);
    if (topics.length === 0) return related;

    const taskEmbedding = await embedText(task);
    for (const topic of topics) {
      const descEmbedding = await embedText(`${topic.name}: ${topic.description}`);
      const sim = cosineSimilarity(taskEmbedding, descEmbedding);
      if (sim >= 0.3) {
        related.push({
          slug: topic.slug,
          name: topic.name,
          description: topic.description,
          similarity: Math.round(sim * 100) / 100,
        });
      }
    }

    related.sort((a, b) => b.similarity - a.similarity);
  } catch {
    // Semantic unavailable
  }
  return related.slice(0, 5);
}

/**
 * Get unprocessed session notes as full text for inclusion in context.
 */
async function getUnprocessedSessions(config: Config): Promise<RecentSession[]> {
  const sessions: RecentSession[] = [];
  try {
    const unprocessed = await findUnprocessedSessionNotes(config, 3);
    let totalTokens = 0;
    const TOKEN_CAP = 2000;

    for (const note of unprocessed) {
      const text = note.body.trim();
      const approxTokens = text.split(/\s+/).length;
      if (totalTokens + approxTokens > TOKEN_CAP && sessions.length > 0) break;

      sessions.push({
        id: note.frontmatter.id,
        date: note.frontmatter.created,
        abstract: note.frontmatter.abstract,
        note_text: text,
      });
      totalTokens += approxTokens;
    }
  } catch {
    // No session notes
  }
  return sessions;
}

/**
 * Generate suggested deep dives: pointers to knowledge page sections.
 */
function generateDeepDives(
  excerpts: TopicExcerpt[],
  searchHits: KnowledgeSearchHit[]
): string[] {
  const dives: string[] = [];
  const seen = new Set<string>();

  // From search hits
  for (const hit of searchHits.filter(h => h.type === "knowledge")) {
    const pointer = `knowledge/${hit.id}.md`;
    if (!seen.has(pointer)) {
      dives.push(pointer);
      seen.add(pointer);
    }
  }

  // From topic excerpts
  for (const excerpt of excerpts) {
    for (const section of excerpt.sections) {
      const slug = section.title.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
      const pointer = `knowledge/${excerpt.slug}.md#${slug}`;
      if (!seen.has(pointer)) {
        dives.push(pointer);
        seen.add(pointer);
      }
    }
  }

  return dives.slice(0, 10);
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
  const cassQuery = buildCassHistoryQuery(task);

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
  const minRelevance = config.minRelevanceScore;
  // scoredBullets is already sorted by finalScore with relevanceScore tie-breaker
  // Filter by relevanceScore against config.minRelevanceScore (not finalScore > 0)
  // so that the configured threshold is actually respected
  const topBullets = scoredBullets
    .filter(b => (b.relevanceScore ?? 0) >= minRelevance)
    .slice(0, maxBullets);

  const rules = topBullets.filter(b => !b.isNegative && b.kind !== "anti_pattern");
  const antiPatterns = topBullets.filter(b => b.isNegative || b.kind === "anti_pattern");

  // Phase 4: Search knowledge base (replaces cass binary search)
  options.onProgress?.({ phase: "cass_search", kind: "start", message: "Searching knowledge base..." });
  const searchQuery = keywords.join(" ");
  const { hits: searchHits, degraded: searchDegraded } = await searchKnowledgeBase(searchQuery, config, {
    limit: flags.history ?? config.maxHistoryInContext,
  });
  options.onProgress?.({ phase: "cass_search", kind: "done", message: "Knowledge search complete" });

  let degraded: ContextResult["degraded"] | undefined = searchDegraded;

  // Phase 4: Tiered context retrieval
  // Tier 1: Full knowledge pages + user notes + relevant session summaries
  const [knowledgePages, userNotes, allSessionSummaries, relatedTopics, processingState] = await Promise.all([
    gatherKnowledgePages(task, keywords, config),
    findMatchingUserNotes(keywords, config),
    getSessionNoteSummaries(config, { limit: 30 }),
    findRelatedTopics(task, config),
    loadProcessingState(config),
  ]);

  // Filter session summaries by relevance to the query
  // Exclude generic stop words that match everything
  const CONTEXT_STOP_WORDS = new Set([
    "implement", "create", "build", "make", "add", "fix", "update", "change",
    "new", "use", "using", "handle", "should", "want", "need", "like",
    "how", "what", "where", "when", "does", "work", "working",
    "the", "for", "with", "from", "that", "this", "into",
    "api", "app", "data", "code", "file", "user", "system",
  ]);
  const specificKeywords = keywords.map(k => k.toLowerCase()).filter(k => !CONTEXT_STOP_WORDS.has(k) && k.length > 2);
  const scoredSummaries = allSessionSummaries.map(s => {
    if (specificKeywords.length === 0) return { ...s, relevance: 0 };
    const searchable = `${s.title} ${s.abstract} ${s.topics.join(" ")}`.toLowerCase();
    const matchCount = specificKeywords.filter(k => searchable.includes(k)).length;
    return { ...s, relevance: matchCount / Math.max(specificKeywords.length, 1) };
  });

  // Tier 1: unprocessed summaries (always) + relevant processed summaries
  const unprocessedSummaries = scoredSummaries.filter(s => !s.processed);
  const relevantProcessed = scoredSummaries
    .filter(s => s.processed && s.relevance > 0)
    .sort((a, b) => b.relevance - a.relevance);

  // Tier 2 threshold calculated below after autoIncludedPages is defined
  let includeTier2 = false;
  // Tier 2 fallback: only include recent processed notes (not random ones with 0 relevance)
  const fallbackProcessed = includeTier2
    ? scoredSummaries.filter(s => s.processed && s.relevance === 0).slice(0, 3)
    : [];

  // Filter out completely irrelevant unprocessed summaries too (keep those with some match or very recent)
  const filteredUnprocessed = unprocessedSummaries.filter(s =>
    s.relevance > 0 || (Date.now() - new Date(s.date).getTime() < 7 * 86_400_000) // keep last 7 days regardless
  );

  // Separate auto-included (full content) from summary-only knowledge pages
  const autoIncludedPages = knowledgePages.filter(kp => kp.content);
  const summaryOnlyPages = knowledgePages.filter(kp => !kp.content);

  // Tier 2: if Tier 1 is thin on content, include fallback session summaries
  const tier1Tokens = autoIncludedPages.reduce((sum, p) => sum + (p.content?.length || 0) / 4, 0)
    + userNotes.reduce((sum, n) => sum + n.content.length / 4, 0);
  includeTier2 = tier1Tokens < 2000;

  // Build topic excerpts for backward compat
  const topicExcerpts: TopicExcerpt[] = [];
  const seenTopics = new Set<string>();
  for (const kp of knowledgePages) {
    if (seenTopics.has(kp.slug)) continue;
    seenTopics.add(kp.slug);
    topicExcerpts.push({
      topic: kp.topic,
      slug: kp.slug,
      sections: [{ title: kp.subPage === "_index" ? "Overview" : kp.subPage, preview: kp.description.slice(0, 200) }],
    });
  }

  // Build recent sessions from unprocessed summaries (backward compat for old output format)
  const recentSessions: RecentSession[] = filteredUnprocessed.slice(0, 3).map(s => ({
    id: s.id,
    date: s.date,
    abstract: s.abstract,
    note_text: `**${s.title || s.abstract.slice(0, 50)}**\nTopics: ${s.topics.join(", ") || "none"}`,
  }));

  const suggestedDeepDives = generateDeepDives(topicExcerpts, searchHits);
  const lastReflectionRun = processingState.lastReflectionRun;

  const warnings: string[] = [];

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
  const suggestedQueries = generateSuggestedQueries(task, keywords, {
    maxSuggestions: 5
  });

  const result = buildContextResult(
    task,
    rules,
    antiPatterns,
    searchHits,
    warnings,
    suggestedQueries,
    {
      maxBullets: flags.limit ?? flags.top ?? config.maxBulletsInContext,
      maxHistory: flags.history ?? config.maxHistoryInContext,
    },
    {
      topicExcerpts,
      relatedTopics,
      recentSessions,
      suggestedDeepDives,
      lastReflectionRun,
      knowledgePages: autoIncludedPages,
      knowledgePageSummaries: summaryOnlyPages,
      userNotes,
      sessionSummaries: [
        ...filteredUnprocessed,
        ...relevantProcessed,
        ...fallbackProcessed,
      ],
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

  return { result, rules, antiPatterns, cassHits: [] as CassSearchHit[], searchHits, warnings, suggestedQueries };
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
      : expandPath("~/.memory-system/context-log.jsonl");

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
      .filter(b => (b.relevanceScore ?? 0) >= config.minRelevanceScore)
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
      searchResults: [],
      deprecatedWarnings: warnings,
      suggestedCassQueries: []
    };
  } catch (err) {
    warn(`Playbook also unavailable: ${err}`);
    return {
      task,
      relevantBullets: [],
      antiPatterns: [],
      searchResults: [],
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
  const computation = await generateContextResult(task, flags);
  return computation;
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
    const { result, rules, antiPatterns, searchHits, warnings, suggestedQueries } = await generateContextResult(normalizedTask, normalizedFlags, {
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
        const confidence = Number.isFinite(b.effectiveScore) ? b.effectiveScore.toFixed(1) : "n/a";
        console.log(`- **${b.id}** (${b.category}/${b.kind}, relevance ${relevance}, confidence ${confidence}): ${b.content.trim()}`);
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

    console.log(`## Search Results (${searchHits.length})\n`);
    if (searchHits.length === 0) {
      console.log(`(No relevant results found)\n`);
    } else {
      const shown = Math.min(searchHits.length, 5);
      for (const h of searchHits.slice(0, shown)) {
        const snippet = truncateWithIndicator(h.snippet.trim().replace(/\s+/g, " "), snippetWidth);
        console.log(`- **[${h.type}]** ${h.id}: "${snippet}" (score: ${h.score.toFixed(2)})`);
      }
      if (searchHits.length > shown) {
        console.log(`- … and ${searchHits.length - shown} more`);
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
    console.log(chalk.yellow(`${iconPrefix("warning")}Knowledge search unavailable (${cass.reason}).`));
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
      console.log(chalk.bold(`[${b.id}]`) + chalk.dim(` ${b.category}/${b.kind} • relevance ${relevance} • confidence ${confidence}${maturity}`));
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

  // Knowledge search results
  if (searchHits.length > 0) {
    const total = searchHits.length;
    const shown = Math.min(total, 5);
    const showing = total > shown ? ` (showing ${shown} of ${total})` : "";
    console.log(chalk.bold(`KNOWLEDGE${showing}`));
    console.log(divider);

    const snippetWidth = Math.max(24, maxWidth - 4);
    searchHits.slice(0, shown).forEach((h, i) => {
      const typeLabel = chalk.dim(`[${h.type}]`);
      const scoreLabel = chalk.dim(`score ${h.score.toFixed(2)}`);
      console.log(chalk.bold(`${i + 1}. ${h.id}`) + ` ${typeLabel} ${scoreLabel}`);
      const snippet = h.snippet.trim().replace(/\s+/g, " ");
      for (const line of wrapText(`"${snippet}"`, snippetWidth)) {
        console.log(chalk.gray(`  ${line}`));
      }
      console.log("");
    });
  } else if (!result.degraded?.cass || result.degraded.cass.available) {
    console.log(chalk.bold("KNOWLEDGE (0)"));
    console.log(divider);
    console.log(chalk.gray("(No knowledge base results found)"));
    console.log(chalk.gray(`  ${formatTipPrefix()}Run '${cli} reflect' to build knowledge from sessions.`));
    console.log("");
  }

  // Topic excerpts
  if (result.topicExcerpts && result.topicExcerpts.length > 0) {
    console.log(chalk.bold(`RELATED TOPICS (${result.topicExcerpts.length})`));
    console.log(divider);
    for (const excerpt of result.topicExcerpts) {
      console.log(chalk.bold(`  ${excerpt.topic}`) + chalk.dim(` (${excerpt.slug})`));
      for (const section of excerpt.sections.slice(0, 3)) {
        console.log(chalk.gray(`    - ${section.title}: ${section.preview.slice(0, 60)}...`));
      }
      console.log("");
    }
  }

  // Unprocessed session notes
  if (result.recentSessions && result.recentSessions.length > 0) {
    console.log(chalk.bold(`UNPROCESSED SESSIONS (${result.recentSessions.length})`));
    console.log(divider);
    for (const s of result.recentSessions) {
      console.log(chalk.bold(`  ${s.id}`) + chalk.dim(` (${s.date})`));
      console.log(chalk.gray(`    ${s.abstract}`));
      console.log("");
    }
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
