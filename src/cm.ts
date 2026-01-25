#!/usr/bin/env bun
import { Command } from "commander";
import { categorizeError, getCliName, getVersion, reportError } from "./utils.js";
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
import { guardCommand } from "./commands/guard.js";
import { traumaCommand } from "./commands/trauma.js";
import { infoCommand } from "./info.js";
import { examplesCommand } from "./examples.js";

import { releaseAllLocks } from "./lock.js";

// Global signal handlers for cleanup
async function gracefulExit(signal: string) {
  await releaseAllLocks();
  process.exit(128 + (signal === "SIGINT" ? 2 : 15));
}

process.on("SIGINT", () => gracefulExit("SIGINT"));
process.on("SIGTERM", () => gracefulExit("SIGTERM"));

export function createProgram(argv: string[] = process.argv): Command {
  applyGlobalEnvFromArgv(argv);

  const program = new Command();
  const toInt = (value: string): number => {
    const raw = value.trim();
    if (!raw) return Number.NaN;
    if (!/^-?\d+$/.test(raw)) return Number.NaN;
    return Number.parseInt(raw, 10);
  };
  const toFloat = (value: string): number => {
    const raw = value.trim();
    if (!raw) return Number.NaN;
    if (!/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw)) return Number.NaN;
    return Number.parseFloat(raw);
  };

  program
    .name(getCliName())
    .description("Procedural memory for AI coding agents")
    .version(getVersion())
    .option("--no-color", "Disable ANSI colors (also respects NO_COLOR)")
    .option("--no-emoji", "Disable emoji/icons (also respects CASS_MEMORY_NO_EMOJI)")
    .option("--width <n>", "Override output width (default: terminal columns)", toInt)
    .option("--verbose", "Enable verbose diagnostics (sets CASS_MEMORY_VERBOSE=1)")
    .option("--info", "Show version, config paths, environment, and dependencies")
    .option("--examples", "Show curated workflow examples");

// --- Init ---
program.command("init")
  .description("Initialize configuration and playbook")
  .option("-f, --force", "Reinitialize config/playbook (creates backups)")
  .option("--yes", "Confirm overwriting existing files (required for --force in non-interactive/--json)")
  .option("--repo", "Initialize repo-level .cass/ directory structure")
  .option("-j, --json", "Output JSON")
  .option("--no-interactive", "Disable interactive prompts")
  .option("--starter <name>", "Seed the playbook with a starter rule set")
  .addHelpText("after", () =>
    formatCommandExamples([
      "init",
      "init --starter typescript",
      "init --repo",
      "init --force --yes --json",
    ])
  )
  .action(async (opts: any) => await initCommand(opts));

// --- Context ---
program.command("context")
  .alias("ctx")
  .description("Get relevant rules and history for a task")
  .argument("<task>", "Description of the task to perform")
  .option("-j, --json", "Output JSON")
  .option("--workspace <path>", "Filter by workspace")
  .option("--limit <n>", "Number of rules to show", toInt)
  .option("--top <n>", "DEPRECATED: use --limit", toInt)
  .option("--history <n>", "Number of history snippets", toInt)
  .option("--days <n>", "Lookback days for history", toInt)
  .option("--format <markdown|json|toon>", "Force output format (overrides --json). TOON provides token-efficient output.")
  .option("--stats", "Show token statistics on stderr (JSON vs TOON)")
  .option("--log-context", "Log context usage for implicit feedback")
  .option("--session <id>", "Optional session id to log with context")
  .addHelpText("after", () =>
    formatCommandExamples([
      "context \"implement user authentication\" --json",
      "context \"fix the login bug\" --limit 10 --days 30 --json",
      "context \"refactor utils\" --workspace . --json",
      "context \"write tests\" --format markdown",
      "context \"summarize prior decisions\" --format toon --stats",
    ])
  )
  .action(async (task: string, opts: any) => await contextCommand(task, opts));

// --- Similar ---
program.command("similar")
  .description("Find similar bullets in the playbook for a query")
  .argument("<query>", "Query text to match against playbook bullets")
  .option("--limit <n>", "Number of results (default: 5)", toInt)
  .option("--threshold <t>", "Minimum similarity score 0-1 (default: 0.7)", toFloat)
  .option("--scope <scope>", "Filter by scope: global, workspace, all", "all")
  .option("-j, --json", "Output JSON")
  .option("--format <json|toon>", "Output format: json or toon (overrides --json)")
  .option("--stats", "Show token statistics on stderr (JSON vs TOON)")
  .addHelpText("after", () =>
    formatCommandExamples([
      "similar \"jwt authentication errors\" --json",
      "similar \"rate limit handling\" --limit 10 --threshold 0.8 --json",
      "similar \"repo build pipeline\" --scope workspace --json",
      "similar \"rate limit handling\" --format toon --stats",
    ])
  )
  .action(async (query: string, opts: any) => await similarCommand(query, opts));

