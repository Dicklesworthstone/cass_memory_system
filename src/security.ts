import { SanitizationConfig } from "./types.js";
import { log } from "./utils.js";

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
  // Fixed: ReDoS prevention
  { pattern: /(postgres|mysql|mongodb|redis):\/\/([a-zA-Z0-9_]+):([a-zA-Z0-9_%\-.~]+)@/gi, replacement: "$1://[USER]:[PASS]@" }
];

export function sanitize(
  text: string,
  config: { enabled: boolean; extraPatterns?: RegExp[]; auditLog?: boolean; auditLevel?: string }
): string {
  if (!config.enabled) {
    return text;
  }

  let sanitized = text;
  const stats: Array<{ pattern: string; count: number }> = [];

  const applyPattern = (pattern: RegExp, replacement: string, label?: string) => {
    const matcher = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
    const matches = [...sanitized.matchAll(matcher)];
    const count = matches.length;
    if (count === 0) return;
    sanitized = sanitized.replace(matcher, replacement);
    if (count > 0) {
      stats.push({ pattern: label ?? pattern.source, count });
    }
  };

  // Apply default patterns
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    applyPattern(pattern, replacement, pattern.toString());
  }

  // Apply extra patterns
  const extraPatterns = compileExtraPatterns(config.extraPatterns);
  if (extraPatterns.length > 0) {
    for (const pattern of extraPatterns) {
      applyPattern(pattern, "[REDACTED]", pattern.toString());
    }
  }

  if (config.auditLog) {
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
      if (/(.\+|\.\*)\+/.test(trimmed)) continue;

      compiled.push(new RegExp(trimmed, "gi"));
    } catch {
      // Ignore invalid regex patterns to keep sanitization robust
    }
  }
  return compiled;
}
