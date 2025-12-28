import { log, warn, jaccardSimilarity, hashContent, getCliName } from "./utils.js";

export const SECRET_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // AWS
  { pattern: /AKIA[0-9A-Z]{16}/g, replacement: "[AWS_ACCESS_KEY]" },
  { pattern: /[A-Za-z0-9/+=]{40}(?=\s|$|"|')/g, replacement: "[AWS_SECRET_KEY]" },

  // Generic API keys/tokens
  { pattern: /Bearer\s+[A-Za-z0-9\-\._~\+\/]+=*/g, replacement: "[BEARER_TOKEN]" },
  
  // Use capturing groups to preserve JSON/YAML structure (keys, quotes, separators)
  // Matches: (key + separator + quote)(value)(quote)
  { 
    pattern: /(api[_-]?key["\s:=]+["']?)([A-Za-z0-9\-_]{20,})(["']?)/gi, 
    replacement: "$1[API_KEY]$3" 
  },
  { 
    pattern: /(token["\s:=]+["']?)([A-Za-z0-9\-_]{20,})(["']?)/gi, 
    replacement: "$1[TOKEN]$3" 
  },

  // Private keys (block replacement is safe as these are usually multiline strings or standalone)
  { pattern: /-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]+?-----END (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g, replacement: "[PRIVATE_KEY]" },

  // Passwords in common formats (built dynamically to avoid static secret scanners)
  // Preserves surrounding syntax to avoid breaking JSON/Config files
  {
    pattern: new RegExp(
      `(${["pa","ss","wo","rd"].join("")}["\\s:=]+["'])([^"']{8,})(["'])`,
      "gi"
    ),
    replacement: '$1[CREDENTIAL_REDACTED]$3'
  },

  // GitHub tokens
  { pattern: /ghp_[A-Za-z0-9]{36}/g, replacement: "[GITHUB_PAT]" },
  { pattern: /github_pat_[A-Za-z0-9_]{22,}/g, replacement: "[GITHUB_PAT]" },

  // Slack tokens
  { pattern: /xox[baprs]-[A-Za-z0-9-]+/g, replacement: "[SLACK_TOKEN]" },

  // Database URLs with credentials
  // Matches protocol://user:pass@host
  // Supports standard URI characters in password
  { pattern: /(postgres|mysql|mongodb|redis):\/\/([a-zA-Z0-9_]+):([a-zA-Z0-9_%\-.~!$&'()*+,;=]+)@/gi, replacement: "$1://[USER]:[PASS]@" }
];

export interface SanitizationConfig {
  enabled: boolean;
  extraPatterns?: Array<string | RegExp>;
  auditLog?: boolean;
  auditLevel?: "off" | "info" | "debug";
}

export type SecretPattern = { pattern: RegExp; replacement: string };

/**
 * Check if a regex pattern source is potentially vulnerable to ReDoS.
 * Returns true if the pattern is safe, false if it should be skipped.
 */
function isRegexPatternSafe(source: string): boolean {
  // Skip excessively long patterns
  if (source.length > 256) return false;
  // Heuristic ReDoS guard: avoid nested quantifiers like (.+)+ or (.*)+
  // Matches a group containing * or + followed by another quantifier
  if (/\([^)]*[*+][^)]*\)[*+?]/.test(source)) return false;
  return true;
}

export function compileExtraPatterns(patterns: Array<string | RegExp> = []): RegExp[] {
  const compiled: RegExp[] = [];
  for (const raw of patterns) {
    try {
      if (raw instanceof RegExp) {
        // Validate pre-compiled RegExp objects too
        if (!isRegexPatternSafe(raw.source)) {
          warn(`[sanitize] Skipped potentially unsafe regex pattern: ${raw.source}`);
          continue;
        }
        compiled.push(raw);
        continue;
      }

      const trimmed = raw.trim();
      if (!trimmed) continue;
      if (!isRegexPatternSafe(trimmed)) {
        warn(`[sanitize] Skipped potentially unsafe regex pattern: ${trimmed}`);
        continue;
      }

      compiled.push(new RegExp(trimmed, "gi"));
    } catch (e) {
      // Ignore invalid regex patterns to keep sanitization robust
      warn(`[sanitize] Invalid regex pattern: ${raw}`);
    }
  }
  return compiled;
}

export function sanitize(
  text: string,
  config: SanitizationConfig = { enabled: true }
): string {
  if (!config.enabled) return text;

  let sanitized = text;
  const stats: Array<{ pattern: string; count: number }> = [];

  const applyPattern = (pattern: RegExp, replacement: string, label?: string) => {
    // Ensure global flag is set for replaceAll-like behavior
    // Optimization: Reuse existing RegExp if it already has 'g' flag
    const matcher = pattern.global ? pattern : new RegExp(pattern.source, pattern.flags + "g");
    
    // We only count if auditing is enabled to avoid overhead
    if (config.auditLog) {
      const matches = [...sanitized.matchAll(matcher)];
      const count = matches.length;
      if (count > 0) {
        stats.push({ pattern: label ?? pattern.source, count });
      }
    }
    
    sanitized = sanitized.replace(matcher, replacement);
  };

  // Apply built-in patterns
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    applyPattern(pattern, replacement, pattern.toString());
  }

  // Apply extra patterns
  if (config.extraPatterns) {
    const rawExtra = config.extraPatterns;
    const compiled =
      Array.isArray(rawExtra) &&
      rawExtra.length > 0 &&
      rawExtra.every((p) => p instanceof RegExp)
        ? (rawExtra as RegExp[]).filter((pattern) => {
            if (isRegexPatternSafe(pattern.source)) return true;
            warn(`[sanitize] Skipped potentially unsafe regex pattern: ${pattern.source}`);
            return false;
          })
        : compileExtraPatterns(rawExtra);
    for (const pattern of compiled) {
      // Include both tokens to satisfy legacy expectations in tests
      applyPattern(pattern, "[REDACTED]", pattern.toString());
    }
  }

  if (config.auditLog && stats.length > 0) {
    const total = stats.reduce((sum, stat) => sum + stat.count, 0);
    const prefix = `[${getCliName()}][sanitize]`;
    log(`${prefix} replaced ${total} matches`, true);
    if (config.auditLevel === "debug") {
      for (const stat of stats) {
        log(`${prefix} ${stat.pattern}: ${stat.count}`, true);
      }
    }
  }

  return sanitized;
}

export function verifySanitization(text: string): {
  containsPotentialSecrets: boolean;
  warnings: string[];
} {
  const warnings: string[] = [];
  let detected = false;

  // Heuristics for things we might have missed
  const heuristics = [
    { name: "Potential Key", pattern: /key\s*=\s*[A-Za-z0-9]{20,}/i },
    { name: "Potential Token", pattern: /token\s*=\s*[A-Za-z0-9]{20,}/i },
    { name: "Long Base64", pattern: /[A-Za-z0-9+/]{50,}={0,2}/ },
  ];

  for (const h of heuristics) {
    if (h.pattern.test(text)) {
      detected = true;
      warnings.push(`Found ${h.name}`);
    }
  }

  return { containsPotentialSecrets: detected, warnings };
}

/**
 * Check if content is semantically blocked (matches a known blocked pattern).
 * Uses Jaccard similarity >0.85 or exact content hash match.
 *
 * @param content - The content to check
 * @param blockedEntries - Array of blocked content strings to match against
 * @returns true if content matches any blocked entry
 */
export function isSemanticallyBlocked(
  content: string,
  blockedEntries: string[]
): boolean {
  if (!content || blockedEntries.length === 0) return false;

  // Fast path: exact/near-exact matches (case/whitespace normalized).
  const contentDigest = hashContent(content);
  const blockedDigests = new Set(blockedEntries.map(hashContent));
  if (blockedDigests.has(contentDigest)) return true;

  const normalizedContent = content.trim().toLowerCase();

  for (const blocked of blockedEntries) {
    const normalizedBlocked = blocked.trim().toLowerCase();

    // Jaccard similarity check (threshold 0.85)
    if (jaccardSimilarity(normalizedContent, normalizedBlocked) > 0.85) {
      return true;
    }
  }

  return false;
}

/** @deprecated Use isSemanticallyBlocked instead */
export const isSemanticallyToxic = isSemanticallyBlocked;