// --- Mark ---
program.command("mark")
  .description("Record helpful/harmful feedback for a rule")
  .argument("<bulletId>", "ID of the rule")
  .option("--helpful", "Mark as helpful")
  .option("--harmful", "Mark as harmful")
  .option("--reason <reason>", "Optional reason/note (free text, or one of: caused_bug|wasted_time|contradicted_requirements|wrong_context|outdated|other)")
  .option("--session <path>", "Associated session path")
  .option("-j, --json", "Output JSON")
  .addHelpText("after", () =>
    formatCommandExamples([
      "mark b-abc123 --helpful --json",
      "mark b-abc123 --harmful --reason caused_bug --json",
      "mark b-abc123 --helpful --session /path/to/session.jsonl --json",
    ])
  )
  .action(async (id: string, opts: any) => await markCommand(id, opts));

// --- Playbook ---
const playbook = program.command("playbook")
  .description("Manage playbook rules")
  .addHelpText("after", () =>
    formatCommandExamples([
      "playbook list",
      "playbook add \"Always validate input\" --category security",
      "playbook get b-abc123 --json",
      "playbook export --json > playbook.json",
      "playbook import playbook.json --replace --json",
    ])
  );

playbook.command("list")
  .alias("ls")
  .description("List active rules")
  .option("--category <cat>", "Filter by category")
  .option("-j, --json", "Output JSON")
  .option("--format <json|toon>", "Output format: json or toon (overrides --json)")
  .option("--stats", "Show token statistics on stderr (JSON vs TOON)")
  .addHelpText("after", () =>
    formatCommandExamples([
      "playbook list",
      "playbook list --category security",
      "playbook list --json",
      "playbook list --format toon --stats",
    ])
  )
  .action(async (opts: any) => await playbookCommand("list", [], opts));

