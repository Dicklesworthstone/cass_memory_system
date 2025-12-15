#!/usr/bin/env bun
import { Command } from "commander";
import chalk from "chalk";
import { getCliName, getVersion, printJsonError } from "./utils.js";
import { ErrorCode } from "./types.js";
import { initCommand } from "./commands/init.js";
import { contextCommand } from "./commands/context.js";
import { markCommand } from "./commands/mark.js";
import { playbookCommand } from "./commands/playbook.js";
import { statsCommand } from "./commands/stats.js";
import { doctorCommand } from "./commands/doctor.js";
import { reflectCommand } from "./commands/reflect.js";
import { validateCommand } from "./commands/validate.js";
import { forgetCommand } from "./commands/forget.js";
import { auditCommand } from "./commands/audit.js";
import { projectCommand } from "./commands/project.js";
import { serveCommand } from "./commands/serve.js";
import { outcomeCommand, applyOutcomeLogCommand } from "./commands/outcome.js";
import { usageCommand } from "./commands/usage.js";
import { startersCommand } from "./commands/starters.js";
import { quickstartCommand } from "./commands/quickstart.js";
import { topCommand } from "./commands/top.js";
import { staleCommand } from "./commands/stale.js";
import { whyCommand } from "./commands/why.js";
import { undoCommand } from "./commands/undo.js";
import { privacyCommand } from "./commands/privacy.js";
import { similarCommand } from "./commands/similar.js";
import { onboardCommand } from "./commands/onboard.js";

const program = new Command();
const toInt = (value: string) => parseInt(value, 10);
const toFloat = (value: string) => parseFloat(value);

program
  .name(getCliName())
  .description("Procedural memory for AI coding agents")
  .version(getVersion());

// --- Init ---
program.command("init")
  .description("Initialize configuration and playbook")
  .option("-f, --force", "Reinitialize config/playbook (creates backups)")
  .option("--yes", "Confirm overwriting existing files (required for --force in non-interactive/--json)")
  .option("--repo", "Initialize repo-level .cass/ directory structure")
  .option("--json", "Output JSON")
  .option("--no-interactive", "Disable interactive prompts")
  .option("--starter <name>", "Seed the playbook with a starter rule set")
  .action(async (opts: any) => await initCommand(opts));

// --- Context ---
program.command("context")
  .description("Get relevant rules and history for a task")
  .argument("<task>", "Description of the task to perform")
  .option("--json", "Output JSON")
  .option("--workspace <path>", "Filter by workspace")
  .option("--top <n>", "Number of rules to show", toInt)
  .option("--history <n>", "Number of history snippets", toInt)
  .option("--days <n>", "Lookback days for history", toInt)
  .option("--format <markdown|json>", "Force output format (overrides --json)")
  .option("--log-context", "Log context usage for implicit feedback")
  .option("--session <id>", "Optional session id to log with context")
  .action(async (task: string, opts: any) => await contextCommand(task, opts));

// --- Similar ---
program.command("similar")
  .description("Find similar bullets in the playbook for a query")
  .argument("<query>", "Query text to match against playbook bullets")
  .option("--limit <n>", "Number of results (default: 5)", toInt)
  .option("--threshold <t>", "Minimum similarity score 0-1 (default: 0.7)", toFloat)
  .option("--scope <scope>", "Filter by scope: global, workspace, all", "all")
  .option("--json", "Output JSON")
  .action(async (query: string, opts: any) => await similarCommand(query, opts));

// --- Mark ---
program.command("mark")
  .description("Record helpful/harmful feedback for a rule")
  .argument("<bulletId>", "ID of the rule")
  .option("--helpful", "Mark as helpful")
  .option("--harmful", "Mark as harmful")
  .option("--reason <reason>", "Reason: caused_bug|wasted_time|contradicted_requirements|wrong_context|outdated|other")
  .option("--session <path>", "Associated session path")
  .option("--json", "Output JSON")
  .action(async (id: string, opts: any) => await markCommand(id, opts));

// --- Playbook ---
const playbook = program.command("playbook")
  .description("Manage playbook rules");

playbook.command("list")
  .description("List active rules")
  .option("--category <cat>", "Filter by category")
  .option("--json", "Output JSON")
  .action(async (opts: any) => await playbookCommand("list", [], opts));

