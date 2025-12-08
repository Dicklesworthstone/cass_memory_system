#!/usr/bin/env bun
import { Command } from "commander";
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

const program = new Command();
const toInt = (value: string) => parseInt(value, 10);

program
  .name("cass-memory")
  .description("Agent-agnostic reflection and memory system")
  .version("0.1.0");

// --- Init ---
program.command("init")
  .description("Initialize configuration and playbook")
  .option("-f, --force", "Overwrite existing config")
  .option("--repo", "Initialize repo-level .cass/ directory structure")
  .option("--json", "Output JSON")
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

// --- Mark ---
program.command("mark")
  .description("Record helpful/harmful feedback for a rule")
  .argument("<bulletId>", "ID of the rule")
  .option("--helpful", "Mark as helpful")
  .option("--harmful", "Mark as harmful")
  .option("--reason <text>", "Reason for feedback")
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
  .description("Add a new rule")
  .argument("<content>", "Rule content")
  .option("--category <cat>", "Category", "general")
  .option("--json", "Output JSON")
  .action(async (content: string, opts: any) => await playbookCommand("add", [content], opts));

playbook.command("remove")
  .description("Remove (deprecate) a rule")
  .argument("<id>", "Rule ID")
  .option("--hard", "Permanently delete")
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
  .action(async (opts: any) => await doctorCommand(opts));

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

// --- Serve (HTTP-only MCP surface) ---
program.command("serve")
  .description("Run HTTP MCP server for agent integration")
  .option("--port <n>", "Port to listen on", toInt, 8765)
  .option("--host <host>", "Host to bind", "127.0.0.1")
  .action(async (opts: any) => await serveCommand({ port: opts.port, host: opts.host }));

// --- Outcome ---
program.command("outcome")
  .description("Record implicit feedback from a session outcome for shown rules")
  .requiredOption("--status <status>", "Outcome status: success|failure|mixed")
  .requiredOption("--rules <ids>", "Comma-separated rule ids that were shown")
  .option("--session <path>", "Session path for provenance")
  .option("--duration <seconds>", "Task duration in seconds", toInt)
  .option("--errors <count>", "Number of errors encountered", toInt)
  .option("--retries", "Whether there were retries")
  .option("--sentiment <sentiment>", "positive|negative|neutral")
  .option("--text <text>", "Session notes to auto-detect sentiment")
  .option("--json", "Output JSON")
  .action(async (opts: any) => await outcomeCommand(undefined, opts));

// --- Outcome Apply ---
program.command("outcome-apply")
  .description("Apply recorded outcomes to playbook feedback (implicit marks)")
  .option("--session <id>", "Apply only outcomes for this session id")
  .option("--limit <n>", "Max outcomes to load (default 50)", toInt)
  .option("--json", "Output JSON")
  .action(async (opts: any) => await applyOutcomeLogCommand(opts));

program.parse();
