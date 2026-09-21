/**
 * Gap Analysis for Playbook Categories
 *
 * Analyzes the playbook to identify underrepresented categories
 * and provides guidance for targeted rule extraction.
 */

import { getActiveBullets } from "./playbook.js";
import { type Playbook, PlaybookBullet } from "./types.js";

/**
 * Standard categories for playbook rules
 */
export const RULE_CATEGORIES = [
  "debugging",
  "testing",
  "architecture",
  "workflow",
  "documentation",
  "integration",
  "collaboration",
  "git",
  "security",
  "performance",
] as const;

export type RuleCategory = (typeof RULE_CATEGORIES)[number];

/**
 * Keywords associated with each category for detection
 */
export const CATEGORY_KEYWORDS: Record<RuleCategory, string[]> = {
  debugging: [
    "debug",
    "error",
    "fix",
    "bug",
    "issue",
    "trace",
    "stack",
    "breakpoint",
    "log",
    "exception",
    "crash",
    "fault",
    "problem",
  ],
  testing: [
    "test",
    "spec",
    "mock",
    "assert",
    "expect",
    "jest",
    "vitest",
    "unit",
    "integration",
    "e2e",
    "coverage",
    "fixture",
    "stub",
  ],
  architecture: [
    "architecture",
    "design",
    "pattern",
    "structure",
    "module",
    "component",
    "layer",
    "service",
    "interface",
    "abstraction",
    "dependency",
    "coupling",
    "cohesion",
    "separation",
  ],
  workflow: [
    "workflow",
    "process",
    "task",
    "priority",
    "order",
    "step",
    "sequence",
    "pipeline",
    "automation",
    "ci",
    "cd",
    "deploy",
  ],
  documentation: [
    "document",
    "doc",
    "readme",
    "comment",
    "jsdoc",
    "typedoc",
    "api",
    "reference",
    "guide",
    "tutorial",
    "example",
  ],
  integration: [
    "api",
    "http",
    "rest",
    "graphql",
    "fetch",
    "request",
    "response",
    "json",
    "parse",
    "serialize",
    "endpoint",
    "client",
    "server",
  ],
  collaboration: [
    "team",
    "review",
    "pr",
    "merge",
    "conflict",
    "coordinate",
    "communicate",
    "share",
    "handoff",
    "pair",
    "mob",
  ],
  git: [
    "git",
    "commit",
    "branch",
    "merge",
    "rebase",
    "push",
    "pull",
    "checkout",
    "stash",
    "diff",
    "log",
    "blame",
    "bisect",
  ],
  security: [
    "security",
    "auth",
    "token",
    "password",
    "encrypt",
    "permission",
    "access",
    "secret",
    "vulnerability",
    "sanitize",
    "validate",
    "xss",
    "csrf",
    "injection",
    "owasp",
  ],
  performance: [
    "performance",
    "optimize",
    "cache",
    "slow",
    "memory",
    "profile",
    "benchmark",
    "latency",
    "throughput",
    "scale",
    "efficient",
  ],
};

/**
 * Category status based on rule count
 */
export type CategoryStatus = "critical" | "underrepresented" | "adequate" | "well-covered";

/**
 * Thresholds for category status
 */
const STATUS_THRESHOLDS = {
  critical: 0, // 0 rules
  underrepresented: 3, // 1-2 rules
  adequate: 10, // 3-10 rules
  // well-covered: > 10 rules
};

export interface CategoryAnalysis {
  count: number;
  status: CategoryStatus;
  percentage: number;
}

export interface PlaybookGapAnalysis {
  totalRules: number;
  byCategory: Record<string, CategoryAnalysis>;
  gaps: {
    critical: string[];
    underrepresented: string[];
  };
  wellCovered: string[];
  suggestions: string;
}

/**
 * Get the status for a category based on rule count
 */
function getCategoryStatus(count: number): CategoryStatus {
  if (count === STATUS_THRESHOLDS.critical) return "critical";
  if (count < STATUS_THRESHOLDS.underrepresented) return "underrepresented";
  if (count <= STATUS_THRESHOLDS.adequate) return "adequate";
  return "well-covered";
}

/**
 * Analyze playbook category distribution and identify gaps
 */