playbook.command("add")
  .description("Add a new rule (single or batch via --file)")
  .argument("[content]", "Rule content (required unless using --file)")
  .option("--category <cat>", "Category", "general")
  .option("--file <path>", "Batch add from JSON file (use '-' for stdin)")
  .option("--session <path>", "Session path to track in onboarding progress")
  .option("--check", "Show validation results before adding")
  .option("--strict", "With --check, fail on warnings instead of adding")
  .option("--json", "Output JSON")
  .action(async (content: string | undefined, opts: any) => {
    // If --file is provided, content is optional
    if (!opts.file && !content) {
      if (opts.json) {
        printJsonError("Content argument required unless using --file", {
          code: ErrorCode.MISSING_REQUIRED,
          details: { missing: "content", usage: "cm playbook add <content> [--file <path>]" },
        });
      } else {
        console.error("Error: content argument required unless using --file");
      }
      process.exitCode = 1;
      return;
    }
    await playbookCommand("add", content ? [content] : [], opts);
  });

playbook.command("remove")
  .description("Remove (deprecate) a rule")
  .argument("<id>", "Rule ID")
  .option("--hard", "Permanently delete")
  .option("--yes", "Confirm irreversible deletion (required for --hard in non-interactive mode)")
  .option("--dry-run", "Preview what would be removed without making changes")
  .option("--reason <text>", "Reason for removal")
  .option("--json", "Output JSON")
  .action(async (id: string, opts: any) => await playbookCommand("remove", [id], opts));

playbook.command("get")
  .description("Get detailed info for a single rule")
  .argument("<id>", "Rule ID")
  .option("--json", "Output JSON")
  .action(async (id: string, opts: any) => await playbookCommand("get", [id], opts));

playbook.command("export")
  .description("Export playbook for sharing")
  .option("--json", "Output as JSON (default: YAML)")
  .option("--yaml", "Output as YAML")
  .option("--all", "Include deprecated bullets")
  .action(async (opts: any) => await playbookCommand("export", [], opts));

playbook.command("import")
  .description("Import playbook from file")
  .argument("<file>", "Path to playbook file (YAML or JSON)")
  .option("--replace", "Replace existing bullets with same ID")
  .option("--json", "Output JSON result")
  .action(async (file: string, opts: any) => await playbookCommand("import", [file], opts));

// --- Stats ---
program.command("stats")
  .description("Show playbook health metrics")
  .option("--json", "Output JSON")
  .action(async (opts: any) => await statsCommand(opts));

// --- Top ---
program.command("top")
  .description("Show most effective playbook bullets")
  .argument("[count]", "Number of bullets to show", toInt, 10)
  .option("--scope <scope>", "Filter by scope (global, workspace, all)")
  .option("--category <cat>", "Filter by category")
  .option("--json", "Output JSON")
  .action(async (count: number, opts: any) => await topCommand(count, opts));

// --- Stale ---
program.command("stale")
  .description("Find bullets without recent feedback")
  .option("--days <n>", "Stale threshold in days", toInt, 90)
  .option("--scope <scope>", "Filter by scope (global, workspace, all)")
  .option("--json", "Output JSON")
  .action(async (opts: any) => await staleCommand(opts));

// --- Why ---
program.command("why")
  .description("Show bullet origin evidence and reasoning")
  .argument("<bulletId>", "ID of the bullet to explain")
  .option("--verbose", "Show full details including all sessions")
  .option("--json", "Output JSON")
  .action(async (id: string, opts: any) => await whyCommand(id, opts));

// --- Undo ---
program.command("undo")
  .description("Revert bad curation decisions (un-deprecate, undo feedback, delete)")
  .argument("<bulletId>", "ID of the bullet to undo")
  .option("--feedback", "Undo the most recent feedback event instead of un-deprecating")
  .option("--hard", "Permanently delete the bullet (cannot be undone)")
  .option("--yes", "Confirm irreversible deletion (required for --hard in non-interactive mode)")
  .option("--dry-run", "Preview what would change without making changes")
  .option("--json", "Output JSON")
  .action(async (id: string, opts: any) => await undoCommand(id, opts));

// --- Usage ---
program.command("usage")
  .description("Show LLM cost and usage statistics")
  .option("--json", "Output JSON")
  .action(async (opts: any) => await usageCommand(opts));

// --- Validate ---
program.command("validate")
  .description("Scientifically validate a proposed rule against history")
  .argument("<rule>", "Proposed rule text")
  .option("--json", "Output JSON")
  .option("--verbose", "Verbose output")
  .action(async (rule: string, opts: any) => await validateCommand(rule, opts));

// --- Doctor ---
program.command("doctor")
  .description("Check system health and optionally fix issues")
  .option("--json", "Output JSON")
  .option("--fix", "Automatically fix recoverable issues")
  .option("--dry-run", "Show what would change without applying fixes")
  .option("--force", "Allow cautious fixes (use with --fix)")
  .option("--no-interactive", "Disable interactive prompts (CI-safe)")
  .option("--self-test", "Run end-to-end self-test (slow)")
  .option("--full", "Run full doctor suite (alias for --self-test)")
  .action(async (opts: any) =>
    await doctorCommand({
      ...opts,
      selfTest: Boolean(opts.selfTest || opts.full),
    })
  );

