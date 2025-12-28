/**
 * onboard command - Agent-native guided onboarding
 *
 * This command guides AI coding agents through the process of populating
 * the playbook from historical cass sessions WITHOUT using external LLM APIs.
 *
 * The agent itself does the reflection work - no API costs!
 */

import chalk from "chalk";
import { loadConfig } from "../config.js";
import { loadMergedPlaybook, getActiveBullets } from "../playbook.js";
import { cassExport, handleCassUnavailable, CassSearchOptions, safeCassSearchWithDegraded } from "../cass.js";
import {
  getCliName,
  expandPath,
  formatRelativeTime,
  printJson,
  printJsonResult,
  reportError,
  validateNonEmptyString,
  validatePositiveInt,
  now
} from "../utils.js";
import { agentIconPrefix, formatKv, formatRule, getOutputStyle, icon, iconPrefix } from "../output.js";
import { createProgress, type ProgressReporter } from "../progress.js";
import { ErrorCode } from "../types.js";
import {
  loadOnboardState,
  markSessionProcessed,
  resetOnboardState,
  getOnboardProgress,
  filterUnprocessedSessions,
  OnboardProgress,
} from "../onboard-state.js";
import {
  analyzePlaybookGaps,
  getGapSearchQueries,
  scoreSessionForGaps,
  detectCategories,
  RULE_CATEGORIES,
  type PlaybookGapAnalysis,
  type RuleCategory,
} from "../gap-analysis.js";
import { findSimilarBulletsSemantic } from "../semantic.js";
import { ProcessedLog, getProcessedLogPath } from "../tracking.js";
import path from "node:path";
import fs from "node:fs/promises";

interface OnboardStatus {
  cassAvailable: boolean;
  totalConversations: number;
  totalMessages: number;
  playbookRules: number;
  needsOnboarding: boolean;
  onboardingRatio: number; // rules per 100 conversations
  recommendation: string;
}

interface SessionSample {
  path: string;
  agent: string;
  workspace: string;
  snippet: string;
  score: number;
  gapScore?: number;
  matchedCategories?: string[];
  gapReason?: string;
}

interface OnboardJsonOutput {
  status: OnboardStatus;
  progress?: OnboardProgress;
  step?: string;
  sessions?: SessionSample[];
  sessionsRemaining?: number;
  sessionContent?: string;
  extractionPrompt?: string;
  categories?: string[];
  examples?: { rule: string; category: string }[];
  gapAnalysis?: PlaybookGapAnalysis;
}

// RULE_CATEGORIES is imported from gap-analysis.ts (single source of truth)

const EXAMPLE_RULES = [
  { rule: "Before implementing a fix, search the codebase to verify the issue still exists", category: "debugging" },
  { rule: "When claiming a task, first check its current status - another agent may have completed it", category: "workflow" },
  { rule: "When parsing JSON from external CLIs, handle both arrays and wrapper objects", category: "integration" },
  { rule: "Always run the full test suite before committing", category: "testing" },
  { rule: "Use centralized constant files instead of hardcoding magic strings", category: "architecture" },
  { rule: "AVOID: Mocking entire modules in tests - prefer mocking specific functions", category: "testing" },
];

async function getOnboardStatus(): Promise<OnboardStatus> {
  const config = await loadConfig();
  const playbook = await loadMergedPlaybook(config);
  const availability = await handleCassUnavailable({ cassPath: config.cassPath });

  // We don't have a reliable way to get conversation counts from cass
  // so we leave these as 0 (unknown) rather than using fake placeholder values
  const totalConversations = 0;
  const totalMessages = 0;

  // Use getActiveBullets for consistent filtering (includes maturity check)
  const playbookRules = getActiveBullets(playbook).length;
  // Ratio is meaningless without real conversation counts
  const onboardingRatio = 0;
  // Base needs assessment on playbook size alone since we can't count conversations
  const needsOnboarding = playbookRules < 20;

  let recommendation: string;
  if (!availability.canContinue || availability.fallbackMode === "playbook-only") {
    recommendation = "Install cass first to enable historical session analysis";
  } else if (playbookRules === 0) {
    recommendation = "Your playbook is empty! Run `cm onboard guided` to start extracting rules";
  } else if (playbookRules < 10) {
    recommendation = "Your playbook has few rules. Run `cm onboard guided` to add more";
  } else if (playbookRules < 50) {
    recommendation = "Consider running `cm onboard sample` to find more patterns";
  } else {
    recommendation = "Your playbook looks healthy. Use `cm context` for task-specific rules";
  }

  return {
    cassAvailable: availability.canContinue && availability.fallbackMode === "none",
    totalConversations,
    totalMessages,
    playbookRules,
    needsOnboarding,
    onboardingRatio,
    recommendation,
  };
}

