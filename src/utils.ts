import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import chalk from "chalk";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { ContextResult } from "./types.js";

const execAsync = promisify(exec);

// --- Path Utilities ---

export function expandPath(p: string): string {
  if (!p) return "";
  if (p.startsWith("~")) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

export async function ensureDir(dir: string): Promise<void> {
  const expanded = expandPath(dir);
  try {
    await fs.access(expanded);
  } catch {
    await fs.mkdir(expanded, { recursive: true });
  }
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(expandPath(filePath));
    return true;
  } catch {
    return false;
  }
}

export async function checkDiskSpace(dirPath: string): Promise<{ ok: boolean; free: string }> {
  try {
    const expanded = expandPath(dirPath);
    await ensureDir(expanded);
    const { stdout } = await execAsync(`df -h "${expanded}" | tail -1 | awk '{print $4}'`);
    return { ok: true, free: stdout.trim() };
  } catch {
    return { ok: true, free: "unknown" }; 
  }
}

// --- File Locking ---

export async function withLock<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const { withLock: lock } = await import("./lock.js");
  return lock(filePath, operation);
}

export async function atomicWrite(filePath: string, content: string): Promise<void> {
  const expanded = expandPath(filePath);
  await ensureDir(path.dirname(expanded));
  
  const tempPath = `${expanded}.tmp.${crypto.randomBytes(4).toString("hex")}`;
  
  try {
    await fs.writeFile(tempPath, content, "utf-8");
    await fs.rename(tempPath, expanded);
  } catch (err: any) {
    try { await fs.unlink(tempPath); } catch {} 
    throw new Error(`Failed to atomic write to ${expanded}: ${err.message}`);
  }
}

// --- Content & Hashing ---

export function hashContent(content: string): string {
  if (!content) return crypto.createHash("sha256").update("").digest("hex").substring(0, 16);
  
  const normalized = content
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
    
  return crypto.createHash("sha256").update(normalized).digest("hex").substring(0, 16);
}

export function tokenize(text: string): string[] {
  if (!text) return [];
  
  // Improved regex: Keeps technical terms like C++, node.js, user_id
  // Matches:
  // - Sequences of alphanumeric chars including dots, underscores, hyphens, pluses
  // - But avoids trailing dots
  
  // This is a heuristic for code-heavy text
  const tokens = text.toLowerCase().match(/[a-z0-9]+(?:[._\-+]+[a-z0-9]+)*|[a-z0-9]+/g);
  
  return (tokens || [])
    .filter(t => t.length >= 2); // Min length 2
}

export function jaccardSimilarity(a: string, b: string): number {
  const tokensA = new Set(tokenize(a));
  const tokensB = new Set(tokenize(b));
  
  if (tokensA.size === 0 && tokensB.size === 0) return 1.0;
  if (tokensA.size === 0 || tokensB.size === 0) return 0.0;
  
  const intersection = new Set([...tokensA].filter(x => tokensB.has(x)));
  const union = new Set([...tokensA, ...tokensB]);
  
  return intersection.size / union.size;
}

// --- ID Generation ---

export function generateBulletId(): string {
  const timestamp36 = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `b-${timestamp36}-${random}`;
}

export function generateDiaryId(sessionPath: string): string {
  const hash = hashContent(sessionPath + Date.now());
  return `diary-${hash}`;
}

// --- Date/Time ---

export function now(): string {
  return new Date().toISOString();
}

export function daysAgo(days: number): Date {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date;
}

