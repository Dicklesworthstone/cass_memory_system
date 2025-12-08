import { loadConfig } from "../config.js";
import { loadMergedPlaybook, getActiveBullets } from "../playbook.js";
import { getModel, PROMPTS, fillPrompt, truncateForPrompt, llmWithRetry } from "../llm.js";
import { cassAvailable, cassSearch, cassExport, cassTimeline } from "../cass.js";
import { error as logError } from "../utils.js";
import { generateObject } from "ai";
import chalk from "chalk";
import { z } from "zod";
import type { AuditViolation } from "../types.js";

// Schema for LLM audit response
const AuditResultSchema = z.object({
  results: z.array(z.object({
    ruleId: z.string(),
    status: z.enum(["followed", "violated", "not_applicable"]),
    evidence: z.string()
  })),
  summary: z.string()
});

export interface AuditCommandOptions {
  /** Number of days to look back for sessions */
  days?: number;
  /** Filter to specific workspace */
  workspace?: string;
  /** Filter by minimum severity */
  severity?: "low" | "medium" | "high";
  /** Output as JSON */
  json?: boolean;
}

/**
 * Classify severity of a violation based on rule characteristics.
 * - High: Security-related, testing, or critical workflow rules
 * - Medium: Best practices, conventions
 * - Low: Style, documentation
 */
function classifySeverity(bulletContent: string): "low" | "medium" | "high" {
  const content = bulletContent.toLowerCase();

  // High severity keywords
  const highKeywords = [
    "security", "auth", "password", "secret", "credential",
    "test", "testing", "commit", "push", "deploy",
    "production", "never", "always", "must", "critical"
  ];

  // Medium severity keywords
  const mediumKeywords = [
    "prefer", "use", "avoid", "should", "pattern",
    "convention", "standard", "best practice"
  ];

  if (highKeywords.some(k => content.includes(k))) {
    return "high";
  }

  if (mediumKeywords.some(k => content.includes(k))) {
    return "medium";
  }

  return "low";
}

/**
 * Get unique session paths from recent timeline.
 */
async function getRecentSessions(
  cassPath: string,
  days: number,
  workspace?: string
): Promise<string[]> {
  const timeline = await cassTimeline(days, cassPath);

  const sessions: string[] = [];
  for (const group of timeline.groups) {
    for (const session of group.sessions) {
      if (workspace && session.path && !session.path.includes(workspace)) {
        continue;
      }
      if (session.path) {
        sessions.push(session.path);
      }
    }
  }

  // Return unique sessions
  return [...new Set(sessions)];
}

/**
 * Format rules for the audit prompt.
 */
function formatRulesForAudit(
  bullets: Array<{ id: string; content: string; category: string }>
): string {
  return bullets.map(b => `[${b.id}] (${b.category}) ${b.content}`).join("\n");
}

/**
 * Main entry point for the 'cass-memory audit' command.
 *
 * Checks recent sessions for playbook rule violations using LLM analysis.
 * Helps identify rules that agents are ignoring or finding hard to follow.
 *
 * @param options - Command options
 *
 * @example
 * cass-memory audit --days 7
 * cass-memory audit --workspace myproject --severity high
 * cass-memory audit --json
 */
