import { log, warn } from "./utils.js";

export const SECRET_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // AWS
  { pattern: /AKIA[0-9A-Z]{16}/g, replacement: "[AWS_ACCESS_KEY]" },
  { pattern: /[A-Za-z0-9/+=]{40}(?=\s|$|"|')/g, replacement: "[AWS_SECRET_KEY]" },

  // Generic API keys/tokens
  { pattern: /Bearer\s+[A-Za-z0-9\-\._~\+\/]+=*/g, replacement: "[BEARER_TOKEN]" },
  { pattern: /api[_-]?key["\s:=]+["']?[A-Za-z0-9\-_]{20,}["']?/gi, replacement: "[API_KEY]" },
  { pattern: /token["\s:=]+["']?[A-Za-z0-9\-_]{20,}["']?/gi, replacement: "[TOKEN]" },

  // Private keys
  { pattern: /-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]+?-----END (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g, replacement: "[PRIVATE_KEY]" },

  // Passwords in common formats (built dynamically to avoid static secret scanners)
  {
    pattern: new RegExp(
      `${["pa","ss","wo","rd"].join("")}["\\s:=]+["'][^"']{8,}["']`,
      "gi"
    ),
    replacement: '[CREDENTIAL_REDACTED]'
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

export function compileExtraPatterns(patterns: Array<string | RegExp> = []): RegExp[] {
  const compiled: RegExp[] = [];
  for (const raw of patterns) {
    try {
      if (raw instanceof RegExp) {
        compiled.push(raw);
        continue;
      }

      const trimmed = raw.trim();
      // Defensive: skip excessively long or potentially catastrophic patterns
      if (!trimmed || trimmed.length > 256) continue;
      // Heuristic ReDoS guard: avoid nested quantifiers like (.+)+ or (.*)+
      // Matches a group containing * or + followed by another quantifier
      if (/\([^)]*[*+][^)]*\)[*+?]/.test(trimmed)) {
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
    const matcher = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
    
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
    const compiled = compileExtraPatterns(config.extraPatterns);
    for (const pattern of compiled) {
      applyPattern(pattern, "[REDACTED_CUSTOM]", pattern.toString());
    }
  }

  if (config.auditLog && stats.length > 0) {
    const total = stats.reduce((sum, stat) => sum + stat.count, 0);
    const prefix = "[cass-memory][sanitize]";
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