playbook.command("add")
  .description("Add a new rule (single or batch via --file)")
  .argument("[content]", "Rule content (required unless using --file)")
  .option("--category <cat>", "Category", "general")
  .option("--file <path>", "Batch add from JSON file (use '-' for stdin)")
  .option("--session <path>", "Session path to track in onboarding progress")
  .option("--check", "Show validation results before adding")
  .option("--strict", "With --check, fail on warnings instead of adding")
  .option("-j, --json", "Output JSON")
  .addHelpText("after", () =>
    formatCommandExamples([
      "playbook add \"Always validate user input\" --category security --json",
      "playbook add --file rules.json --check --json",
      "playbook add --file - --json",
    ])
  )
  .action(async (content: string | undefined, opts: any) => {
    // If --file is provided, content is optional
    if (!opts.file && !content) {
      reportError("Content argument required unless using --file", {
        code: ErrorCode.MISSING_REQUIRED,
        details: { missing: "content", usage: "cm playbook add <content> [--file <path>]" },
        json: opts.json,
      });
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
  .option("-j, --json", "Output JSON")
  .addHelpText("after", () =>
    formatCommandExamples([
      "playbook remove b-abc123 --reason \"Outdated\" --json",
      "playbook remove b-abc123 --dry-run --json",
      "playbook remove b-abc123 --hard --yes --json",
    ])
  )
  .action(async (id: string, opts: any) => await playbookCommand("remove", [id], opts));

playbook.command("get")
  .description("Get detailed info for a single rule")
  .argument("<id>", "Rule ID")
  .option("-j, --json", "Output JSON")
  .addHelpText("after", () =>
    formatCommandExamples([
      "playbook get b-abc123",
      "playbook get b-abc123 --json",
      "playbook get b-abc123 --json > bullet.json",
    ])
  )
  .action(async (id: string, opts: any) => await playbookCommand("get", [id], opts));

playbook.command("export")
  .description("Export playbook for sharing")
  .option("-j, --json", "Output as JSON (default: YAML)")
  .option("--yaml", "Output as YAML")
  .option("--all", "Include deprecated bullets")
  .addHelpText("after", () =>
    formatCommandExamples([
      "playbook export > playbook.yaml",
      "playbook export --json > playbook.json",
      "playbook export --all --json > playbook-all.json",
    ])
  )
  .action(async (opts: any) => await playbookCommand("export", [], opts));

playbook.command("import")
  .description("Import playbook from file")
  .argument("<file>", "Path to playbook file (YAML or JSON)")
  .option("--replace", "Replace existing bullets with same ID")
  .option("--repo", "Import to repo-level playbook instead of global")
  .option("-j, --json", "Output JSON result")
  .addHelpText("after", () =>
    formatCommandExamples([
      "playbook import playbook.yaml --json",
      "playbook import playbook.json --replace --json",
      "playbook import playbook.json",
    ])
  )
  .action(async (file: string, opts: any) => await playbookCommand("import", [file], opts));

// --- Common Aliases (top-level shortcuts) ---
program.command("ls")
  .description("Alias for `cm playbook list`")
  .option("--category <cat>", "Filter by category")
  .option("-j, --json", "Output JSON")
  .addHelpText("after", () =>
    formatCommandExamples([
      "ls",
      "ls --category security",
      "ls --json",
    ])
  )
  .action(async (opts: any) => await playbookCommand("list", [], opts));

program.command("add")
  .description("Alias for `cm playbook add`")
  .argument("[content]", "Rule content (required unless using --file)")
  .option("--category <cat>", "Category", "general")
  .option("--file <path>", "Batch add from JSON file (use '-' for stdin)")
  .option("--session <path>", "Session path to track in onboarding progress")
  .option("--check", "Show validation results before adding")
  .option("--strict", "With --check, fail on warnings instead of adding")
  .option("-j, --json", "Output JSON")
  .addHelpText("after", () =>
    formatCommandExamples([
      "add \"Always validate user input\" --category security --json",
      "add --file rules.json --check --json",
      "add --file - --json",
    ])
  )
  .action(async (content: string | undefined, opts: any) => {
    if (!opts.file && !content) {
      reportError("Content argument required unless using --file", {
        code: ErrorCode.MISSING_REQUIRED,
        details: { missing: "content", usage: "cm add <content> [--file <path>]" },
        json: opts.json,
      });
      return;
    }
    await playbookCommand("add", content ? [content] : [], opts);
  });

program.command("rm")
  .description("Alias for `cm playbook remove`")
  .argument("<id>", "Rule ID")
  .option("--hard", "Permanently delete")
  .option("--yes", "Confirm irreversible deletion (required for --hard in non-interactive mode)")
  .option("--dry-run", "Preview what would be removed without making changes")
  .option("--reason <text>", "Reason for removal")
  .option("-j, --json", "Output JSON")
  .addHelpText("after", () =>
    formatCommandExamples([
      "rm b-abc123 --reason \"Outdated\" --json",
      "rm b-abc123 --dry-run --json",
      "rm b-abc123 --hard --yes --json",
    ])
  )
  .action(async (id: string, opts: any) => await playbookCommand("remove", [id], opts));

// --- Stats ---
program.command("stats")
  .description("Show playbook health metrics")
  .option("-j, --json", "Output JSON")
  .option("--format <json|toon>", "Output format: json or toon (overrides --json)")
  .option("--stats", "Show token statistics on stderr (JSON vs TOON)")
  .addHelpText("after", () =>
    formatCommandExamples([
      "stats",
      "stats --json",
      "stats --json > stats.json",
      "stats --format toon --stats",
    ])
  )
  .action(async (opts: any) => await statsCommand(opts));

// --- Top ---
program.command("top")
  .description("Show most effective playbook bullets")
  .argument("[count]", "Number of bullets to show", toInt, 10)
  .option("--scope <scope>", "Filter by scope (global, workspace, all)")
  .option("--category <cat>", "Filter by category")
  .option("-j, --json", "Output JSON")
  .addHelpText("after", () =>
    formatCommandExamples([
      "top",
      "top 5 --json",
      "top 10 --scope workspace --category security --json",
    ])
  )
  .action(async (count: number, opts: any) => await topCommand(count, opts));

// --- Stale ---
program.command("stale")
  .description("Find bullets without recent feedback")
  .option("--days <n>", "Stale threshold in days", toInt, 90)
  .option("--scope <scope>", "Filter by scope (global, workspace, all)")
  .option("-j, --json", "Output JSON")
  .addHelpText("after", () =>
    formatCommandExamples([
      "stale --days 90 --json",
      "stale --days 30 --scope workspace --json",
      "stale --days 0 --json",
    ])
  )
  .action(async (opts: any) => await staleCommand(opts));

// --- Why ---
program.command("why")
  .description("Show bullet origin evidence and reasoning")
  .argument("<bulletId>", "ID of the bullet to explain")
  .option("--verbose", "Show full details including all sessions")
  .option("-j, --json", "Output JSON")
  .addHelpText("after", () =>
    formatCommandExamples([
      "why b-abc123",
      "why b-abc123 --json",
      "why b-abc --json",
    ])
  )
  .action(async (id: string, opts: any) => await whyCommand(id, opts));

// --- Undo ---
program.command("undo")
  .description("Revert bad curation decisions (un-deprecate, undo feedback, delete)")
  .argument("<bulletId>", "ID of the bullet to undo")
  .option("--feedback", "Undo the most recent feedback event instead of un-deprecating")
  .option("--hard", "Permanently delete the bullet (cannot be undone)")
  .option("--yes", "Confirm irreversible deletion (required for --hard in non-interactive mode)")
  .option("--dry-run", "Preview what would change without making changes")
  .option("-j, --json", "Output JSON")
  .addHelpText("after", () =>
    formatCommandExamples([
      "undo b-abc123 --json",
      "undo b-abc123 --feedback --json",
      "undo b-abc123 --hard --yes --json",
      "undo b-abc123 --dry-run --json",
    ])
  )
  .action(async (id: string, opts: any) => await undoCommand(id, opts));

// --- Usage ---
program.command("usage")
  .description("Show LLM cost and usage statistics")
  .option("-j, --json", "Output JSON")
  .addHelpText("after", () =>
    formatCommandExamples([
      "usage",
      "usage --json",
      "usage --json > usage.json",
    ])
  )
  .action(async (opts: any) => await usageCommand(opts));

// --- Validate ---
program.command("validate")
  .description("Scientifically validate a proposed rule against history")
  .argument("<rule>", "Proposed rule text")
  .option("-j, --json", "Output JSON")
  .option("--verbose", "Verbose output")
  .addHelpText("after", () =>
    formatCommandExamples([
      "validate \"Always check user input before processing\"",
      "validate \"Prefer atomic writes for config files\" --json",
      "validate \"Avoid global mutable state\" --verbose",
    ])
  )
  .action(async (rule: string, opts: any) => await validateCommand(rule, opts));

// --- Doctor ---
program.command("doctor")
  .alias("dr")
  .description("Check system health and optionally fix issues")
  .option("-j, --json", "Output JSON")
  .option("--format <json|toon>", "Output format: json or toon (overrides --json)")
  .option("--fix", "Automatically fix recoverable issues")
  .option("--dry-run", "Show what would change without applying fixes")
  .option("--force", "Allow cautious fixes (use with --fix)")
  .option("--no-interactive", "Disable interactive prompts (CI-safe)")
  .option("--self-test", "Run end-to-end self-test (slow)")
  .option("--full", "Run full doctor suite (alias for --self-test)")
  .addHelpText("after", () =>
    formatCommandExamples([
      "doctor",
      "doctor --fix",
      "doctor --fix --dry-run --json",
      "doctor --self-test --json",
    ])
  )
  .action(async (opts: any) =>
    await doctorCommand({
      ...opts,
      selfTest: Boolean(opts.selfTest || opts.full),
    })
  );

// --- Reflect ---
program.command("reflect")
  .alias("ref")
  .description("Process recent sessions to extract new rules")
  .option("--days <n>", "Lookback days", toInt)
  .option("--max-sessions <n>", "Max sessions to process", toInt)
  .option("--dry-run", "Show proposed changes without applying")
  .option("--workspace <path>", "Filter by workspace")
  .option("-j, --json", "Output JSON")
  .option("--session <path>", "Process specific session file")
  .addHelpText("after", () =>
    formatCommandExamples([
      "reflect --days 7 --json",
      "reflect --session /path/to/session.jsonl --json",
      "reflect --dry-run --json",
    ])
  )
  .action(async (opts: any) => await reflectCommand(opts));

// --- Forget ---
program.command("forget")
  .description("Deprecate a rule and optionally add to blocked list")
  .argument("<bulletId>", "ID of the rule to forget")
  .option("--reason <text>", "Reason for forgetting (required)")
  .option("--invert", "Create inverted anti-pattern from the rule")
  .option("-j, --json", "Output JSON")
  .addHelpText("after", () =>
    formatCommandExamples([
      "forget b-abc123 --reason \"Superseded\"",
      "forget b-abc123 --reason \"Superseded\" --json",
      "forget b-abc123 --reason \"Bad advice\" --invert --json",
    ])
  )
  .action(async (id: string, opts: any) => await forgetCommand(id, opts));

// --- Audit ---
program.command("audit")
  .description("Audit recent sessions against playbook rules")
  .option("--days <n>", "Lookback days for sessions", toInt)
  .option("--trauma", "Scan cass history for catastrophic patterns (Project Hot Stove)")
  .option("-j, --json", "Output JSON")
  .addHelpText("after", () =>
    formatCommandExamples([
      "audit --days 30",
      "audit --days 14 --json",
      "audit --json",
      "audit --trauma --days 90",
      "audit --trauma --days 30 --json",
    ])
  )
  .action(async (opts: any) => await auditCommand(opts));

// --- Project ---
program.command("project")
  .description("Export playbook for project documentation")
  .option("--format <fmt>", "Output format: agents.md, claude.md, raw, yaml, json", "agents.md")
  .option("--output <path>", "Write to file instead of stdout")
  .option("--force", "Overwrite existing output file")
  .option("--per-category <n>", "Limit rules per category", toInt)
  .option("--top <n>", "DEPRECATED: use --per-category", toInt)
  .option("--no-show-counts", "Omit helpful/harmful counts in output")
  .option("-j, --json", "Output JSON")
  .addHelpText("after", () =>
    formatCommandExamples([
      "project --format agents.md --output AGENTS.md",
      "project --format claude.md --output CLAUDE.md",
      "project --format raw > playbook.json",
      "project --format agents.md --json",
    ])
  )
  .action(async (opts: any) => await projectCommand(opts));

// --- Starters ---
program.command("starters")
  .description("List available starter playbooks")
  .option("-j, --json", "Output JSON")
  .addHelpText("after", () =>
    formatCommandExamples([
      "starters",
      "starters --json",
      "init --starter typescript",
    ])
  )
  .action(async (opts: any) => await startersCommand(opts));

// --- Quickstart (agent self-documentation) ---
program.command("quickstart")
  .description("Explain the system to an agent (self-documentation)")
  .option("-j, --json", "Output JSON")
  .addHelpText("after", () =>
    formatCommandExamples([
      "quickstart",
      "quickstart --json",
      "quickstart --json > quickstart.json",
    ])
  )
  .action(async (opts: any) => await quickstartCommand(opts));

// --- Privacy ---
const privacy = program.command("privacy")
  .description("Privacy controls (cross-agent enrichment)")
  .addHelpText("after", () =>
    formatCommandExamples([
      "privacy status",
      "privacy enable",
      "privacy enable claude cursor codex",
      "privacy deny cursor --json",
    ])
  );

privacy.command("status")
  .description("Show cross-agent settings and data flow summary")
  .option("--days <n>", "Lookback days for cass timeline stats", toInt)
  .option("-j, --json", "Output JSON")
  .addHelpText("after", () =>
    formatCommandExamples([
      "privacy status",
      "privacy status --days 30 --json",
      "privacy status --json",
    ])
  )
  .action(async (opts: any) => await privacyCommand("status", [], opts));

privacy.command("enable")
  .description("Enable cross-agent enrichment (requires explicit consent)")
  .argument("[agents...]", "Optional allowlist of agents (e.g., claude cursor codex aider)")
  .option("-j, --json", "Output JSON")
  .addHelpText("after", () =>
    formatCommandExamples([
      "privacy enable",
      "privacy enable claude cursor codex --json",
      "privacy enable --json",
    ])
  )
  .action(async (agents: string[], opts: any) => await privacyCommand("enable", agents, opts));

privacy.command("disable")
  .description("Disable cross-agent enrichment")
  .option("-j, --json", "Output JSON")
  .addHelpText("after", () =>
    formatCommandExamples([
      "privacy disable",
      "privacy disable --json",
      "privacy disable --json > privacy-disable.json",
    ])
  )
  .action(async (opts: any) => await privacyCommand("disable", [], opts));

privacy.command("allow")
  .description("Allow a specific agent for cross-agent enrichment")
  .argument("<agent>", "Agent name (e.g., claude, cursor, codex, aider)")
  .option("-j, --json", "Output JSON")
  .addHelpText("after", () =>
    formatCommandExamples([
      "privacy allow cursor",
      "privacy allow codex --json",
      "privacy allow cursor --json > privacy-allow.json",
    ])
  )
  .action(async (agent: string, opts: any) => await privacyCommand("allow", [agent], opts));

privacy.command("deny")
  .description("Remove a specific agent from the allowlist")
  .argument("<agent>", "Agent name (e.g., claude, cursor, codex, aider)")
  .option("-j, --json", "Output JSON")
  .addHelpText("after", () =>
    formatCommandExamples([
      "privacy deny cursor",
      "privacy deny codex --json",
      "privacy deny cursor --json > privacy-deny.json",
    ])
  )
  .action(async (agent: string, opts: any) => await privacyCommand("deny", [agent], opts));

// --- Serve (HTTP-only MCP surface) ---
program.command("serve")
  .description("Run HTTP MCP server for agent integration")
  .option("--port <n>", "Port to listen on", toInt, 8765)
  .option("--host <host>", "Host to bind", "127.0.0.1")
  .addHelpText("after", () =>
    formatCommandExamples([
      "serve",
      "serve --host 127.0.0.1 --port 8765",
      "serve --host 0.0.0.0 --port 3001",
    ])
  )
  .action(async (opts: any) => await serveCommand({ port: opts.port, host: opts.host }));

// --- Outcome ---
program.command("outcome")
  .description("Record implicit feedback from a session outcome for shown rules")
  .argument("<status>", "Outcome status: success|failure|mixed|partial")
  .argument("<rules>", "Comma-separated rule ids that were shown")
  .option("--session <path>", "Session path for provenance")
  .option("--duration <seconds>", "Task duration in seconds", toInt)
  .option("--errors <count>", "Number of errors encountered", toInt)
  .option("--retries", "Whether there were retries")
  .option("--sentiment <sentiment>", "positive|negative|neutral")
  .option("--text <text>", "Session notes to auto-detect sentiment")
  .option("-j, --json", "Output JSON")
  .addHelpText("after", () =>
    formatCommandExamples([
      "outcome success b-abc123,b-def456 --session /path/to/session.jsonl --duration 600 --json",
      "outcome failure b-abc123 --errors 3 --text \"kept timing out\" --json",
      "outcome mixed b-abc123,b-def456 --json",
    ])
  )
  .action(async (status: string, rules: string, opts: any) => await outcomeCommand({ ...opts, status, rules }));

// --- Outcome Apply ---
program.command("outcome-apply")
  .description("Apply recorded outcomes to playbook feedback (implicit marks)")
  .option("--session <id>", "Apply only outcomes for this session id")
  .option("--limit <n>", "Max outcomes to load (default 50)", toInt)
  .option("-j, --json", "Output JSON")
  .addHelpText("after", () =>
    formatCommandExamples([
      "outcome-apply --json",
      "outcome-apply --limit 100 --json",
      "outcome-apply --session my-session-id --json",
    ])
  )
  .action(async (opts: any) => await applyOutcomeLogCommand(opts));

// --- Onboard (agent-native guided onboarding) ---
const onboard = program.command("onboard")
  .description("Agent-native guided onboarding (no API costs)")
  .addHelpText("after", () =>
    formatCommandExamples([
      "onboard status --json",
      "onboard gaps --json",
      "onboard sample --limit 5 --json",
      "onboard guided --json",
    ])
  );

onboard.command("status")
  .description("Check onboarding status and progress")
  .option("-j, --json", "Output JSON")
  .addHelpText("after", () =>
    formatCommandExamples([
      "onboard status",
      "onboard status --json",
      "onboard status --json > onboard-status.json",
    ])
  )
  .action(async (opts: any) => await onboardCommand({ ...opts, status: true }));

onboard.command("gaps")
  .description("Show playbook category gap analysis")
  .option("-j, --json", "Output JSON")
  .addHelpText("after", () =>
    formatCommandExamples([
      "onboard gaps",
      "onboard gaps --json",
      "onboard gaps --json > onboard-gaps.json",
    ])
  )
  .action(async (opts: any) => await onboardCommand({ ...opts, gaps: true }));

onboard.command("sample")
  .description("Sample diverse sessions for analysis")
  .option("--limit <n>", "Number of sessions to sample", toInt)
  .option("--fill-gaps", "Prioritize sessions for underrepresented categories")
  .option("--include-processed", "Include already-processed sessions")
  .option("--workspace <path>", "Filter by workspace")
  .option("--agent <name>", "Filter by agent (claude, cursor, etc)")
  .option("--days <n>", "Filter to last N days", toInt)
  .option("-j, --json", "Output JSON")
  .addHelpText("after", () =>
    formatCommandExamples([
      "onboard sample --limit 5 --json",
      "onboard sample --limit 10 --fill-gaps --json",
      "onboard sample --workspace . --days 14 --json",
    ])
  )
  .action(async (opts: any) => await onboardCommand({ ...opts, sample: true }));

onboard.command("read")
  .description("Read/export a session for analysis")
  .argument("<path>", "Session path to read")
  .option("--template", "Rich contextual output for extraction")
  .option("-j, --json", "Output JSON")
  .addHelpText("after", () =>
    formatCommandExamples([
      "onboard read /path/to/session.jsonl --json",
      "onboard read /path/to/session.jsonl --template",
      "onboard read /path/to/session.jsonl --template --json",
    ])
  )
  .action(async (sessionPath: string, opts: any) => await onboardCommand({ ...opts, read: sessionPath }));

onboard.command("prompt")
  .description("Show extraction instructions for agent")
  .option("-j, --json", "Output JSON")
  .addHelpText("after", () =>
    formatCommandExamples([
      "onboard prompt",
      "onboard prompt --json",
      "onboard prompt --json > onboard-prompt.json",
    ])
  )
  .action(async (opts: any) => await onboardCommand({ ...opts, prompt: true }));

onboard.command("guided")
  .description("Show full guided onboarding workflow")
  .option("-j, --json", "Output JSON")
  .addHelpText("after", () =>
    formatCommandExamples([
      "onboard guided",
      "onboard guided --json",
      "onboard guided --json > onboard-guided.json",
    ])
  )
  .action(async (opts: any) => await onboardCommand({ ...opts, guided: true }));

onboard.command("mark-done")
  .description("Mark a session as processed without extracting rules")
  .argument("<path>", "Session path to mark as done")
  .option("-j, --json", "Output JSON")
  .addHelpText("after", () =>
    formatCommandExamples([
      "onboard mark-done /path/to/session.jsonl",
      "onboard mark-done /path/to/session.jsonl --json",
      "onboard mark-done /path/to/session.jsonl --json > onboard-mark-done.json",
    ])
  )
  .action(async (sessionPath: string, opts: any) => await onboardCommand({ ...opts, markDone: sessionPath }));

onboard.command("reset")
  .description("Reset onboarding progress (start fresh)")
  .option("--yes", "Confirm without prompting")
  .option("-j, --json", "Output JSON")
  .addHelpText("after", () =>
    formatCommandExamples([
      "onboard reset --yes",
      "onboard reset --yes --json",
      "onboard reset --yes --json > onboard-reset.json",
    ])
  )
  .action(async (opts: any) => await onboardCommand({ ...opts, reset: true }));

// --- Guard (Project Hot Stove Safety) ---
program.command("guard")
  .description("Manage mechanical safety guards (Project Hot Stove)")
  .option("--install", "Install trauma guard hook to .claude/hooks")
  .option("--git", "Install git pre-commit hook to block dangerous patterns")
  .option("-j, --json", "Output JSON")
  .addHelpText("after", () =>
    formatCommandExamples([
      "guard --install          # Claude Code hook",
      "guard --git              # Git pre-commit hook",
      "guard --install --json",
    ])
  )
  .action(async (opts: any) => await guardCommand(opts));

// --- Trauma (Scar Management) ---
const trauma = program.command("trauma")
  .description("Manage Project Hot Stove traumas (scars)")
  .addHelpText("after", () =>
    formatCommandExamples([
      "trauma list",
      "trauma add \"^rm -rf\" --severity FATAL",
      "trauma heal trauma-abc123",
      "trauma remove trauma-abc123 --force",
      "trauma import ./traumas.txt --scope global",
    ])
  );

trauma.command("list")
  .alias("ls")
  .description("List active traumas")
  .option("-j, --json", "Output JSON")
  .action(async (opts: any) => await traumaCommand("list", [], opts));

trauma.command("add")
  .description("Manually add a trauma pattern")
  .argument("<pattern>", "Regex pattern to block")
  .option("--severity <level>", "CRITICAL or FATAL", "CRITICAL")
  .option("--scope <scope>", "global or project", "global")
  .option("--message <msg>", "Human-readable reason")
  .option("-j, --json", "Output JSON")
  .action(async (pattern: string, opts: any) => await traumaCommand("add", [pattern], opts));

trauma.command("heal")
  .description("Heal (disable) a trauma by id")
  .argument("<id>", "Trauma id (e.g., trauma-abc123)")
  .option("--scope <scope>", "global | project | all", "all")
  .option("-j, --json", "Output JSON")
  .action(async (id: string, opts: any) => await traumaCommand("heal", [id], opts));

trauma.command("remove")
  .alias("rm")
  .description("Remove a trauma entry by id (requires --force)")
  .argument("<id>", "Trauma id (e.g., trauma-abc123)")
  .option("--scope <scope>", "global | project | all", "all")
  .option("--force", "Required: confirm removal")
  .option("--yes", "Skip interactive confirmation (still requires --force)")
  .option("-j, --json", "Output JSON")
  .action(async (id: string, opts: any) => await traumaCommand("remove", [id], opts));

trauma.command("import")
  .description("Bulk import trauma patterns/entries from a file")
  .argument("<file>", "Path to a file containing patterns or JSONL entries")
  .option("--scope <scope>", "global or project", "global")
  .option("--severity <level>", "CRITICAL or FATAL (default: CRITICAL)", "CRITICAL")
  .option("--message <msg>", "Human-readable reason (applied to imported entries)")
  .option("-j, --json", "Output JSON")
  .action(async (file: string, opts: any) => await traumaCommand("import", [file], opts));

program.showSuggestionAfterError(true);
if (!hasJsonFlag(argv)) {
  program.showHelpAfterError("(add --help for additional information)");
}

program.addHelpText("before", ({ command }) => `${formatMainHelpBanner(command.name())}\n`);
program.addHelpText("after", ({ command }) => `${formatMainHelpEpilog(command.name())}\n`);

return program;
}

/**
 * Detect if structured output is requested in argv (before commander parses).
 * Used for error formatting when async action handlers throw.
 */
export function hasJsonFlag(argv: string[] = process.argv): boolean {
  const args = argv.slice(2);
  const argsBeforeTerminator = (() => {
    const idx = args.indexOf("--");
    return idx === -1 ? args : args.slice(0, idx);
  })();
  const jsonFlag =
    argsBeforeTerminator.includes("--json") || argsBeforeTerminator.includes("-j");

  const commands = new Set([
    "init",
    "context",
    "ctx",
    "similar",
    "mark",
    "playbook",
    "stats",
    "top",
    "stale",
    "why",
    "undo",
    "usage",
    "validate",
    "doctor",
    "reflect",
    "forget",
    "audit",
    "project",
    "starters",
    "quickstart",
    "privacy",
    "serve",
    "outcome",
    "outcome-apply",
    "onboard",
  ]);

  const command = (() => {
    for (const token of argsBeforeTerminator) {
      if (commands.has(token)) return token;
    }
    return undefined;
  })();

  const format = (() => {
    for (let i = 0; i < argsBeforeTerminator.length; i++) {
      const token = argsBeforeTerminator[i];
      if (token === "--format") {
        const next = argsBeforeTerminator[i + 1];
        if (typeof next === "string" && next.trim()) return next.trim().toLowerCase();
        return undefined;
      }
      if (token.startsWith("--format=")) {
        const value = token.slice("--format=".length).trim();
        return value ? value.toLowerCase() : undefined;
      }
    }
    return undefined;
  })();

  // `context --format markdown` explicitly disables JSON, even if `--json` is present.
  if ((command === "context" || command === "ctx") && format === "markdown") return false;

  // Explicit --format takes precedence over env defaults.
  if (format === "json" || format === "toon") return true;
  if (jsonFlag) return true;
  if (format) return false;

  // Env defaults (lowest precedence; mirrors isToonOutput()).
  const cmFormat = (process.env.CM_OUTPUT_FORMAT || "").trim().toLowerCase();
  if (cmFormat === "toon") return true;
  const toonDefault = (process.env.TOON_DEFAULT_FORMAT || "").trim().toLowerCase();
  if (toonDefault === "toon") return true;

  return false;
}

function applyGlobalEnvFromArgv(argv: string[]): void {
  let colorOverride: boolean | null = null;
  let emojiOverride: boolean | null = null;
  let widthOverride: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) continue;

    if (arg === "--verbose") {
      process.env.CASS_MEMORY_VERBOSE = "1";
      continue;
    }

    if (arg === "--no-color") {
      colorOverride = false;
      continue;
    }
    if (arg === "--color") {
      colorOverride = true;
      continue;
    }

    if (arg === "--no-emoji") {
      emojiOverride = false;
      continue;
    }
    if (arg === "--emoji") {
      emojiOverride = true;
      continue;
    }

    if (arg.startsWith("--width=")) {
      widthOverride = arg.slice("--width=".length);
      continue;
    }
    if (arg === "--width") {
      widthOverride = argv[i + 1];
    }
  }

  if (colorOverride === false) {
    process.env.NO_COLOR = "1";
    process.env.FORCE_COLOR = "0";
  } else if (colorOverride === true) {
    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = "1";
  }

  if (emojiOverride === false) {
    process.env.CASS_MEMORY_NO_EMOJI = "1";
  } else if (emojiOverride === true) {
    delete process.env.CASS_MEMORY_NO_EMOJI;
  }

  const width = widthOverride?.trim();
  if (width) process.env.CASS_MEMORY_WIDTH = width;
}

