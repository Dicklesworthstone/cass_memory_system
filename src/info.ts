/**
 * System info gathering for `cm --info` command.
 * Shows version, configuration paths, environment, and dependencies.
 */
import path from "node:path";
import { spawnSync } from "node:child_process";
import chalk from "chalk";
import {
  getVersion,
  resolveGlobalDir,
  resolveRepoDir,
  fileExists,
  getCliName,
  printJsonResult,
} from "./utils.js";
import { loadPlaybook, getActiveBullets } from "./playbook.js";

export interface InfoResult {
  version: string;
  configuration: {
    globalConfig: { path: string; exists: boolean };
    globalPlaybook: { path: string; exists: boolean; ruleCount?: number };
    workspacePlaybook: { path: string | null; exists: boolean; ruleCount?: number };
  };
  environment: {
    OPENAI_API_KEY: { set: boolean; masked?: string };
    ANTHROPIC_API_KEY: { set: boolean; masked?: string };
    CASS_HOME: { set: boolean; value?: string };
    CASS_MEMORY_VERBOSE: { set: boolean };
    CASS_MEMORY_NO_EMOJI: { set: boolean };
  };
  dependencies: {
    cass: { available: boolean; version?: string; error?: string };
    node: { version: string };
    bun: { available: boolean; version?: string };
  };
}

/**
 * Mask an API key for display (show first 3 and last 4 chars).
 */
function maskApiKey(key: string): string {
  if (key.length < 10) return "***";
  return `${key.slice(0, 3)}...${key.slice(-4)}`;
}

/**
 * Get cass CLI version.
 */
function getCassVersion(): { available: boolean; version?: string; error?: string } {
  try {
    const cassPath = process.env.CASS_PATH || "cass";
    const result = spawnSync(cassPath, ["--version"], {
      stdio: "pipe",
      timeout: 3000,
      encoding: "utf-8",
    });

    if (result.status === 0 && result.stdout) {
      const version = result.stdout.trim().split("\n")[0] || "unknown";
      return { available: true, version };
    }

    return { available: false, error: result.stderr?.trim() || "Command failed" };
  } catch (e: any) {
    return { available: false, error: e.code === "ENOENT" ? "cass not found in PATH" : e.message };
  }
}

/**
 * Get Bun version if running under Bun.
 */
function getBunVersion(): { available: boolean; version?: string } {
  // Bun sets process.versions.bun
  const bunVersion = (process.versions as any).bun;
  if (bunVersion) {
    return { available: true, version: bunVersion };
  }
  return { available: false };
}

/**
 * Count rules in a playbook file.
 */
async function countPlaybookRules(playbookPath: string): Promise<number | null> {
  try {
    const playbook = await loadPlaybook(playbookPath);
    return getActiveBullets(playbook).length;
  } catch {
    return null;
  }
}

/**
 * Gather all system information.
 */
export async function gatherInfo(): Promise<InfoResult> {
  const globalDir = resolveGlobalDir();
  const repoDir = await resolveRepoDir();

  // Configuration paths
  const globalConfigPath = path.join(globalDir, "config.json");
  const globalPlaybookPath = path.join(globalDir, "playbook.yaml");
  const workspacePlaybookPath = repoDir ? path.join(repoDir, "playbook.yaml") : null;

  const [
    globalConfigExists,
    globalPlaybookExists,
    workspacePlaybookExists,
  ] = await Promise.all([
    fileExists(globalConfigPath),
    fileExists(globalPlaybookPath),
    workspacePlaybookPath ? fileExists(workspacePlaybookPath) : Promise.resolve(false),
  ]);

  // Count rules
  const [globalRuleCount, workspaceRuleCount] = await Promise.all([
    globalPlaybookExists ? countPlaybookRules(globalPlaybookPath) : Promise.resolve(null),
    workspacePlaybookPath && workspacePlaybookExists
      ? countPlaybookRules(workspacePlaybookPath)
      : Promise.resolve(null),
  ]);

  // Environment variables
  const openaiKey = process.env.OPENAI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const cassHome = process.env.CASS_HOME;

  return {
    version: getVersion(),
    configuration: {
      globalConfig: { path: globalConfigPath, exists: globalConfigExists },
      globalPlaybook: {
        path: globalPlaybookPath,
        exists: globalPlaybookExists,
        ruleCount: globalPlaybookExists && globalRuleCount !== null ? globalRuleCount : undefined,
      },
      workspacePlaybook: {
        path: workspacePlaybookPath,
        exists: workspacePlaybookExists,
        ruleCount: workspacePlaybookExists && workspaceRuleCount !== null ? workspaceRuleCount : undefined,
      },
    },
    environment: {
      OPENAI_API_KEY: openaiKey
        ? { set: true, masked: maskApiKey(openaiKey) }
        : { set: false },
      ANTHROPIC_API_KEY: anthropicKey
        ? { set: true, masked: maskApiKey(anthropicKey) }
        : { set: false },
      CASS_HOME: cassHome ? { set: true, value: cassHome } : { set: false },
      CASS_MEMORY_VERBOSE: { set: !!process.env.CASS_MEMORY_VERBOSE },
      CASS_MEMORY_NO_EMOJI: { set: !!process.env.CASS_MEMORY_NO_EMOJI },
    },
    dependencies: {
      cass: getCassVersion(),
      node: { version: process.version },
      bun: getBunVersion(),
    },
  };
}