interface SampleOptions {
  limit?: number;
  includeProcessed?: boolean;
  workspace?: string;
  agent?: string;
  days?: number;
  fillGaps?: boolean;
  gapAnalysis?: PlaybookGapAnalysis;
  onProgress?: (event: { current: number; total: number; message: string }) => void;
}

async function sampleDiverseSessions(options: SampleOptions = {}): Promise<{
  sessions: SessionSample[];
  totalFound: number;
  filtered: number;
}> {
  const config = await loadConfig();
  const limit = options.limit ?? 10;
  const days = options.days ?? 90;

  // Use gap-targeted queries if fillGaps is true and we have gap analysis
  let queries: string[];
  if (options.fillGaps && options.gapAnalysis) {
    queries = getGapSearchQueries(options.gapAnalysis);
    // Fall back to default queries if no gaps
    if (queries.length === 0) {
      queries = [
        "fix bug error",
        "implement feature",
        "refactor",
        "test",
        "documentation",
      ];
    }
  } else {
    queries = [
      "fix bug error",
      "implement feature",
      "refactor",
      "test",
      "documentation",
      "authentication",
      "database",
      "API",
      "performance",
      "debugging",
    ];
  }

  const sessions: Map<string, SessionSample> = new Map();

  const totalQueries = queries.length;
  let queriesCompleted = 0;
  
  if (typeof options.onProgress === "function") {
    try {
      options.onProgress({ current: 0, total: totalQueries, message: "Sampling sessions..." });
    } catch {
      // Best-effort
    }
  }

  // Run in batches to avoid spawning too many processes/SSH connections at once
  const BATCH_SIZE = 3;
  for (let i = 0; i < queries.length; i += BATCH_SIZE) {
    if (sessions.size >= limit * 2) break;

    const batch = queries.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(async (query) => {
      // Check limit inside the parallel execution too (optimization)
      if (sessions.size >= limit * 2) return;

      try {
        const searchOpts: CassSearchOptions = {
          limit: 5,
          days,
          workspace: options.workspace,
          agent: options.agent,
        };
        const { hits } = await safeCassSearchWithDegraded(query, searchOpts, config.cassPath, config);
        
        for (const hit of hits) {
          if (sessions.size >= limit * 2) break; // strict limit check
          
          if (!sessions.has(hit.source_path)) {
            const session: SessionSample = {
              path: hit.source_path,
              agent: hit.agent,
              workspace: hit.workspace || path.dirname(hit.source_path),
              snippet: hit.snippet,
              score: hit.score ?? 0,
            };

            // Score against gaps if analysis is provided
            if (options.gapAnalysis) {
              const gapResult = scoreSessionForGaps(hit.snippet, options.gapAnalysis);
              session.gapScore = gapResult.score;
              session.matchedCategories = gapResult.matchedCategories;
              session.gapReason = gapResult.reason;
            }

            sessions.set(hit.source_path, session);
          }
        }
      } catch {
        // Ignore search errors
      }
    }));

    queriesCompleted += batch.length;
    if (typeof options.onProgress === "function") {
      try {
        options.onProgress({ 
          current: Math.min(queriesCompleted, totalQueries), 
          total: totalQueries, 
          message: `Sampling sessions (${sessions.size} found)...` 
        });
      } catch {
        // Best-effort
      }
    }
  }

  let allSessions = Array.from(sessions.values());
  const totalFound = allSessions.length;

  // Filter out already-processed sessions unless includeProcessed is true
  if (!options.includeProcessed) {
    const state = await loadOnboardState();
    allSessions = filterUnprocessedSessions(allSessions, state);
  }

  // Sort by gap score if available (higher scores first)
  if (options.fillGaps && options.gapAnalysis) {
    allSessions.sort((a, b) => (b.gapScore ?? 0) - (a.gapScore ?? 0));
  }

  const filtered = totalFound - allSessions.length;

  // Return up to limit sessions
  return {
    sessions: allSessions.slice(0, limit),
    totalFound,
    filtered,
  };
}