// --- Reflect ---
program.command("reflect")
  .description("Process recent sessions to extract new rules")
  .option("--days <n>", "Lookback days", toInt)
  .option("--max-sessions <n>", "Max sessions to process", toInt)
  .option("--dry-run", "Show proposed changes without applying")
  .option("--workspace <path>", "Filter by workspace")
  .option("--json", "Output JSON")
  .option("--session <path>", "Process specific session file")
  .action(async (opts: any) => await reflectCommand(opts));

// --- Forget ---
program.command("forget")
  .description("Deprecate a rule and optionally add to blocked list")
  .argument("<bulletId>", "ID of the rule to forget")
  .option("--reason <text>", "Reason for forgetting (required)")
  .option("--invert", "Create inverted anti-pattern from the rule")
  .option("--json", "Output JSON")
  .action(async (id: string, opts: any) => await forgetCommand(id, opts));

// --- Audit ---
program.command("audit")
  .description("Audit recent sessions against playbook rules")
  .option("--days <n>", "Lookback days for sessions", toInt)
  .option("--workspace <path>", "Filter by workspace")
  .option("--json", "Output JSON")
  .action(async (opts: any) => await auditCommand(opts));

// --- Project ---
program.command("project")
  .description("Export playbook for project documentation")
  .option("--format <fmt>", "Output format: agents.md, claude.md, raw", "agents.md")
  .option("--output <path>", "Write to file instead of stdout")
  .option("--force", "Overwrite existing output file")
  .option("--top <n>", "Limit rules per category", toInt)
  .option("--show-counts", "Include helpful counts", true)
  .action(async (opts: any) => await projectCommand(opts));

// --- Starters ---
program.command("starters")
  .description("List available starter playbooks")
  .option("--json", "Output JSON")
  .action(async (opts: any) => await startersCommand(opts));

// --- Quickstart (agent self-documentation) ---
program.command("quickstart")
  .description("Explain the system to an agent (self-documentation)")
  .option("--json", "Output JSON")
  .action(async (opts: any) => await quickstartCommand(opts));

// --- Privacy ---
const privacy = program.command("privacy")
  .description("Privacy controls (cross-agent enrichment)");

privacy.command("status")
  .description("Show cross-agent settings and data flow summary")
  .option("--days <n>", "Lookback days for cass timeline stats", toInt)
  .option("--json", "Output JSON")
  .action(async (opts: any) => await privacyCommand("status", [], opts));

privacy.command("enable")
  .description("Enable cross-agent enrichment (requires explicit consent)")
  .argument("[agents...]", "Optional allowlist of agents (e.g., claude cursor codex aider)")
  .option("--json", "Output JSON")
  .action(async (agents: string[], opts: any) => await privacyCommand("enable", agents, opts));

privacy.command("disable")
  .description("Disable cross-agent enrichment")
  .option("--json", "Output JSON")
  .action(async (opts: any) => await privacyCommand("disable", [], opts));

privacy.command("allow")
  .description("Allow a specific agent for cross-agent enrichment")
  .argument("<agent>", "Agent name (e.g., claude, cursor, codex, aider)")
  .option("--json", "Output JSON")
  .action(async (agent: string, opts: any) => await privacyCommand("allow", [agent], opts));

privacy.command("deny")
  .description("Remove a specific agent from the allowlist")
  .argument("<agent>", "Agent name (e.g., claude, cursor, codex, aider)")
  .option("--json", "Output JSON")
  .action(async (agent: string, opts: any) => await privacyCommand("deny", [agent], opts));

// --- Serve (HTTP-only MCP surface) ---
program.command("serve")
  .description("Run HTTP MCP server for agent integration")
  .option("--port <n>", "Port to listen on", toInt, 8765)
  .option("--host <host>", "Host to bind", "127.0.0.1")
  .action(async (opts: any) => await serveCommand({ port: opts.port, host: opts.host }));

// --- Outcome ---
program.command("outcome")
  .description("Record implicit feedback from a session outcome for shown rules")
  .argument("<status>", "Outcome status: success|failure|mixed")
  .argument("<rules>", "Comma-separated rule ids that were shown")
  .option("--session <path>", "Session path for provenance")
  .option("--duration <seconds>", "Task duration in seconds", toInt)
  .option("--errors <count>", "Number of errors encountered", toInt)
  .option("--retries", "Whether there were retries")
  .option("--sentiment <sentiment>", "positive|negative|neutral")
  .option("--text <text>", "Session notes to auto-detect sentiment")
  .option("--json", "Output JSON")
  .action(async (status: string, rules: string, opts: any) => await outcomeCommand({ ...opts, status, rules }));

