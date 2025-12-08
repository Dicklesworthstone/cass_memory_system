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

// --- Stats ---
program.command("stats")
  .description("Show playbook health metrics")
  .option("--json", "Output JSON")
  .action(async (opts: any) => await statsCommand(opts));

// --- Validate ---
program.command("validate")
  .description("Scientifically validate a proposed rule against history")
  .argument("<rule>", "Proposed rule text")
  .option("--json", "Output JSON")
  .option("--verbose", "Verbose output")
  .action(async (rule: string, opts: any) => await validateCommand(rule, opts));

// --- Doctor ---
program.command("doctor")
  .description("Check system health")
  .option("--json", "Output JSON")
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
  .description("Deprecate a rule and optionally add to toxic blocklist")
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

program.parse();
