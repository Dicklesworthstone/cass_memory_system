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

const QUICKSTART_TEXT = `
# cass-memory Quick Start (for Agents)

## The One Command You Need

\`\`\`bash
cm context "<your task>" --json
\`\`\`

Run this before starting any non-trivial task. It returns:
- **relevantBullets**: Rules that may help with your task
- **antiPatterns**: Pitfalls to avoid
- **historySnippets**: Past sessions that solved similar problems
- **suggestedCassQueries**: Searches for deeper investigation

## What You DON'T Need To Do

- Run \`cm reflect\` (automation handles this)
- Run \`cm mark\` for feedback (use inline comments instead)
- Manually add rules to the playbook
- Worry about the learning pipeline

The system learns from your sessions automatically.

## Inline Feedback (Optional)

When a rule helps or hurts, leave a comment:

\`\`\`typescript
// [cass: helpful b-8f3a2c] - this rule saved debugging time
// [cass: harmful b-x7k9p1] - this advice was wrong for our use case
\`\`\`

These are parsed automatically during reflection.

## Protocol

1. **START**: \`cm context "<task>" --json\` before non-trivial work
2. **WORK**: Reference rule IDs when following them
3. **FEEDBACK**: Leave inline comments when rules help/hurt
4. **END**: Just finish. Learning happens automatically.

## Examples

\`\`\`bash
# Before implementing auth
cm context "implement JWT authentication" --json

# When stuck on a bug
cm context "fix memory leak in connection pool" --json

# Checking for past solutions
cm context "optimize database queries" --json
\`\`\`

## That's It

The system is designed to be zero-friction for agents:
- ONE command to query
- Inline comments for feedback
- Everything else is automated

For operator documentation: https://github.com/Dicklesworthstone/cass_memory_system
`.trim();

const QUICKSTART_JSON = {
  summary: "Procedural memory system for AI coding agents",
  oneCommand: 'cm context "<task>" --json',
  whatItReturns: [
    "relevantBullets: Rules that may help",
    "antiPatterns: Pitfalls to avoid",
    "historySnippets: Past solutions",
    "suggestedCassQueries: Deeper searches"
  ],
  doNotDo: [
    "Run cm reflect (automated)",
    "Run cm mark (use inline comments)",
    "Manually add rules",
    "Worry about learning pipeline"
  ],
  inlineFeedbackFormat: {
    helpful: "// [cass: helpful <id>] - reason",
    harmful: "// [cass: harmful <id>] - reason"
  },
  protocol: {
    start: 'cm context "<task>" --json',
    work: "Reference rule IDs when following them",
    feedback: "Leave inline comments when rules help/hurt",
    end: "Just finish. Learning is automatic."
  },
  examples: [
    'cm context "implement JWT authentication" --json',
    'cm context "fix memory leak in connection pool" --json',
    'cm context "optimize database queries" --json'
  ]
};

export async function quickstartCommand(flags: { json?: boolean }) {
  if (flags.json) {
    console.log(JSON.stringify(QUICKSTART_JSON, null, 2));
  } else {
    // Colorize headers in terminal output
    const colored = QUICKSTART_TEXT
      .replace(/^# (.+)$/gm, chalk.bold.blue("# $1"))
      .replace(/^## (.+)$/gm, chalk.bold.cyan("## $1"))
      .replace(/\*\*([^*]+)\*\*/g, chalk.bold("$1"));
    console.log(colored);
  }
}
