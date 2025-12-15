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
import { loadMergedPlaybook } from "../playbook.js";
import { cassSearch, cassExport, handleCassUnavailable, CassSearchOptions } from "../cass.js";
import { getCliName, expandPath } from "../utils.js";
import { formatKv, formatRule, getOutputStyle } from "../output.js";
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
}

interface OnboardJsonOutput {
  status: OnboardStatus;
  step?: string;
  sessions?: SessionSample[];
  sessionContent?: string;
  extractionPrompt?: string;
  categories?: string[];
  examples?: { rule: string; category: string }[];
}

const RULE_CATEGORIES = [
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
];

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

  let totalConversations = 0;
  let totalMessages = 0;

  if (availability.canContinue && availability.fallbackMode === "none") {
    try {
      // Get cass stats by searching with a broad query
      const hits = await cassSearch("*", { limit: 1 }, availability.resolvedCassPath || "cass");
      // We can't get exact stats from search, so estimate based on doctor info
      // This is a simplified approach
      totalConversations = 100; // Placeholder - would need cass stats command
      totalMessages = 1000;
    } catch {
      // Ignore errors
    }
  }

  const playbookRules = playbook.bullets.filter(b => b.state !== "retired" && !b.deprecated).length;
  const onboardingRatio = totalConversations > 0 ? (playbookRules / totalConversations) * 100 : 0;
  const needsOnboarding = playbookRules < 20 && totalConversations > 10;

  let recommendation: string;
  if (!availability.canContinue || availability.fallbackMode === "playbook-only") {
    recommendation = "Install cass first to enable historical session analysis";
  } else if (playbookRules === 0) {
    recommendation = "Your playbook is empty! Run `cm onboard --guided` to start extracting rules";
  } else if (playbookRules < 10) {
    recommendation = "Your playbook has few rules. Run `cm onboard --guided` to add more";
  } else if (playbookRules < 50) {
    recommendation = "Consider running `cm onboard --sample` to find more patterns";
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

async function sampleDiverseSessions(limit: number = 10): Promise<SessionSample[]> {
  const config = await loadConfig();
  const queries = [
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

  const sessions: Map<string, SessionSample> = new Map();

  for (const query of queries) {
    if (sessions.size >= limit) break;

    try {
      const hits = await cassSearch(query, { limit: 3, days: 90 }, config.cassPath);
      for (const hit of hits) {
        if (sessions.size >= limit) break;
        if (!sessions.has(hit.source_path)) {
          sessions.set(hit.source_path, {
            path: hit.source_path,
            agent: hit.agent,
            workspace: hit.workspace || path.dirname(hit.source_path),
            snippet: hit.snippet,
            score: hit.score,
          });
        }
      }
    } catch {
      // Ignore search errors
    }
  }

  return Array.from(sessions.values());
}

async function exportSessionForAgent(sessionPath: string): Promise<string | null> {
  const config = await loadConfig();
  try {
    return await cassExport(sessionPath, "text", config.cassPath, config);
  } catch {
    return null;
  }
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

For each rule you identify, add it using:

\`\`\`bash
cm playbook add "Your rule content" --category "category"
\`\`\`
`.trim();
}

function getGuidedOnboardingText(cli: string, status: OnboardStatus): string {
  return `
# Agent-Native Onboarding Guide

${chalk.bold("Current Status:")}
${status.cassAvailable ? chalk.green("✓ cass available") : chalk.red("✗ cass not available")}
${chalk.cyan(`Playbook rules: ${status.playbookRules}`)}

${chalk.bold.yellow(status.recommendation)}

---

## How This Works

Instead of using expensive LLM APIs, **you** (the coding agent) do the reflection work.
This is "free" since you're already being paid for via Claude Max/GPT Pro.

## Step-by-Step Process

### Step 1: Sample Sessions
\`\`\`bash
${cli} onboard --sample --json
\`\`\`
This returns diverse sessions from your cass history to analyze.

### Step 2: Read a Session
\`\`\`bash
${cli} onboard --read <session-path>
\`\`\`
This exports the session content for you to analyze.

### Step 3: Extract Rules
Read the session content and identify reusable patterns.
Use the extraction prompt (\`${cli} onboard --prompt\`) for guidance.

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
| \`${cli} onboard --status\` | Check onboarding status |
| \`${cli} onboard --sample\` | Get sessions to analyze |
| \`${cli} onboard --read <path>\` | Read a session |
| \`${cli} onboard --prompt\` | Get extraction instructions |
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
    categories: RULE_CATEGORIES,
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
  } = {}
): Promise<void> {
  const cli = getCliName();
  const status = await getOnboardStatus();

  // Status check
  if (options.status) {
    if (options.json) {
      console.log(JSON.stringify({ status }, null, 2));
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
      console.log("");
      console.log(chalk.yellow(status.recommendation));
    }
    return;
  }

  // Sample sessions
  if (options.sample) {
    const sessions = await sampleDiverseSessions(options.limit || 10);
    if (options.json) {
      console.log(JSON.stringify({ status, step: "sample", sessions }, null, 2));
    } else {
      console.log(chalk.bold("SAMPLED SESSIONS FOR ANALYSIS"));
      console.log("");
      for (const s of sessions) {
        console.log(chalk.cyan(`[${s.agent}] ${path.basename(s.workspace)}`));
        console.log(chalk.dim(`  ${s.path}`));
        console.log(chalk.gray(`  "${s.snippet.slice(0, 80)}..."`));
        console.log("");
      }
      console.log(chalk.dim(`\nTo read a session: ${cli} onboard --read <path>`));
    }
    return;
  }

  // Read session
  if (options.read) {
    const content = await exportSessionForAgent(options.read);
    if (options.json) {
      console.log(JSON.stringify({
        status,
        step: "read",
        sessionPath: options.read,
        sessionContent: content,
        extractionPrompt: getExtractionPrompt(),
      }, null, 2));
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
        console.log(chalk.dim(`For extraction guidance: ${cli} onboard --prompt`));
      } else {
        console.error(chalk.red(`Failed to read session: ${options.read}`));
      }
    }
    return;
  }

  // Show extraction prompt
  if (options.prompt) {
    if (options.json) {
      console.log(JSON.stringify({
        status,
        step: "prompt",
        extractionPrompt: getExtractionPrompt(),
        categories: RULE_CATEGORIES,
        examples: EXAMPLE_RULES,
      }, null, 2));
    } else {
      console.log(getExtractionPrompt());
    }
    return;
  }

  // Guided mode (default)
  if (options.json) {
    console.log(JSON.stringify(getGuidedOnboardingJson(cli, status), null, 2));
  } else {
    const colored = getGuidedOnboardingText(cli, status)
      .replace(/^# (.+)$/gm, chalk.bold.blue("# $1"))
      .replace(/^## (.+)$/gm, chalk.bold.cyan("## $1"))
      .replace(/^### (.+)$/gm, chalk.bold("### $1"))
      .replace(/\*\*([^*]+)\*\*/g, chalk.bold("$1"));
    console.log(colored);
  }
}