// --- Outcome Apply ---
program.command("outcome-apply")
  .description("Apply recorded outcomes to playbook feedback (implicit marks)")
  .option("--session <id>", "Apply only outcomes for this session id")
  .option("--limit <n>", "Max outcomes to load (default 50)", toInt)
  .option("--json", "Output JSON")
  .action(async (opts: any) => await applyOutcomeLogCommand(opts));

// --- Onboard (agent-native guided onboarding) ---
const onboard = program.command("onboard")
  .description("Agent-native guided onboarding (no API costs)");

onboard.command("status")
  .description("Check onboarding status and progress")
  .option("--json", "Output JSON")
  .action(async (opts: any) => await onboardCommand({ ...opts, status: true }));

onboard.command("gaps")
  .description("Show playbook category gap analysis")
  .option("--json", "Output JSON")
  .action(async (opts: any) => await onboardCommand({ ...opts, gaps: true }));

onboard.command("sample")
  .description("Sample diverse sessions for analysis")
  .option("--limit <n>", "Number of sessions to sample", toInt)
  .option("--fill-gaps", "Prioritize sessions for underrepresented categories")
  .option("--include-processed", "Include already-processed sessions")
  .option("--workspace <path>", "Filter by workspace")
  .option("--agent <name>", "Filter by agent (claude, cursor, etc)")
  .option("--days <n>", "Filter to last N days", toInt)
  .option("--json", "Output JSON")
  .action(async (opts: any) => await onboardCommand({ ...opts, sample: true }));

onboard.command("read")
  .description("Read/export a session for analysis")
  .argument("<path>", "Session path to read")
  .option("--template", "Rich contextual output for extraction")
  .option("--json", "Output JSON")
  .action(async (sessionPath: string, opts: any) => await onboardCommand({ ...opts, read: sessionPath }));

onboard.command("prompt")
  .description("Show extraction instructions for agent")
  .option("--json", "Output JSON")
  .action(async (opts: any) => await onboardCommand({ ...opts, prompt: true }));

onboard.command("guided")
  .description("Show full guided onboarding workflow")
  .option("--json", "Output JSON")
  .action(async (opts: any) => await onboardCommand({ ...opts, guided: true }));

onboard.command("mark-done")
  .description("Mark a session as processed without extracting rules")
  .argument("<path>", "Session path to mark as done")
  .option("--json", "Output JSON")
  .action(async (sessionPath: string, opts: any) => await onboardCommand({ ...opts, markDone: sessionPath }));

onboard.command("reset")
  .description("Reset onboarding progress (start fresh)")
  .option("--yes", "Confirm without prompting")
  .option("--json", "Output JSON")
  .action(async (opts: any) => await onboardCommand({ ...opts, reset: true }));

/**
 * Detect if --json flag is present in argv (before commander parses).
 * Used for error formatting.
 */
function hasJsonFlag(): boolean {
  return process.argv.includes("--json") || process.argv.includes("-j");
}

function formatMainHelpBanner(cli: string): string {
  return [
    "Start here (agents):",
    `  ${cli} context "<task>" --json`,
    "",
    "Then:",
    `  ${cli} quickstart --json`,
  ].join("\n");
}

function formatMainHelpEpilog(cli: string): string {
  return `

Examples:
  ${cli} context "fix the authentication timeout bug" --json
  ${cli} init
  ${cli} doctor --fix
  ${cli} playbook list
  ${cli} reflect --days 7 --json

Command groups:
  Agent workflow: context, quickstart, similar
  Operator/maintenance: init, doctor, reflect, playbook, stats, project, privacy, starters
  Advanced/rare: serve, outcome, outcome-apply, audit, validate

Tip: ${cli} <command> --help
`.trimEnd();
}

/**
 * Format error for CLI output.
 * In JSON mode: structured JSON to stdout with exit code.
 * In human mode: colored error to stderr.
 */
function handleError(error: unknown): never {
  const cliName = getCliName();
  const message = error instanceof Error ? error.message : String(error);

  if (hasJsonFlag()) {
    // JSON mode: structured error object to stdout for parseability
    printJsonError(message, { code: ErrorCode.INTERNAL_ERROR });
  } else {
    // Human mode: colored error to stderr
    console.error(`${chalk.red(`${cliName}: error:`)} ${message}`);
  }

  process.exit(1);
}

program.showSuggestionAfterError(true);
if (!hasJsonFlag()) {
  program.showHelpAfterError("(add --help for additional information)");
}

program.addHelpText("before", ({ command }) => `${formatMainHelpBanner(command.name())}\n`);
program.addHelpText("after", ({ command }) => `${formatMainHelpEpilog(command.name())}\n`);

// Use parseAsync for proper async error handling
program.parseAsync().catch(handleError);