async function exportSessionForAgent(sessionPath: string): Promise<string | null> {
  const config = await loadConfig();
  try {
    return await cassExport(sessionPath, "text", config.cassPath, config);
  } catch {
    return null;
  }
}

/**
 * Generate a suggested focus message based on gaps and detected topics
 */
function generateSuggestedFocus(
  gapAnalysis: PlaybookGapAnalysis,
  topicHints: RuleCategory[]
): string {
  const parts: string[] = [];

  // Check for overlap between detected topics and gaps
  const criticalOverlap = topicHints.filter(t => gapAnalysis.gaps.critical.includes(t));
  const underrepOverlap = topicHints.filter(t => gapAnalysis.gaps.underrepresented.includes(t));

  if (criticalOverlap.length > 0) {
    parts.push(`This session may contain ${criticalOverlap.join(", ")} patterns - you have NO rules in these areas!`);
  }

  if (underrepOverlap.length > 0) {
    parts.push(`Look for ${underrepOverlap.join(", ")} insights - these categories need more rules.`);
  }

  if (parts.length === 0) {
    // No gap overlap, give general guidance based on topics
    if (topicHints.length > 0) {
      parts.push(`Focus on extracting ${topicHints.slice(0, 2).join(" and ")} patterns from this session.`);
    } else {
      parts.push("Look for debugging strategies, workflow insights, or tool-specific knowledge.");
    }
  }

  // Add general gaps if we have room
  if (gapAnalysis.gaps.critical.length > 0 && criticalOverlap.length === 0) {
    parts.push(`Also note: you have NO rules for ${gapAnalysis.gaps.critical.slice(0, 3).join(", ")}.`);
  }

  return parts.join(" ");
}

function getExtractionPrompt(): string {
  return `
# Session Analysis Instructions

You are analyzing a coding session to extract reusable rules for the playbook.

## What to Look For

1. **Patterns that led to success**
   - What approaches worked well?
   - What debugging strategies helped?
   - What architectural decisions paid off?

2. **Patterns that caused problems**
   - What mistakes were made?
   - What approaches failed?
   - What should be avoided?

3. **Workflow insights**
   - How was work prioritized?
   - How were tasks coordinated?
   - What communication patterns helped?

4. **Tool-specific knowledge**
   - CLI quirks or gotchas
   - API format surprises
   - Configuration patterns

## Rule Formulation Guidelines

- Write rules as **imperative statements** ("Always...", "Never...", "When X, do Y")
- Be **specific** enough to be actionable
- Include **context** about when the rule applies
- For anti-patterns, prefix with "AVOID:" or "PITFALL:"

## Categories to Use

${RULE_CATEGORIES.map(c => `- ${c}`).join("\n")}

## Example Rules

${EXAMPLE_RULES.map(e => `- [${e.category}] "${e.rule}"`).join("\n")}

## After Analysis

**Recommended (batch add):** Create a JSON array and add all rules at once:

\`\`\`bash
# Create rules.json with extracted rules:
# [{"content": "Rule 1...", "category": "debugging"}, {"content": "Rule 2...", "category": "testing"}]

cm playbook add --file rules.json --check
\`\`\`

**Alternative (single add):** Add rules one at a time:

\`\`\`bash
cm playbook add "Your rule content" --category "category" --check
\`\`\`

The \`--check\` flag validates rules before adding (similarity, quality, category match).
`.trim();
}

function getGuidedOnboardingText(cli: string, status: OnboardStatus): string {
  return `
# Agent-Native Onboarding Guide

${chalk.bold("Current Status:")}
${status.cassAvailable ? chalk.green(`${icon("success")} cass available`) : chalk.red(`${icon("failure")} cass not available`)}
${chalk.cyan(`Playbook rules: ${status.playbookRules}`)}

${chalk.bold.yellow(status.recommendation)}

---

## How This Works

Instead of using expensive LLM APIs, **you** (the coding agent) do the reflection work.
This is "free" since you're already being paid for via Claude Max/GPT Pro.

## Step-by-Step Process

### Step 1: Sample Sessions
\`\`\`bash
${cli} onboard sample --json
\`\`\`
This returns diverse sessions from your cass history to analyze.

### Step 2: Read a Session
\`\`\`bash
${cli} onboard read <session-path>
\`\`\`
This exports the session content for you to analyze.

### Step 3: Extract Rules
Read the session content and identify reusable patterns.
Use the extraction prompt (\`${cli} onboard prompt\`) for guidance.

### Step 4: Add Rules
\`\`\`bash
${cli} playbook add "Your rule content" --category "category"
\`\`\`

### Step 5: Repeat
Process 10-20 diverse sessions for a good initial playbook.

---

## Quick Commands

| Command | Purpose |
|---------|---------|
| \`${cli} onboard status\` | Check onboarding status |
| \`${cli} onboard sample\` | Get sessions to analyze |
| \`${cli} onboard read <path>\` | Read a session |
| \`${cli} onboard prompt\` | Get extraction instructions |
| \`${cli} playbook add "..." --category "..."\` | Add a rule |
| \`${cli} playbook list\` | View all rules |

## Categories

${RULE_CATEGORIES.map(c => `- \`${c}\``).join("\n")}