/**
 * Format info for human-readable display.
 */
function formatInfoHuman(info: InfoResult): string {
  const lines: string[] = [];
  const cli = getCliName();

  // Version banner
  lines.push(chalk.bold.cyan(`${cli} v${info.version}`));
  lines.push("");

  // Configuration section
  lines.push(chalk.bold("Configuration:"));

  const { configuration: config } = info;
  const fmtPath = (p: string) => {
    const home = process.env.HOME;
    return home && p.startsWith(home) ? "~" + p.slice(home.length) : p;
  };

  lines.push(`  Global config:    ${fmtPath(config.globalConfig.path)} ${config.globalConfig.exists ? chalk.green("(exists)") : chalk.yellow("(not found)")}`);

  const globalPbStatus = config.globalPlaybook.exists
    ? typeof config.globalPlaybook.ruleCount === "number"
      ? chalk.green(`(${config.globalPlaybook.ruleCount} rules)`)
      : chalk.red("(invalid/corrupt)")
    : chalk.yellow("(not found)");
  lines.push(`  Global playbook:  ${fmtPath(config.globalPlaybook.path)} ${globalPbStatus}`);

  if (config.workspacePlaybook.path) {
    const wsPbStatus = config.workspacePlaybook.exists
      ? typeof config.workspacePlaybook.ruleCount === "number"
        ? chalk.green(`(${config.workspacePlaybook.ruleCount} rules)`)
        : chalk.red("(invalid/corrupt)")
      : chalk.yellow("(not found)");
    lines.push(`  Workspace playbook: ${fmtPath(config.workspacePlaybook.path)} ${wsPbStatus}`);
  } else {
    lines.push(`  Workspace playbook: ${chalk.dim("(not in a git repo with .cass/)")}`);
  }

  lines.push("");

  // Environment section
  lines.push(chalk.bold("Environment:"));

  const { environment: env } = info;
  lines.push(`  OPENAI_API_KEY:      ${env.OPENAI_API_KEY.set ? chalk.green(`set (${env.OPENAI_API_KEY.masked})`) : chalk.yellow("not set")}`);
  lines.push(`  ANTHROPIC_API_KEY:   ${env.ANTHROPIC_API_KEY.set ? chalk.green(`set (${env.ANTHROPIC_API_KEY.masked})`) : chalk.yellow("not set")}`);
  lines.push(`  CASS_HOME:           ${env.CASS_HOME.set ? chalk.green(env.CASS_HOME.value) : chalk.dim("not set (using default)")}`);

  if (env.CASS_MEMORY_VERBOSE.set || env.CASS_MEMORY_NO_EMOJI.set) {
    const flags: string[] = [];
    if (env.CASS_MEMORY_VERBOSE.set) flags.push("VERBOSE");
    if (env.CASS_MEMORY_NO_EMOJI.set) flags.push("NO_EMOJI");
    lines.push(`  Flags:               ${chalk.cyan(flags.join(", "))}`);
  }

  lines.push("");

  // Dependencies section
  lines.push(chalk.bold("Dependencies:"));

  const { dependencies: deps } = info;
  if (deps.cass.available) {
    lines.push(`  cass CLI:  ${chalk.green(deps.cass.version)}`);
  } else {
    lines.push(`  cass CLI:  ${chalk.red("not available")} ${chalk.dim(`(${deps.cass.error})`)}`);
  }

  lines.push(`  Node.js:   ${chalk.green(deps.node.version)}`);

  if (deps.bun.available) {
    lines.push(`  Bun:       ${chalk.green(deps.bun.version)}`);
  }

  lines.push("");
  lines.push(chalk.dim(`For health check: ${cli} doctor`));

  return lines.join("\n");
}

/**
 * Run the info command.
 */
export async function infoCommand(opts: { json?: boolean }): Promise<void> {
  const info = await gatherInfo();

  if (opts.json) {
    printJsonResult("info", info, {});
  } else {
    console.log(formatInfoHuman(info));
  }
}
