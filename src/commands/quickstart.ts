/**
 * quickstart command - Self-documentation for agents
 *
 * This command outputs a concise explanation of the cass-memory system
 * designed for consumption by AI coding agents. It explains:
 * - The ONE command agents need to use
 * - What NOT to do (avoid cognitive overload)
 * - The inline feedback format
 * - Example usage
 */

import chalk from "chalk";
import { getCliName, printJsonResult } from "../utils.js";

function getQuickstartText(cli: string): string {
  return `
# cass-memory Quick Start (for Agents)

## The One Command You Need

\`\`\`bash
${cli} context "<your task>" --json
\`\`\`

Run this before starting any non-trivial task. It returns:
- **relevantBullets**: Rules that may help with your task
- **antiPatterns**: Pitfalls to avoid
- **historySnippets**: Past sessions that solved similar problems
- **suggestedCassQueries**: Searches for deeper investigation

## What You Should Expect

- **Degraded mode is normal**: If \`cass\` is missing, not indexed, or times out, context still works but history may be disabled. Run \`${cli} doctor\` and follow recommended actions.
- **Privacy by default**: Cross-agent enrichment is **opt-in and off by default**. Check with \`${cli} privacy status\`.
- **Remote history (optional)**: If configured, \`historySnippets\` may include remote hits tagged with \`origin.kind="remote"\` and \`origin.host\` (agents can filter on this field).

## What You Usually DON'T Need To Do

- Run \`${cli} reflect\` manually in a well-configured setup. An operator typically schedules it (cron/hook). If learning is stale, ask an operator to run \`${cli} reflect --days 7 --json\` regularly.
- Run \`${cli} mark\` for feedback (prefer inline comments instead)
- Manually add rules to the playbook
- Worry about the learning pipeline

The system can learn from sessions automatically **once** reflection is scheduled.

## Solo Users (You're Both Agent AND Operator)

If you're working alone without scheduled reflection:

**Option A: Manual Reflection (Recommended)**
\`\`\`bash
# After completing significant work:
${cli} reflect --days 1 --json

# Weekly maintenance:
${cli} reflect --days 7 --json
\`\`\`

**Option B: Agent-Native Onboarding**
\`\`\`bash
# Check what sessions need analysis:
${cli} onboard status --json

# Sample sessions to review:
${cli} onboard sample --json

# Read a session for rule extraction:
${cli} onboard read <session-path> --json
\`\`\`

The system works without scheduled reflection - you just trigger learning manually.

## Inline Feedback (Optional)

When a rule helps or hurts, leave a comment:

\`\`\`typescript
// [cass: helpful b-8f3a2c] - this rule saved debugging time
// [cass: harmful b-x7k9p1] - this advice was wrong for our use case
\`\`\`

These are parsed automatically during reflection.

## Protocol

1. **START**: \`${cli} context "<task>" --json\` before non-trivial work
2. **WORK**: Reference rule IDs when following them
3. **FEEDBACK**: Leave inline comments when rules help/hurt
4. **END**: Just finish. Learning happens automatically once reflection is scheduled.

> **Operator note (humans):** Schedule \`${cli} reflect --days 7 --json\` (cron/hook). Use \`${cli} doctor\` when agents report missing history or degraded mode.

## Examples

\`\`\`bash
# Before implementing auth
${cli} context "implement JWT authentication" --json

# When stuck on a bug
${cli} context "fix memory leak in connection pool" --json

# Checking for past solutions
${cli} context "optimize database queries" --json
\`\`\`

## That's It

The system is designed to be zero-friction for agents:
- ONE command to query
- Inline comments for feedback
- Everything else is automated

For operator documentation: https://github.com/Dicklesworthstone/cass_memory_system
`.trim();
}

function getQuickstartJson(cli: string) {
  return {
    summary: "Procedural memory system for AI coding agents",
    oneCommand: `${cli} context "<task>" --json`,
    expectations: {
      degradedMode: `If cass is missing/not indexed, historySnippets may be empty; run ${cli} doctor for next steps.`,
      privacy: `Cross-agent enrichment is opt-in and off by default; check ${cli} privacy status.`,
      remoteHistory: `Optional: remote cass via SSH can add remote hits to historySnippets; filter by historySnippets[].origin.kind ("local"|"remote").`
    },
    whatItReturns: [
      "relevantBullets: Rules that may help",
      "antiPatterns: Pitfalls to avoid",
      "historySnippets: Past solutions (local + optional remote; see origin.kind/origin.host)",
      "suggestedCassQueries: Deeper searches"
    ],
    doNotDo: [
      `Run ${cli} reflect manually (operators typically schedule it)`,
      `Run ${cli} mark (use inline comments)`,
      "Manually add rules",
      "Worry about learning pipeline"
    ],
    operatorNote: {
      automation: `Schedule ${cli} reflect --days 7 --json (cron/hook).`,
      health: `Use ${cli} doctor when agents report missing history or degraded mode.`
    },
    soloUser: {
      description: "If you're both agent and operator without scheduled reflection",
      manualReflection: [
        `${cli} reflect --days 1 --json  # After significant work`,
        `${cli} reflect --days 7 --json  # Weekly maintenance`
      ],
      onboarding: [
        `${cli} onboard status --json   # Check progress`,
        `${cli} onboard sample --json   # Find sessions to analyze`,
        `${cli} onboard read <path> --json  # Read session for extraction`
      ]
    },
    inlineFeedbackFormat: {
      helpful: "// [cass: helpful <id>] - reason",
      harmful: "// [cass: harmful <id>] - reason"
    },
    protocol: {
      start: `${cli} context "<task>" --json`,
      work: "Reference rule IDs when following them",
      feedback: "Leave inline comments when rules help/hurt",
      end: "Just finish. Learning happens automatically once reflection is scheduled."
    },
    examples: [
      `${cli} context "implement JWT authentication" --json`,
      `${cli} context "fix memory leak in connection pool" --json`,
      `${cli} context "optimize database queries" --json`
    ]
  };
}

export async function quickstartCommand(flags: { json?: boolean }) {
  const startedAtMs = Date.now();
  const command = "quickstart";
  const cli = getCliName();
  if (flags.json) {
    printJsonResult(command, getQuickstartJson(cli), { startedAtMs });
  } else {
    // Colorize headers in terminal output
    const colored = getQuickstartText(cli)
      .replace(/^# (.+)$/gm, chalk.bold.blue("# $1"))
      .replace(/^## (.+)$/gm, chalk.bold.cyan("## $1"))
      .replace(/\*\*([^*]+)\*\*/g, chalk.bold("$1"));
    console.log(colored);
  }
}