function formatMainHelpBanner(cli: string): string {
  return [
    "Start here (agents):",
    `  ${cli} context \"<task>\" --json`,
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

Global options:
  --no-color       Disable ANSI colors
  --no-emoji       Disable emoji/icons
  --width <n>      Override output width for wrapping
  --verbose        Enable verbose diagnostics

Command groups:
  Agent workflow: context, quickstart, similar
  Operator/maintenance: init, doctor, reflect, playbook, stats, project, privacy, starters
  Advanced/rare: serve, outcome, outcome-apply, audit, validate

Tip: ${cli} <command> --help
`.trimEnd();
}

function formatCommandExamples(lines: string[]): string {
  const cli = getCliName();
  return `\nExamples:\n${lines.map((line) => `  ${cli} ${line}`).join("\n")}\n`;
}

/**
 * Format error for CLI output.
 * In JSON mode: structured JSON to stdout with exit code.
 * In human mode: colored error to stderr.
 */
function inferCommandFromArgv(program: Command, argv: string[]): string | undefined {
  const candidates = argv.slice(2);
  const known = new Set<string>();
  for (const cmd of program.commands) {
    known.add(cmd.name());
    for (const a of cmd.aliases()) known.add(a);
  }

  for (const token of candidates) {
    if (token === "--") break;
    if (token.startsWith("-")) continue;
    if (known.has(token)) return token;
  }
  return undefined;
}

export function handleCliError(error: unknown, argv: string[] = process.argv, program?: Command): number {
  const category = categorizeError(error);
  const code =
    category === "user_input"
      ? ErrorCode.INVALID_INPUT
      : category === "configuration"
        ? ErrorCode.CONFIG_INVALID
        : category === "filesystem"
          ? ErrorCode.FILE_WRITE_FAILED
          : category === "network"
            ? ErrorCode.NETWORK_ERROR
            : category === "cass"
              ? ErrorCode.CASS_SEARCH_FAILED
              : category === "llm"
                ? ErrorCode.LLM_API_ERROR
                : ErrorCode.INTERNAL_ERROR;

  const inferredCommand =
    program instanceof Command ? inferCommandFromArgv(program, argv) : undefined;

  // Best-effort: honor `--format toon` and env TOON defaults for top-level errors,
  // without accidentally treating other command-specific `--format` values (e.g. `project --format agents.md`)
  // as output-mode selectors.
  const errorFormat = (() => {
    const args = argv.slice(2);
    const argsBeforeTerminator = (() => {
      const idx = args.indexOf("--");
      return idx === -1 ? args : args.slice(0, idx);
    })();

    const jsonFlag = argsBeforeTerminator.includes("--json") || argsBeforeTerminator.includes("-j");

    let format: string | undefined;
    for (let i = 0; i < argsBeforeTerminator.length; i++) {
      const token = argsBeforeTerminator[i];
      if (token === "--format") {
        const next = argsBeforeTerminator[i + 1];
        if (typeof next === "string" && next.trim()) {
          format = next.trim().toLowerCase();
        }
        break;
      }
      if (token.startsWith("--format=")) {
        const value = token.slice("--format=".length).trim();
        if (value) format = value.toLowerCase();
        break;
      }
    }

    // `context --format markdown` explicitly disables structured output.
    if ((inferredCommand === "context" || inferredCommand === "ctx") && format === "markdown") {
      return undefined;
    }

    // Explicit `--format toon` should always apply (it overrides `--json` too).
    if (format === "toon") return "toon";

    // Env default: only apply if user did not explicitly request JSON output and did not
    // provide an explicit (non-toon) format.
    if (!format && !jsonFlag) {
      const cmFormat = (process.env.CM_OUTPUT_FORMAT || "").trim().toLowerCase();
      if (cmFormat === "toon") return "toon";
      const toonDefault = (process.env.TOON_DEFAULT_FORMAT || "").trim().toLowerCase();
      if (toonDefault === "toon") return "toon";
    }

    return undefined;
  })();

  return reportError(error instanceof Error ? error : String(error), {
    code,
    json: hasJsonFlag(argv),
    ...(errorFormat ? { format: errorFormat } : {}),
    ...(inferredCommand ? { command: inferredCommand } : {}),
  });
}

if (import.meta.main) {
  // Handle --info and --examples before commander parses (similar to --version)
  const args = process.argv.slice(2);
  const hasInfoFlag = args.includes("--info");
  const hasExamplesFlag = args.includes("--examples");
  const hasJsonFlag = args.includes("--json") || args.includes("-j");

  if (hasInfoFlag) {
    infoCommand({ json: hasJsonFlag })
      .then(() => process.exit(0))
      .catch((err) => {
        console.error(err);
        process.exit(1);
      });
  } else if (hasExamplesFlag) {
    examplesCommand({ json: hasJsonFlag })
      .then(() => process.exit(0))
      .catch((err) => {
        console.error(err);
        process.exit(1);
      });
  } else {
    const program = createProgram(process.argv);
    // Use parseAsync for proper async error handling
    program.parseAsync().catch((err) => {
      const code = handleCliError(err, process.argv, program);
      process.exit(code);
    });
  }
}