export function formatRelativeTime(isoDate: string): string {
  const date = new Date(isoDate);
  const diff = Date.now() - date.getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.round(days / 7)} weeks ago`;
  if (days < 365) return `${Math.round(days / 30)} months ago`;
  return `${Math.round(days / 365)} years ago`;
}

// --- Text & NLP ---

const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "have", "has", "had",
  "do", "does", "did", "will", "would", "could", "should", "can", "to", "of", "in",
  "for", "on", "with", "at", "by", "from", "as", "into", "through", "during", "before",
  "after", "and", "or", "but", "if", "when", "where", "why", "how", "this", "that",
  "these", "those", "what", "which", "who", "there", "here", "i", "you", "he", "she",
  "it", "we", "they", "me", "him", "her", "us", "them"
]);

export function extractKeywords(text: string): string[] {
  const tokens = tokenize(text);
  const keywords = tokens.filter(t => !STOP_WORDS.has(t));
  
  const counts: Record<string, number> = {};
  keywords.forEach(k => counts[k] = (counts[k] || 0) + 1);
  
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([k]) => k);
}

export function truncate(text: string, maxLen: number): string {
  if (!text) return "";
  if (text.length <= maxLen) return text;
  if (maxLen < 3) return text.slice(0, maxLen);
  return text.slice(0, maxLen - 3) + "...";
}

// --- Deprecated pattern detection ---

function buildDeprecatedMatcher(pattern: string): (text: string) => boolean {
  if (!pattern) return () => false;

  if (pattern.startsWith("/") && pattern.endsWith("/") && pattern.length > 2) {
    const body = pattern.slice(1, -1);
    const regex = new RegExp(body);
    return (text: string) => regex.test(text);
  }

  return (text: string) => text.includes(pattern);
}

export function checkDeprecatedPatterns(
  history: Array<{ snippet?: string }> = [],
  deprecatedPatterns: Array<{ pattern: string; replacement?: string; reason?: string }> = []
): string[] {
  if (!history.length || !deprecatedPatterns.length) return [];

  const warnings = new Set<string>();

  for (const deprecated of deprecatedPatterns) {
    if (!deprecated?.pattern) continue;

    const matches = buildDeprecatedMatcher(deprecated.pattern);

    for (const hit of history) {
      const snippet = hit?.snippet;
      if (!snippet) continue;

      if (matches(snippet)) {
        const reasonSuffix = deprecated.reason ? ` (Reason: ${deprecated.reason})` : "";
        const replacement = deprecated.replacement ? ` - use ${deprecated.replacement} instead` : "";
        warnings.add(`${deprecated.pattern} was deprecated${replacement}${reasonSuffix}`);
        break;
      }
    }
  }

  return Array.from(warnings);
}

// --- Scoring ---

export function scoreBulletRelevance(
  bulletContent: string,
  bulletTags: string[],
  keywords: string[]
): number {
  if (!bulletContent || keywords.length === 0) return 0;
  
  let score = 0;
  const contentLower = bulletContent.toLowerCase();
  const tagsLower = bulletTags.map(t => t.toLowerCase());
  
  // Tokenize once
  const contentTokens = new Set(tokenize(contentLower));

  for (const keyword of keywords) {
    const k = keyword.toLowerCase();
    
    // Exact match in token set (fast)
    if (contentTokens.has(k)) {
        score += 3;
    } 
    // Partial string match (slower fallback for "auth" -> "authenticate")
    else if (contentLower.includes(k)) {
        score += 1;
    }
    
    if (tagsLower.includes(k)) {
        score += 5; // Higher weight for explicit tags
    }
  }
  
  return score;
}

export function extractAgentFromPath(sessionPath: string): string {
  const lower = sessionPath.toLowerCase();
  if (lower.includes(".claude")) return "claude";
  if (lower.includes(".cursor")) return "cursor";
  if (lower.includes(".codex")) return "codex";
  if (lower.includes(".aider")) return "aider";
  return "unknown";
}

/**
 * Format the last helpful feedback timestamp for a bullet as human-readable relative time.
 * Used in context output to help users understand recency of validation.
 *
 * @param bullet - PlaybookBullet or object with helpfulEvents/feedbackEvents array
 * @returns Human-readable string like "2 days ago", "3 weeks ago", or "Never"
 *
 * @example
 * formatLastHelpful({ helpfulEvents: [{ timestamp: '2025-12-05T10:00:00Z' }] })
 * // Returns: "2 days ago" (if today is 2025-12-07)
 *
 * formatLastHelpful({ feedbackEvents: [{ type: 'helpful', timestamp: '2025-12-07T14:00:00Z' }] })
 * // Returns: "45 minutes ago"
 *
 * formatLastHelpful({})
 * // Returns: "Never"
 */
export function formatLastHelpful(bullet: {
  helpfulEvents?: Array<{ timestamp: string }>;
  feedbackEvents?: Array<{ type: string; timestamp: string }>;
}): string {
  // Find helpful events from either helpfulEvents or feedbackEvents
  let helpfulTimestamps: string[] = [];

  if (bullet.helpfulEvents && bullet.helpfulEvents.length > 0) {
    helpfulTimestamps = bullet.helpfulEvents.map(e => e.timestamp);
  } else if (bullet.feedbackEvents && bullet.feedbackEvents.length > 0) {
    helpfulTimestamps = bullet.feedbackEvents
      .filter(e => e.type === "helpful")
      .map(e => e.timestamp);
  }

  if (helpfulTimestamps.length === 0) {
    return "Never";
  }

  // Find most recent helpful event
  const sortedTimestamps = helpfulTimestamps
    .map(ts => new Date(ts).getTime())
    .filter(ts => !isNaN(ts))
    .sort((a, b) => b - a); // Descending (most recent first)

  if (sortedTimestamps.length === 0) {
    return "Never";
  }

  const mostRecent = sortedTimestamps[0];
  const diff = Date.now() - mostRecent;

  // Convert to appropriate units
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const weeks = Math.floor(days / 7);
  const months = Math.floor(days / 30);
  const years = Math.floor(days / 365);

  // Format based on magnitude (always round down per spec)
  if (seconds < 60) {
    return "just now";
  }
  if (minutes < 60) {
    return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
  }
  if (hours < 24) {
    return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  }
  if (days < 7) {
    return days === 1 ? "1 day ago" : `${days} days ago`;
  }
  if (weeks < 4) {
    return weeks === 1 ? "1 week ago" : `${weeks} weeks ago`;
  }
  if (months < 12) {
    return months === 1 ? "1 month ago" : `${months} months ago`;
  }
  return years === 1 ? "1 year ago" : `${years} years ago`;
}

// --- Search Suggestions ---

/**
 * Problem-oriented terms to include in search suggestions.
 * These help surface debugging and troubleshooting context.
 */
const PROBLEM_TERMS = ["error", "fix", "bug", "issue", "problem", "fail", "debug"];

/**
 * Generate human-readable cass search suggestions for follow-up investigation.
 *
 * Creates 3-5 ready-to-run cass commands that the user can execute to dig deeper
 * if the provided context isn't sufficient.
 *
 * @param task - The original task description
 * @param keywords - Extracted keywords from the task
 * @param options - Optional configuration
 * @param options.preferredAgent - Agent to filter by (e.g., "claude")
 * @param options.maxSuggestions - Maximum number of suggestions (default: 5)
 * @returns Array of formatted cass command strings
 *
 * @example
 * generateSuggestedQueries("Fix authentication timeout bug", ["authentication", "timeout", "token"])
 * // Returns:
 * // [
 * //   'cass search "authentication timeout" --days 30',
 * //   'cass search "token error" --days 60',
 * //   'cass search "authentication" --days 90',
 * //   ...
 * // ]
 */
export function generateSuggestedQueries(
  task: string,
  keywords: string[],
  options: { preferredAgent?: string; maxSuggestions?: number } = {}
): string[] {
  const { preferredAgent, maxSuggestions = 5 } = options;
  const queries: string[] = [];
  const seenQueries = new Set<string>();

  // Helper to add query if not duplicate
  const addQuery = (query: string, days: number, agent?: string): void => {
    if (queries.length >= maxSuggestions) return;

    // Escape quotes in query
    const escapedQuery = query.replace(/"/g, '\\"');
    const key = `${escapedQuery}-${days}-${agent || ""}`;

    if (!seenQueries.has(key)) {
      seenQueries.add(key);
      let cmd = `cass search "${escapedQuery}" --days ${days}`;
      if (agent) cmd += ` --agent ${agent}`;
      queries.push(cmd);
    }
  };

  // 1. Multi-keyword phrase query (first 2-3 keywords combined)
  if (keywords.length >= 2) {
    const phrase = keywords.slice(0, 3).join(" ");
    addQuery(phrase, 30);
  }

  // 2. Single keyword with problem term (find error/fix patterns)
  if (keywords.length > 0) {
    const topKeyword = keywords[0];

    // Check if task already contains problem terms
    const taskLower = task.toLowerCase();
    const hasProblemTerm = PROBLEM_TERMS.some(term => taskLower.includes(term));

    if (!hasProblemTerm) {
      // Add error-oriented query if task doesn't have problem terms
      addQuery(`${topKeyword} error`, 60);
    } else {
      // Task already has problem context, search for solutions
      addQuery(`${topKeyword} fix`, 60);
    }
  }

  // 3. Broad single keyword query with longer lookback
  if (keywords.length > 0) {
    addQuery(keywords[0], 90);
  }

  // 4. Second keyword with agent filter if available
  if (keywords.length > 1 && preferredAgent) {
    addQuery(keywords[1], 60, preferredAgent);
  }

  // 5. Keyword combination with medium lookback
  if (keywords.length >= 2) {
    const twoKeywords = keywords.slice(0, 2).join(" ");
    addQuery(twoKeywords, 60);
  }

  // 6. Third keyword or pattern with longer lookback if space
  if (keywords.length >= 3 && queries.length < maxSuggestions) {
    addQuery(keywords[2], 90);
  }

  return queries;
}

// --- Logging ---

export function log(msg: string, verbose = false): void {
  if (verbose || process.env.CASS_MEMORY_VERBOSE === "true" || process.env.CASS_MEMORY_VERBOSE === "1") {
    console.error(chalk.blue("[cass-memory]"), msg);
  }
}

export function error(msg: string): void {
  console.error(chalk.red("[cass-memory] ERROR:"), msg);
}

export function warn(msg: string): void {
  console.error(chalk.yellow("[cass-memory] WARNING:"), msg);
}

// --- Context Formatting ---

/**
 * Format a ContextResult as human-readable markdown.
 * Produces portable markdown without ANSI colors for file output, pipes, etc.
 *
 * @param result - The structured ContextResult to format
 * @returns Formatted markdown string ready for display or file output
 *
 * @example
 * const md = formatContextMarkdown(result);
 * console.log(md); // or write to file
 */
export function formatContextMarkdown(result: ContextResult): string {
  const lines: string[] = [];

  // Header
  lines.push("═══════════════════════════════════════════════════════════════");
  lines.push(`CONTEXT FOR: ${result.task}`);
  lines.push("═══════════════════════════════════════════════════════════════");
  lines.push("");

  // Relevant Playbook Rules
  if (result.relevantBullets.length > 0) {
    lines.push(`## RELEVANT PLAYBOOK RULES (${result.relevantBullets.length})`);
    lines.push("");
    for (const bullet of result.relevantBullets) {
      const score = bullet.effectiveScore?.toFixed(1) ?? "N/A";
      lines.push(`**[${bullet.id}]** ${bullet.category}/${bullet.kind} (score: ${score})`);
      lines.push(`  ${truncateSnippet(bullet.content, 300)}`);
      lines.push("");
    }
  } else {
    lines.push("_(No relevant playbook rules found)_");
    lines.push("");
  }

  // Pitfalls to Avoid (Anti-patterns)
  if (result.antiPatterns.length > 0) {
    lines.push(`## ⚠️ PITFALLS TO AVOID (${result.antiPatterns.length})`);
    lines.push("");
    for (const bullet of result.antiPatterns) {
      lines.push(`**[${bullet.id}]** ${truncateSnippet(bullet.content, 200)}`);
    }
    lines.push("");
  }

  // Historical Context
  if (result.historySnippets.length > 0) {
    lines.push(`## HISTORICAL CONTEXT (${result.historySnippets.length} sessions)`);
    lines.push("");
    // Show up to 5 history items
    const displayed = result.historySnippets.slice(0, 5);
    displayed.forEach((hit, idx) => {
      const agent = hit.agent || "unknown";
      const relTime = hit.timestamp ? formatRelativeTime(hit.timestamp) : "";
      lines.push(`${idx + 1}. ${hit.source_path}:${hit.line_number} (${agent}${relTime ? ", " + relTime : ""})`);
      const snippet = truncateSnippet(hit.snippet.replace(/\n/g, " ").trim(), 150);
      lines.push(`   > ${snippet}`);
      lines.push("");
    });
  }

  // Deprecated Warnings
  if (result.deprecatedWarnings.length > 0) {
    lines.push("## ⚠️ WARNINGS");
    lines.push("");
    for (const warning of result.deprecatedWarnings) {
      lines.push(`  • ${warning}`);
    }
    lines.push("");
  }

  // Suggested Searches
  if (result.suggestedCassQueries.length > 0) {
    lines.push("## DIG DEEPER");
    lines.push("");
    for (const query of result.suggestedCassQueries) {
      lines.push(`  ${query}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Truncate snippet text with ellipsis, preserving word boundaries when possible.
 */
function truncateSnippet(text: string, maxLen: number): string {
  if (!text) return "";
  if (text.length <= maxLen) return text;

  // Try to break at word boundary
  const truncated = text.slice(0, maxLen);
  const lastSpace = truncated.lastIndexOf(" ");

  if (lastSpace > maxLen * 0.7) {
    return truncated.slice(0, lastSpace) + "...";
  }

  return truncated.slice(0, maxLen - 3) + "...";
}

/**
 * Extended PlaybookBullet type that may include derivedFrom field.
 * Used for extracting reasoning from rule provenance data.
 */
interface BulletWithProvenance {
  reasoning?: string;
  derivedFrom?: {
    sessionPath?: string;
    timestamp?: string;
    keyEvidence?: string[];
    extractedBy?: string;
  };
  sourceSessions?: string[];
  sourceAgents?: string[];
  createdAt?: string;
}

/**
 * Extract reasoning/origin story for why a playbook bullet exists.
 * Provides context about HOW and WHY a rule was created, helping agents
 * understand the origin story and give more weight to the guidance.
 *
 * Priority order:
 * 1. bullet.reasoning (if explicitly set)
 * 2. bullet.derivedFrom.keyEvidence (if derived from session)
 * 3. Fallback: "From {agent} session on {date}" using session metadata
 * 4. Final fallback: "No reasoning available"
 *
 * @param bullet - PlaybookBullet with optional provenance fields
 * @returns Human-readable reasoning string (max 200 chars, truncated with ellipsis)
 *
 * @example
 * // With explicit reasoning
 * extractBulletReasoning({ reasoning: 'JWT expiry caused auth failures' })
 * // Returns: "JWT expiry caused auth failures"
 *
 * // With key evidence
 * extractBulletReasoning({ derivedFrom: { keyEvidence: ['Token refresh was too slow'] } })
 * // Returns: "Token refresh was too slow"
 *
 * // Fallback to session metadata
 * extractBulletReasoning({ sourceAgents: ['claude'], createdAt: '2025-11-15T10:00:00Z' })
 * // Returns: "From claude session on 11/15/2025"
 */
export function extractBulletReasoning(bullet: BulletWithProvenance): string {
  const MAX_LENGTH = 200;

  // 1. Check explicit reasoning field first
  if (bullet.reasoning && bullet.reasoning.trim()) {
    return truncateReasoning(bullet.reasoning.trim(), MAX_LENGTH);
  }

  // 2. Check derivedFrom.keyEvidence
  if (bullet.derivedFrom?.keyEvidence && bullet.derivedFrom.keyEvidence.length > 0) {
    // Join evidence items, take first that fits
    const evidence = bullet.derivedFrom.keyEvidence
      .filter(e => e && e.trim())
      .map(e => e.trim());

    if (evidence.length > 0) {
      // If multiple pieces of evidence, join with semicolon
      const combined = evidence.join("; ");
      return truncateReasoning(combined, MAX_LENGTH);
    }
  }

  // 3. Fallback to session metadata
  const agent = bullet.sourceAgents?.[0] || bullet.derivedFrom?.extractedBy;
  const timestamp = bullet.derivedFrom?.timestamp || bullet.createdAt;

  if (agent || timestamp) {
    const agentStr = agent || "unknown";
    const dateStr = timestamp ? formatDateShort(timestamp) : "unknown date";
    return `From ${agentStr} session on ${dateStr}`;
  }

  // 4. Final fallback
  return "No reasoning available";
}

/**
 * Truncate reasoning text, preserving first sentence if possible.
 */
function truncateReasoning(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;

  // Try to preserve first sentence
  const sentenceEnd = text.search(/[.!?]/);
  if (sentenceEnd > 0 && sentenceEnd < maxLen - 3) {
    return text.slice(0, sentenceEnd + 1);
  }

  // Fall back to word boundary truncation
  const truncated = text.slice(0, maxLen);
  const lastSpace = truncated.lastIndexOf(" ");

  if (lastSpace > maxLen * 0.7) {
    return truncated.slice(0, lastSpace) + "...";
  }

  return truncated.slice(0, maxLen - 3) + "...";
}

/**
 * Format a timestamp as a short date string for display.
 */
function formatDateShort(isoDate: string): string {
  try {
    const date = new Date(isoDate);
    if (isNaN(date.getTime())) return "unknown date";

    // Format as M/D/YYYY
    const month = date.getMonth() + 1;
    const day = date.getDate();
    const year = date.getFullYear();
    return `${month}/${day}/${year}`;
  } catch {
    return "unknown date";
  }
}