export async function auditCommand(
  options: AuditCommandOptions = {}
): Promise<void> {
  const config = await loadConfig();

  // Check cass availability
  if (!cassAvailable(config.cassPath)) {
    logError("cass CLI is not available. Audit requires cass history.");
    process.exit(1);
  }

  // 1. Load active rules (exclude anti-patterns, they're warnings not violations)
  const playbook = await loadMergedPlaybook(config);
  const activeBullets = getActiveBullets(playbook).filter(b => !b.isNegative && !b.deprecated);

  if (activeBullets.length === 0) {
    console.log(chalk.yellow("No active rules to audit against."));
    return;
  }

  // 2. Get recent sessions
  const days = options.days || 7;
  const sessions = await getRecentSessions(config.cassPath, days, options.workspace);

  if (sessions.length === 0) {
    console.log(chalk.yellow(`No sessions found in the last ${days} days.`));
    return;
  }

  if (!options.json) {
    console.log(chalk.bold(`\nAuditing ${sessions.length} sessions against ${activeBullets.length} rules...\n`));
  }

  // 3. Initialize model
  const model = getModel({
    provider: config.provider,
    model: config.model,
    apiKey: config.apiKey
  });

  const violations: AuditViolation[] = [];
  let sessionsAudited = 0;

  // 4. Audit each session
  for (const sessionPath of sessions) {
    // Get full session content
    const sessionContent = await cassExport(sessionPath, "markdown", config.cassPath);
    if (!sessionContent || sessionContent.trim().length < 100) {
      // Skip empty or very short sessions
      continue;
    }

    sessionsAudited++;

    // Truncate content for LLM
    const truncatedContent = truncateForPrompt(sessionContent, 30000);

    // Prepare rules for audit (batch in groups to avoid token limits)
    const batchSize = 10;
    for (let i = 0; i < activeBullets.length; i += batchSize) {
      const bulletBatch = activeBullets.slice(i, i + batchSize);
      const rulesText = formatRulesForAudit(bulletBatch);

      const prompt = fillPrompt(PROMPTS.audit, {
        sessionContent: truncatedContent,
        rulesToCheck: rulesText
      });

      try {
        // Use generateObject for structured output
        const { object } = await llmWithRetry(
          () => generateObject({
            model,
            prompt,
            schema: AuditResultSchema,
            temperature: 0.1
          }),
          `audit-${sessionPath.slice(-20)}`
        );

        // Process results
        for (const result of object.results) {
          if (result.status === "violated") {
            const bullet = bulletBatch.find(b => b.id === result.ruleId);
            if (bullet) {
              violations.push({
                bulletId: result.ruleId,
                bulletContent: bullet.content,
                sessionPath,
                evidence: result.evidence,
                severity: classifySeverity(bullet.content)
              });
            }
          }
        }
      } catch (err: any) {
        // Log but continue on LLM errors
        if (!options.json) {
          console.warn(chalk.dim(`  Warning: Audit failed for batch in ${sessionPath}: ${err.message}`));
        }
      }
    }

    // Progress indicator for non-JSON output
    if (!options.json) {
      const violationCount = violations.filter(v => v.sessionPath === sessionPath).length;
      const status = violationCount > 0
        ? chalk.yellow(`${violationCount} violation(s)`)
        : chalk.green("✓");
      console.log(chalk.dim(`  ${sessionPath.split("/").pop()}: ${status}`));
    }
  }

  // 5. Filter by severity if requested
  const filteredViolations = options.severity
    ? violations.filter(v => {
        const severityOrder = { low: 0, medium: 1, high: 2 };
        return severityOrder[v.severity] >= severityOrder[options.severity!];
      })
    : violations;

  // 6. Output results
  if (options.json) {
    console.log(JSON.stringify({
      sessionsAudited,
      totalViolations: filteredViolations.length,
      violations: filteredViolations,
      summary: {
        high: filteredViolations.filter(v => v.severity === "high").length,
        medium: filteredViolations.filter(v => v.severity === "medium").length,
        low: filteredViolations.filter(v => v.severity === "low").length
      }
    }, null, 2));
    return;
  }

  // Human-readable output
  console.log(chalk.bold("\n" + "═".repeat(60)));
  console.log(chalk.bold("                    AUDIT RESULTS"));
  console.log("═".repeat(60));
  console.log(`Sessions audited: ${sessionsAudited}`);
  console.log(`Violations found: ${filteredViolations.length}`);
  console.log();

  if (filteredViolations.length === 0) {
    console.log(chalk.green("✓ No rule violations detected!"));
    return;
  }

  // Group by severity
  const highViolations = filteredViolations.filter(v => v.severity === "high");
  const mediumViolations = filteredViolations.filter(v => v.severity === "medium");
  const lowViolations = filteredViolations.filter(v => v.severity === "low");

  if (highViolations.length > 0) {
    console.log(chalk.red.bold(`HIGH SEVERITY (${highViolations.length}):`));
    for (const v of highViolations) {
      console.log(chalk.red(`  [${v.bulletId}] "${v.bulletContent}"`));
      console.log(chalk.dim(`    Session: ${v.sessionPath}`));
      console.log(chalk.dim(`    Evidence: ${v.evidence.slice(0, 200)}${v.evidence.length > 200 ? "..." : ""}`));
      console.log();
    }
  }

  if (mediumViolations.length > 0) {
    console.log(chalk.yellow.bold(`MEDIUM SEVERITY (${mediumViolations.length}):`));
    for (const v of mediumViolations) {
      console.log(chalk.yellow(`  [${v.bulletId}] "${v.bulletContent}"`));
      console.log(chalk.dim(`    Session: ${v.sessionPath}`));
      console.log(chalk.dim(`    Evidence: ${v.evidence.slice(0, 200)}${v.evidence.length > 200 ? "..." : ""}`));
      console.log();
    }
  }

  if (lowViolations.length > 0) {
    console.log(chalk.blue.bold(`LOW SEVERITY (${lowViolations.length}):`));
    for (const v of lowViolations) {
      console.log(chalk.blue(`  [${v.bulletId}] "${v.bulletContent}"`));
      console.log(chalk.dim(`    Session: ${v.sessionPath}`));
      console.log(chalk.dim(`    Evidence: ${v.evidence.slice(0, 150)}${v.evidence.length > 150 ? "..." : ""}`));
      console.log();
    }
  }

  console.log("═".repeat(60));
}