export function analyzePlaybookGaps(playbook: Playbook): PlaybookGapAnalysis {
  // Filter to active bullets only (consistent with getActiveBullets)
  const activeBullets = getActiveBullets(playbook);

  const totalRules = activeBullets.length;

  // Count rules per category
  const categoryCounts: Record<string, number> = {};

  // Initialize all known categories with 0
  for (const cat of RULE_CATEGORIES) {
    categoryCounts[cat] = 0;
  }

  // Count bullets by category
  for (const bullet of activeBullets) {
    const cat = bullet.category || "general";
    categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
  }

  // Build category analysis
  const byCategory: Record<string, CategoryAnalysis> = {};
  const gaps: { critical: string[]; underrepresented: string[] } = {
    critical: [],
    underrepresented: [],
  };
  const wellCovered: string[] = [];

  for (const cat of RULE_CATEGORIES) {
    const count = categoryCounts[cat] || 0;
    const status = getCategoryStatus(count);
    const percentage = totalRules > 0 ? (count / totalRules) * 100 : 0;

    byCategory[cat] = { count, status, percentage };

    if (status === "critical") {
      gaps.critical.push(cat);
    } else if (status === "underrepresented") {
      gaps.underrepresented.push(cat);
    } else if (status === "well-covered") {
      wellCovered.push(cat);
    }
  }

  // Generate suggestions
  const suggestions = generateSuggestions(gaps, totalRules);

  return {
    totalRules,
    byCategory,
    gaps,
    wellCovered,
    suggestions,
  };
}

/**
 * Generate human-readable suggestions based on gaps
 */
function generateSuggestions(
  gaps: { critical: string[]; underrepresented: string[] },
  totalRules: number,
): string {
  if (totalRules === 0) {
    return "Your playbook is empty! Start by adding foundational rules across all categories.";
  }

  if (gaps.critical.length === 0 && gaps.underrepresented.length === 0) {
    return "Your playbook has good coverage across all categories.";
  }

  const parts: string[] = [];

  if (gaps.critical.length > 0) {
    parts.push(`Focus on ${gaps.critical.join(", ")} - you have no rules in these areas.`);
  }

  if (gaps.underrepresented.length > 0) {
    parts.push(`Consider adding more ${gaps.underrepresented.join(", ")} rules.`);
  }

  return parts.join(" ");
}

/**
 * Detect likely categories from text content using keyword matching
 */
export function detectCategories(text: string): RuleCategory[] {
  const lowerText = text.toLowerCase();
  const matches: Array<{ category: RuleCategory; score: number }> = [];

  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    let score = 0;
    for (const keyword of keywords) {
      if (lowerText.includes(keyword)) {
        score++;
      }
    }
    if (score > 0) {
      matches.push({ category: category as RuleCategory, score });
    }
  }

  // Sort by score descending and return top categories
  return matches
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((m) => m.category);
}

/**
 * Get search queries optimized for finding sessions in gap categories
 */
export function getGapSearchQueries(gaps: PlaybookGapAnalysis): string[] {
  const queries: string[] = [];

  // Prioritize critical gaps
  for (const cat of gaps.gaps.critical) {
    const keywords = CATEGORY_KEYWORDS[cat as RuleCategory];
    if (keywords && keywords.length > 0) {
      // Use first 3 keywords for each critical category
      queries.push(keywords.slice(0, 3).join(" "));
    }
  }

  // Then underrepresented
  for (const cat of gaps.gaps.underrepresented) {
    const keywords = CATEGORY_KEYWORDS[cat as RuleCategory];
    if (keywords && keywords.length > 0) {
      queries.push(keywords.slice(0, 3).join(" "));
    }
  }

  return queries.slice(0, 5); // Limit to 5 queries
}

/**
 * Score a session's potential for filling gaps
 */
export function scoreSessionForGaps(
  sessionSnippet: string,
  gaps: PlaybookGapAnalysis,
): { score: number; matchedCategories: RuleCategory[]; reason: string } {
  const detectedCategories = detectCategories(sessionSnippet);

  if (detectedCategories.length === 0) {
    return { score: 0, matchedCategories: [], reason: "No category patterns detected" };
  }

  let score = 0;
  const matchedCategories: RuleCategory[] = [];
  const reasons: string[] = [];

  for (const cat of detectedCategories) {
    const analysis = gaps.byCategory[cat];
    if (!analysis) continue;

    if (analysis.status === "critical") {
      score += 3;
      matchedCategories.push(cat);
      reasons.push(`${cat} (0 rules)`);
    } else if (analysis.status === "underrepresented") {
      score += 2;
      matchedCategories.push(cat);
      reasons.push(`${cat} (${analysis.count} rules)`);
    } else if (analysis.status === "adequate") {
      score += 1;
      matchedCategories.push(cat);
    }
  }

  const reason =
    reasons.length > 0
      ? `Contains ${reasons.join(", ")} patterns`
      : "Contains patterns in well-covered categories";

  return { score, matchedCategories, reason };
}