## Example Rules

${EXAMPLE_RULES.map(e => `- **${e.category}**: "${e.rule}"`).join("\n")}
`.trim();
}

function getGuidedOnboardingJson(cli: string, status: OnboardStatus): OnboardJsonOutput {
  return {
    status,
    step: "guided",
    categories: [...RULE_CATEGORIES],
    examples: EXAMPLE_RULES,
    extractionPrompt: getExtractionPrompt(),
  };
}

export async function onboardCommand(
  options: {
    json?: boolean;
    status?: boolean;
    sample?: boolean;
    read?: string;
    prompt?: boolean;
    guided?: boolean;
    limit?: number;
    markDone?: string;
    reset?: boolean;
    yes?: boolean;
    includeProcessed?: boolean;
    workspace?: string;
    agent?: string;
    days?: number;
    fillGaps?: boolean;
    gaps?: boolean;
    template?: boolean;
  } = {}
): Promise<void> {
  const startedAtMs = Date.now();
  const cli = getCliName();

  // Handle --reset first (destructive operation)
	  if (options.reset) {
	    const canPrompt = Boolean(!options.json && process.stdin.isTTY && process.stdout.isTTY);
	
	    if (!options.yes) {
	      if (canPrompt) {
	        // Interactive confirmation
	        const readline = await import("node:readline");
	        const rl = readline.createInterface({
	          input: process.stdin,
	          output: process.stdout,
	        });
	        const answer = await new Promise<string>((resolve) => {
	          rl.question(chalk.yellow("Reset onboarding progress? This cannot be undone. [y/N] "), resolve);
	        });
	        rl.close();
	        if (answer.toLowerCase() !== "y") {
	          console.log(chalk.dim("Cancelled."));
	          return;
	        }
	      } else {
	        reportError("Confirmation required to reset onboarding progress", {
	          code: ErrorCode.MISSING_REQUIRED,
	          hint: "Re-run with --yes",
	          details: { missing: "confirmation" },
	          json: options.json,
            command: "onboard:reset",
            startedAtMs,
	        });
	        return;
	      }
	    }
	    await resetOnboardState();
	    if (options.json) {
	      printJsonResult("onboard:reset", { message: "Onboarding progress reset" }, { startedAtMs });
	    } else {
      console.log(chalk.green(`${icon("success")} Onboarding progress reset`));
    }
    return;
  }

  // Handle --mark-done
  if (options.markDone !== undefined) {
    const sessionPathCheck = validateNonEmptyString(options.markDone, "mark-done", { trim: true });
    if (!sessionPathCheck.ok) {
      reportError(sessionPathCheck.message, {
        code: ErrorCode.INVALID_INPUT,
        details: sessionPathCheck.details,
        hint: `Example: ${cli} onboard mark-done <path> --json`,
        json: options.json,
        command: "onboard:mark-done",
        startedAtMs,
      });
      return;
    }
    const sessionPath = sessionPathCheck.value;
    await markSessionProcessed(sessionPath, 0, { skipped: true });

    // Also mark as processed in the reflection log to prevent future auto-reflection
    const logPath = expandPath(getProcessedLogPath(options.workspace));
    const processedLog = new ProcessedLog(logPath);
    await processedLog.load();
    await processedLog.append({
      sessionPath,
      processedAt: now(),
      deltasGenerated: 0
    });

    if (options.json) {
      printJsonResult("onboard:mark-done", {
        message: "Session marked as processed",
        sessionPath,
        rulesExtracted: 0,
        skipped: true,
      }, { startedAtMs });
    } else {
      console.log(chalk.green(`${icon("success")} Marked as processed: ${sessionPath}`));
      console.log(chalk.dim("  (0 rules extracted - session skipped)"));
    }
    return;
  }

  const status = await getOnboardStatus();
  const progress = await getOnboardProgress();

  // Load gap analysis if needed
  const config = await loadConfig();
  const playbook = await loadMergedPlaybook(config);
  const gapAnalysis = analyzePlaybookGaps(playbook);

  // Gap analysis standalone view
  if (options.gaps) {
    if (options.json) {
      printJsonResult("onboard:gaps", { status, progress, gapAnalysis }, { startedAtMs });
    } else {
      const maxWidth = Math.min(getOutputStyle().width, 84);
      console.log(chalk.bold("PLAYBOOK GAP ANALYSIS"));
      console.log(chalk.dim(formatRule("─", { maxWidth })));
      console.log(chalk.dim(`Total rules: ${gapAnalysis.totalRules}`));
      console.log("");

      // Show critical gaps
      if (gapAnalysis.gaps.critical.length > 0) {
        console.log(chalk.red.bold("CRITICAL (0 rules):"));
        for (const cat of gapAnalysis.gaps.critical) {
          console.log(chalk.red(`  ${icon("failure")} ${cat}`));
        }
        console.log("");
      }

      // Show underrepresented
      if (gapAnalysis.gaps.underrepresented.length > 0) {
        console.log(chalk.yellow.bold("UNDERREPRESENTED (1-2 rules):"));
        for (const cat of gapAnalysis.gaps.underrepresented) {
          const count = gapAnalysis.byCategory[cat].count;
          console.log(chalk.yellow(`  ${iconPrefix("warning")}${cat} (${count} rules)`));
        }
        console.log("");
      }

      // Show well-covered
      if (gapAnalysis.wellCovered.length > 0) {
        console.log(chalk.green.bold("WELL-COVERED (11+ rules):"));
        for (const cat of gapAnalysis.wellCovered) {
          const count = gapAnalysis.byCategory[cat].count;
          console.log(chalk.green(`  ${icon("success")} ${cat} (${count} rules)`));
        }
        console.log("");
      }

      // Show category breakdown
      console.log(chalk.bold("CATEGORY BREAKDOWN:"));
      for (const cat of RULE_CATEGORIES) {
        const analysis = gapAnalysis.byCategory[cat];
        const bar = "█".repeat(Math.min(20, analysis.count)) + "░".repeat(Math.max(0, 20 - analysis.count));
        const statusColor = analysis.status === "critical" ? chalk.red
          : analysis.status === "underrepresented" ? chalk.yellow
          : analysis.status === "adequate" ? chalk.blue
          : chalk.green;
        console.log(`  ${cat.padEnd(15)} ${statusColor(bar)} ${analysis.count}`);
      }

      console.log("");
      console.log(chalk.yellow(gapAnalysis.suggestions));
      console.log(chalk.dim(`\nTo sample sessions that fill gaps: ${cli} onboard sample --fill-gaps`));
    }
    return;
  }

  // Status check
  if (options.status) {
    if (options.json) {
      printJsonResult("onboard:status", { status, progress, gapAnalysis }, { startedAtMs });
    } else {
      const maxWidth = Math.min(getOutputStyle().width, 84);
      console.log(chalk.bold("ONBOARDING STATUS"));
      console.log(chalk.dim(formatRule("─", { maxWidth })));
      console.log(
        formatKv([
          { key: "cass available", value: status.cassAvailable ? "yes" : "no" },
          { key: "Playbook rules", value: String(status.playbookRules) },
          { key: "Needs onboarding", value: status.needsOnboarding ? "yes" : "no" },
        ], { indent: "  ", width: maxWidth })
      );

      // Show progress if we have any
      if (progress.hasStarted) {
        console.log("");
        console.log(chalk.bold("PROGRESS"));
        console.log(chalk.dim(formatRule("─", { maxWidth })));
        console.log(
          formatKv([
            { key: "Sessions analyzed", value: String(progress.sessionsProcessed) },
            { key: "Rules extracted", value: String(progress.rulesExtracted) },
            { key: "Started", value: progress.startedAt ? formatRelativeTime(progress.startedAt) : "never" },
            { key: "Last activity", value: progress.lastActivity ? formatRelativeTime(progress.lastActivity) : "never" },
          ], { indent: "  ", width: maxWidth })
        );
      }

      // Show gap summary
      if (gapAnalysis.gaps.critical.length > 0 || gapAnalysis.gaps.underrepresented.length > 0) {
        console.log("");
        console.log(chalk.bold("GAPS"));
        console.log(chalk.dim(formatRule("─", { maxWidth })));
        if (gapAnalysis.gaps.critical.length > 0) {
          console.log(chalk.red(`  Critical: ${gapAnalysis.gaps.critical.join(", ")}`));
        }
        if (gapAnalysis.gaps.underrepresented.length > 0) {
          console.log(chalk.yellow(`  Low: ${gapAnalysis.gaps.underrepresented.join(", ")}`));
        }
      }

      console.log("");
      console.log(chalk.yellow(status.recommendation));
    }
    return;
  }

  // Sample sessions
  if (options.sample) {
    const limitCheck = validatePositiveInt(options.limit, "limit", { min: 1, allowUndefined: true });
    if (!limitCheck.ok) {
      reportError(limitCheck.message, {
        code: ErrorCode.INVALID_INPUT,
        details: limitCheck.details,
        hint: `Example: ${cli} onboard sample --limit 5 --json`,
        json: options.json,
        command: "onboard:sample",
        startedAtMs,
      });
      return;
    }

    const daysCheck = validatePositiveInt(options.days, "days", { min: 1, allowUndefined: true });
    if (!daysCheck.ok) {
      reportError(daysCheck.message, {
        code: ErrorCode.INVALID_INPUT,
        details: daysCheck.details,
        hint: `Example: ${cli} onboard sample --days 14 --json`,
        json: options.json,
        command: "onboard:sample",
        startedAtMs,
      });
      return;
    }

    const workspaceCheck = validateNonEmptyString(options.workspace, "workspace", { allowUndefined: true });
    if (!workspaceCheck.ok) {
      reportError(workspaceCheck.message, {
        code: ErrorCode.INVALID_INPUT,
        details: workspaceCheck.details,
        hint: `Example: ${cli} onboard sample --workspace . --json`,
        json: options.json,
        command: "onboard:sample",
        startedAtMs,
      });
      return;
    }

    const agentCheck = validateNonEmptyString(options.agent, "agent", { allowUndefined: true });
    if (!agentCheck.ok) {
      reportError(agentCheck.message, {
        code: ErrorCode.INVALID_INPUT,
        details: agentCheck.details,
        hint: `Example: ${cli} onboard sample --agent claude --json`,
        json: options.json,
        command: "onboard:sample",
        startedAtMs,
      });
      return;
    }

    const progressFormat = options.json ? "json" : "text";
    const sampleProgressRef: { current: ProgressReporter | null } = { current: null };
    const { sessions, totalFound, filtered } = await sampleDiverseSessions({
      limit: limitCheck.value,
      includeProcessed: options.includeProcessed,
      workspace: workspaceCheck.value,
      agent: agentCheck.value,
      days: daysCheck.value,
      fillGaps: options.fillGaps,
      gapAnalysis: options.fillGaps ? gapAnalysis : undefined,
      onProgress: (event) => {
        if (!sampleProgressRef.current) {
          sampleProgressRef.current = createProgress({
            message: event.message,
            total: event.total,
            showEta: true,
            format: progressFormat,
            stream: process.stderr,
          });
        }
        sampleProgressRef.current.update(event.current, event.message);
      },
    });

    sampleProgressRef.current?.complete("Sampling complete");
    sampleProgressRef.current = null;

    if (options.json) {
      printJsonResult("onboard:sample", {
        status,
        progress,
        step: "sample",
        sessions,
        totalFound,
        filtered,
        sessionsRemaining: sessions.length,
        gapAnalysis: options.fillGaps ? gapAnalysis : undefined,
      }, { startedAtMs });
    } else {
      const title = options.fillGaps
        ? "SAMPLED SESSIONS FOR GAP-FILLING"
        : "SAMPLED SESSIONS FOR ANALYSIS";
      console.log(chalk.bold(title));
      if (options.fillGaps) {
        const priorityCategories = gapAnalysis.gaps.critical.concat(gapAnalysis.gaps.underrepresented).slice(0, 3);
        if (priorityCategories.length > 0) {
          console.log(chalk.dim(`(prioritized for: ${priorityCategories.join(", ")})`));
        } else {
          console.log(chalk.dim("(no gaps to fill - using diverse sampling)"));
        }
      }
      if (filtered > 0) {
        console.log(chalk.dim(`(${filtered} already-processed sessions filtered out)`));
      }
      console.log("");

      if (sessions.length === 0) {
        console.log(chalk.yellow("No unprocessed sessions found."));
        if (progress.sessionsProcessed > 0) {
          console.log(chalk.dim(`You've analyzed ${progress.sessionsProcessed} sessions so far.`));
          console.log(chalk.dim(`Use --include-processed to see all sessions, or --reset to start over.`));
        }
      } else {
        for (const s of sessions) {
          console.log(chalk.cyan(`${agentIconPrefix(s.agent)}[${s.agent}] ${path.basename(s.workspace)}`));
          console.log(chalk.dim(`  ${s.path}`));
          if (options.fillGaps && s.gapScore !== undefined && s.gapScore > 0) {
            const cats = s.matchedCategories?.join(", ") || "";
            console.log(chalk.magenta(`  Gap score: ${s.gapScore} (${cats})`));
          }
          console.log(chalk.gray(`  "${s.snippet.slice(0, 80)}..."`));
          console.log("");
        }
        console.log(chalk.dim(`\nTo read a session: ${cli} onboard read <path>`));
      }
    }
    return;
  }

  // Read session
  if (options.read !== undefined) {
    const readCheck = validateNonEmptyString(options.read, "read", { trim: true });
    if (!readCheck.ok) {
      reportError(readCheck.message, {
        code: ErrorCode.INVALID_INPUT,
        details: readCheck.details,
        hint: `Example: ${cli} onboard read <path> --json`,
        json: options.json,
        command: options.template ? "onboard:read-template" : "onboard:read",
        startedAtMs,
      });
      return;
    }
    const progressFormat = options.json ? "json" : "text";
    const exportProgress = createProgress({
      message: "Exporting session...",
      format: progressFormat,
      stream: process.stderr,
    });
    exportProgress.update(0, "Exporting session...");
    const content = await exportSessionForAgent(readCheck.value);
    if (!content) {
      exportProgress.fail("Failed to export session");
    } else {
      exportProgress.complete("Session exported");
    }

    // Template mode: provide rich contextual output for agent extraction
    if (options.template) {
      if (!content) {
        reportError("Failed to read session", {
          code: ErrorCode.SESSION_NOT_FOUND,
          details: { sessionPath: readCheck.value },
          json: options.json,
          command: options.template ? "onboard:read-template" : "onboard:read",
          startedAtMs,
        });
        return;
      }

      // Extract metadata from session content
      const lines = content.split("\n");
      const messageCount = lines.filter(l => l.trim().length > 0).length;

      // Detect topics from session content (first ~5000 chars)
      const contentSnippet = content.slice(0, 5000);
      const topicHints = detectCategories(contentSnippet);

      // Find related rules using semantic search (if enabled)
      let relatedRules: Array<{ id: string; content: string; similarity: number }> = [];
      const activeBullets = getActiveBullets(playbook);
      if (config.semanticSearchEnabled && activeBullets.length > 0) {
        const relatedProgress = createProgress({
          message: "Searching for related rules...",
          format: progressFormat,
          stream: process.stderr,
        });
        relatedProgress.update(0, "Searching for related rules...");
        try {
          const matches = await findSimilarBulletsSemantic(
            contentSnippet,
            activeBullets,
            5,
            { model: config.embeddingModel }
          );
          relatedRules = matches
            .filter(m => m.similarity >= 0.3)
            .map(m => ({
              id: m.bullet.id,
              content: m.bullet.content,
              similarity: Math.round(m.similarity * 100) / 100,
            }));
          relatedProgress.complete(`Found ${relatedRules.length} related rule(s)`);
        } catch {
          relatedProgress.complete("Related rules unavailable");
          // Ignore semantic search errors
        }
      }

      // Generate suggested focus based on gaps and topics
      const suggestedFocus = generateSuggestedFocus(gapAnalysis, topicHints);

      // Parse workspace from session path
      const sessionDir = path.dirname(readCheck.value);
      const workspaceName = path.basename(sessionDir);

      const templateOutput = {
        metadata: {
          path: readCheck.value,
          agent: "unknown", // Would need to parse from content
          workspace: sessionDir,
          workspaceName,
          messageCount,
          topicHints,
        },
        context: {
          relatedRules,
          playbookGaps: {
            critical: gapAnalysis.gaps.critical,
            underrepresented: gapAnalysis.gaps.underrepresented,
          },
          suggestedFocus,
        },
        extractionFormat: {
          schema: { content: "string", category: "string" },
          categories: [...RULE_CATEGORIES],
          examples: EXAMPLE_RULES,
        },
        sessionContent: content,
      };

      if (options.json) {
        printJsonResult("onboard:read-template", templateOutput, { startedAtMs });
      } else {
        console.log(chalk.bold("SESSION ANALYSIS TEMPLATE"));
        console.log(chalk.dim(formatRule("─", { maxWidth: 60 })));
        console.log("");

        // Metadata
        console.log(chalk.bold("METADATA"));
        console.log(`  Path: ${options.read}`);
        console.log(`  Workspace: ${workspaceName}`);
        console.log(`  Messages: ~${messageCount}`);
        if (topicHints.length > 0) {
          console.log(`  Topics: ${topicHints.join(", ")}`);
        }
        console.log("");

        // Context
        console.log(chalk.bold("CONTEXT"));
        if (gapAnalysis.gaps.critical.length > 0) {
          console.log(chalk.red(`  Critical gaps: ${gapAnalysis.gaps.critical.join(", ")}`));
        }
        if (gapAnalysis.gaps.underrepresented.length > 0) {
          console.log(chalk.yellow(`  Low coverage: ${gapAnalysis.gaps.underrepresented.join(", ")}`));
        }
        if (relatedRules.length > 0) {
          console.log(chalk.cyan("  Related rules:"));
          for (const r of relatedRules.slice(0, 3)) {
            console.log(chalk.dim(`    • "${r.content.slice(0, 60)}..." (${Math.round(r.similarity * 100)}%)`));
          }
        }
        console.log("");

        // Suggested focus
        console.log(chalk.bold("SUGGESTED FOCUS"));
        console.log(chalk.yellow(`  ${suggestedFocus}`));
        console.log("");

        // Session content
        console.log(chalk.bold("SESSION CONTENT"));
        console.log(chalk.dim("─".repeat(60)));
        console.log(content);
        console.log(chalk.dim("─".repeat(60)));
        console.log("");

        // Instructions
        console.log(chalk.bold("EXTRACTION INSTRUCTIONS"));
        console.log(chalk.dim("After analyzing, add rules using:"));
        console.log(chalk.cyan(`  ${cli} playbook add "Your rule" --category "category"`));
        console.log(chalk.dim(`Or batch add via: ${cli} playbook add --file rules.json`));
      }
      return;
    }

    // Standard read (non-template)
    if (options.json) {
      printJsonResult("onboard:read", {
        status,
        step: "read",
        sessionPath: options.read,
        sessionContent: content,
        extractionPrompt: getExtractionPrompt(),
      }, { startedAtMs });
    } else {
      if (content) {
        console.log(chalk.bold(`SESSION: ${options.read}`));
        console.log(chalk.dim("─".repeat(60)));
        console.log(content);
        console.log(chalk.dim("─".repeat(60)));
        console.log("");
        console.log(chalk.yellow("Now analyze this session and extract rules using:"));
        console.log(chalk.cyan(`  ${cli} playbook add "Your rule" --category "category"`));
        console.log("");
        console.log(chalk.dim(`For extraction guidance: ${cli} onboard prompt`));
        console.log(chalk.dim(`For rich context: ${cli} onboard read <path> --template`));
      } else {
        console.error(chalk.red(`Failed to read session: ${options.read}`));
      }
    }
    return;
  }

  // Show extraction prompt
  if (options.prompt) {
    if (options.json) {
      printJsonResult("onboard:prompt", {
        status,
        step: "prompt",
        extractionPrompt: getExtractionPrompt(),
        categories: [...RULE_CATEGORIES],
        examples: EXAMPLE_RULES,
      }, { startedAtMs });
    } else {
      console.log(getExtractionPrompt());
    }
    return;
  }

  // Guided mode (default)
  if (options.json) {
    printJsonResult("onboard:guided", getGuidedOnboardingJson(cli, status), { startedAtMs });
  } else {
    const colored = getGuidedOnboardingText(cli, status)
      .replace(/^# (.+)$/gm, chalk.bold.blue("# $1"))
      .replace(/^## (.+)$/gm, chalk.bold.cyan("## $1"))
      .replace(/^### (.+)$/gm, chalk.bold("### $1"))
      .replace(/\*\*([^*]+)\*\*/g, chalk.bold("$1"));
    console.log(colored);
  }
}
