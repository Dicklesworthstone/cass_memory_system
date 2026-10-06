// src/commands/hook.ts
// Auto-reflection: a Claude Code SessionEnd hook that reflects each finished
// session in the background, so the playbook grows without anyone running
// `cm reflect` by hand.

import { spawn } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import chalk from "chalk";
import { loadConfig } from "../config.js";
import { icon } from "../output.js";
import {
  CM_SUBPROCESS_ENV_VALUE,
  CM_SUBPROCESS_ENV_VAR,
  isCmSubprocessTranscriptPath,
} from "../subprocess-tag.js";
import { ErrorCode } from "../types.js";
import {
  atomicWrite,
  ensureDir,
  expandPath,
  fileExists,
  getCliName,
  printJsonResult,
  readStdinText,
  reportError,
  resolveGitRoot,
  resolveGlobalDir,
} from "../utils.js";

/** Marks the hook entry cm owns inside settings.json, so install is idempotent and uninstall precise. */
export const SESSION_END_HOOK_ARGS = "hook session-end";
/** Set in the background reflect's environment; a nested SessionEnd seeing it does nothing. */
export const HOOK_ACTIVE_ENV = "CM_HOOK_ACTIVE";

export type HookScope = "project" | "user";

/**
 * Agents whose CLI has a SessionEnd hook that pipes `{transcript_path, cwd}`
 * JSON on stdin and lives under `hooks.SessionEnd` in a settings.json
 * (Claude Code: `.claude/`, Gemini CLI: `.gemini/`). Codex has no session-end
 * event (only per-turn Stop), so it is not offered here; its wrappers can call
 * `cm hook session-end --transcript <path>`.
 */
export const HOOK_AGENTS = {
  claude: { dir: ".claude", label: "Claude Code" },
  gemini: { dir: ".gemini", label: "Gemini CLI" },
} as const;
export type HookAgent = keyof typeof HOOK_AGENTS;

export function parseHookAgent(value: string | undefined): HookAgent | null {
  const v = (value ?? "claude").trim().toLowerCase();
  return v in HOOK_AGENTS ? (v as HookAgent) : null;
}

export interface HookFlags {
  json?: boolean;
  /** Install into the user-level settings (~/.claude, ~/.gemini) instead of the project's. */
  global?: boolean;
  /** Which agent's settings to edit: claude (default) or gemini. */
  agent?: string;
  /** Override the command the hook runs (default: resolved cm invocation). */
  command?: string;
  /** session-end: transcript path when not invoked by Claude Code (no stdin payload). */
  transcript?: string;
  /** session-end: run reflect in the foreground instead of detaching (debugging, other agents). */
  wait?: boolean;
}

/** Shell-quote one argument for a POSIX `sh -c` hook command. */
function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * The argv that re-invokes this cm: the compiled binary itself, or
 * `bun <script>` when running from source.
 */
export function selfInvocation(): string[] {
  const exec = process.execPath;
  const isBunRuntime = /^bun(?:\.exe)?$/i.test(path.basename(exec));
  const script = process.argv[1];
  if (isBunRuntime && script && !script.startsWith("/$bunfs/")) return [exec, path.resolve(script)];
  return [exec];
}

/**
 * Command line written into settings.json. Prefers a bare `cm` when it is on
 * PATH (survives upgrades and reinstalls), else the absolute invocation.
 */
export function defaultHookCommand(): string {
  const onPath = typeof Bun !== "undefined" ? Bun.which("cm") : null;
  const argv = onPath ? ["cm"] : selfInvocation();
  return `${argv.map(shellQuote).join(" ")} ${SESSION_END_HOOK_ARGS}`;
}

export async function resolveSettingsPath(
  scope: HookScope,
  agent: HookAgent = "claude",
): Promise<string | null> {
  const dir = HOOK_AGENTS[agent].dir;
  // expandPath honours HOME (os.homedir() is cached at startup under Bun).
  if (scope === "user") return expandPath(`~/${dir}/settings.json`);
  const root = await resolveGitRoot();
  return path.join(root ?? process.cwd(), dir, "settings.json");
}

function isCmHookEntry(entry: unknown): boolean {
  const hooks = (entry as any)?.hooks;
  return (
    Array.isArray(hooks) &&
    hooks.some(
      (h: any) => typeof h?.command === "string" && h.command.includes(SESSION_END_HOOK_ARGS),
    )
  );
}

async function readSettings(settingsPath: string): Promise<Record<string, any>> {
  if (!(await fileExists(settingsPath))) return {};
  const raw = await fs.readFile(settingsPath, "utf-8");
  if (raw.trim() === "") return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${settingsPath} is not a JSON object`);
  }
  return parsed;
}

/**
 * Add (or replace) cm's SessionEnd entry in a settings object, leaving every
 * other hook untouched. Returns whether an entry already existed.
 */
export function upsertSessionEndHook(
  settings: Record<string, any>,
  command: string,
  agent: HookAgent = "claude",
): boolean {
  if (!settings.hooks || typeof settings.hooks !== "object" || Array.isArray(settings.hooks)) {
    settings.hooks = {};
  }
  const existing: unknown[] = Array.isArray(settings.hooks.SessionEnd)
    ? settings.hooks.SessionEnd
    : [];
  const had = existing.some(isCmHookEntry);
  settings.hooks.SessionEnd = [
    ...existing.filter((e) => !isCmHookEntry(e)),
    {
      hooks: [
        // Gemini CLI lists hooks by name (`/hooks`); Claude Code ignores it.
        agent === "gemini"
          ? { name: "cass-memory-reflect", type: "command", command }
          : { type: "command", command },
      ],
    },
  ];
  return had;
}

/** Remove cm's SessionEnd entry. Returns whether one was removed. */
export function removeSessionEndHook(settings: Record<string, any>): boolean {
  const existing: unknown[] = Array.isArray(settings?.hooks?.SessionEnd)
    ? settings.hooks.SessionEnd
    : [];
  const kept = existing.filter((e) => !isCmHookEntry(e));
  if (kept.length === existing.length) return false;
  if (kept.length > 0) settings.hooks.SessionEnd = kept;
  else delete settings.hooks.SessionEnd;
  if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;
  return true;
}

export function hookLogPath(): string {
  return path.join(resolveGlobalDir(), "hooks.log");
}

async function appendHookLog(line: string): Promise<void> {
  try {
    const logPath = hookLogPath();
    await ensureDir(path.dirname(logPath));
    await fs.appendFile(logPath, `${new Date().toISOString()} ${line}\n`, "utf-8");
  } catch {
    // Never let logging break a hook.
  }
}

export interface SessionEndDecision {
  action: "reflect" | "skip";
  reason: string;
  transcriptPath?: string;
  cwd?: string;
}

/**
 * Decide what a SessionEnd payload should trigger. Pure apart from the
 * existence check, so the loop guards are testable:
 * - inside a background reflect (HOOK_ACTIVE_ENV) -> skip
 * - inside a session cm started as its LLM (CM_SUBPROCESS_ENV_VAR) -> skip
 * - transcript written by one of cm's own LLM subprocesses -> skip (#76)
 * - no transcript path, or the file does not exist -> skip
 */
export async function decideSessionEnd(
  payload: { transcript_path?: unknown; cwd?: unknown },
  options: { env?: NodeJS.ProcessEnv; cliSubprocessCwd?: string } = {},
): Promise<SessionEndDecision> {
  const env = options.env ?? process.env;
  if (env[HOOK_ACTIVE_ENV]) {
    return { action: "skip", reason: "nested session inside a cm background reflect" };
  }
  // A session cm itself started as its LLM (provider "cli": claude -p, gemini,
  // codex). The hook inherits that process's env, so this works for every
  // agent, including Gemini, whose transcript folders are hashed rather than
  // slugged and so escape the path check below.
  if (env[CM_SUBPROCESS_ENV_VAR] === CM_SUBPROCESS_ENV_VALUE) {
    return { action: "skip", reason: "session is a cm LLM subprocess call" };
  }
  const transcript =
    typeof payload.transcript_path === "string" ? payload.transcript_path.trim() : "";
  if (!transcript) return { action: "skip", reason: "no transcript_path in hook payload" };
  const transcriptPath = path.resolve(expandPath(transcript));
  if (isCmSubprocessTranscriptPath(transcriptPath, options.cliSubprocessCwd)) {
    return { action: "skip", reason: "transcript is a cm LLM subprocess call", transcriptPath };
  }
  if (!(await fileExists(transcriptPath))) {
    return { action: "skip", reason: "transcript file not found", transcriptPath };
  }
  const cwd = typeof payload.cwd === "string" && payload.cwd.trim() ? payload.cwd : undefined;
  return { action: "reflect", reason: "session ended", transcriptPath, cwd };
}

async function readHookPayload(): Promise<Record<string, unknown>> {
  if (process.stdin.isTTY) return {};
  try {
    const raw = (await readStdinText()).trim();
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * `cm hook session-end`: the hook body. Always exits 0 and prints nothing on
 * stdout unless --json, so it can never disrupt the agent that is shutting down.
 */
async function sessionEnd(flags: HookFlags, startedAtMs: number): Promise<void> {
  const payload = flags.transcript ? { transcript_path: flags.transcript } : await readHookPayload();
  let cliSubprocessCwd: string | undefined;
  try {
    cliSubprocessCwd = (await loadConfig()).cliSubprocessCwd;
  } catch {
    cliSubprocessCwd = undefined;
  }
  const decision = await decideSessionEnd(payload, { cliSubprocessCwd });

  if (decision.action === "skip") {
    await appendHookLog(`session-end skip: ${decision.reason}${decision.transcriptPath ? ` (${decision.transcriptPath})` : ""}`);
    if (flags.json) printJsonResult("hook", { ...decision }, { startedAtMs });
    return;
  }

  const argv = [...selfInvocation(), "reflect", "--session", decision.transcriptPath!, "--json"];
  const cwd = decision.cwd && fsSync.existsSync(decision.cwd) ? decision.cwd : process.cwd();
  const env = { ...process.env, [HOOK_ACTIVE_ENV]: "1" };
  await appendHookLog(`session-end reflect: ${decision.transcriptPath} (cwd ${cwd})`);

  const logPath = hookLogPath();
  await ensureDir(path.dirname(logPath));
  const logFd = fsSync.openSync(logPath, "a");
  try {
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env,
      detached: !flags.wait,
      stdio: ["ignore", logFd, logFd],
    });
    if (flags.wait) {
      const code = await new Promise<number>((resolve) => {
        child.on("close", (c) => resolve(c ?? 1));
        child.on("error", () => resolve(1));
      });
      if (flags.json) printJsonResult("hook", { ...decision, exitCode: code }, { startedAtMs });
      return;
    }
    child.on("error", (err) => void appendHookLog(`session-end spawn failed: ${err.message}`));
    child.unref();
    if (flags.json) printJsonResult("hook", { ...decision, pid: child.pid }, { startedAtMs });
  } finally {
    fsSync.closeSync(logFd);
  }
}

function reportBadAgent(flags: HookFlags, startedAtMs: number): void {
  reportError(`Unknown --agent '${flags.agent}'`, {
    code: ErrorCode.INVALID_INPUT,
    hint: `Supported: ${Object.keys(HOOK_AGENTS).join(", ")}`,
    json: flags.json,
    command: "hook",
    startedAtMs,
  });
}

async function install(flags: HookFlags, startedAtMs: number): Promise<void> {
  const agent = parseHookAgent(flags.agent);
  if (!agent) return reportBadAgent(flags, startedAtMs);
  const scope: HookScope = flags.global ? "user" : "project";
  const settingsPath = (await resolveSettingsPath(scope, agent))!;
  const hookCommand = flags.command?.trim() || defaultHookCommand();
  const cli = getCliName();

  let settings: Record<string, any>;
  try {
    settings = await readSettings(settingsPath);
  } catch (err: any) {
    reportError(`Could not parse ${settingsPath}; refusing to overwrite it`, {
      code: ErrorCode.CONFIG_INVALID,
      details: { path: settingsPath, error: err?.message ?? String(err) },
      hint: `Fix the JSON, or add this under hooks.SessionEnd by hand: {"hooks":[{"type":"command","command":"${hookCommand}"}]}`,
      json: flags.json,
      command: "hook",
      startedAtMs,
    });
    return;
  }

  const replaced = upsertSessionEndHook(settings, hookCommand, agent);
  await ensureDir(path.dirname(settingsPath));
  await atomicWrite(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);

  const result = {
    installed: true,
    replaced,
    agent,
    scope,
    settingsPath,
    hookCommand,
    logPath: hookLogPath(),
  };
  if (flags.json) {
    printJsonResult("hook", result, { startedAtMs });
    return;
  }
  console.log(
    chalk.green(
      `${icon("success")} ${replaced ? "Updated" : "Installed"} SessionEnd auto-reflect hook in ${settingsPath}`,
    ),
  );
  console.log(chalk.gray(`  Runs: ${hookCommand}`));
  const label = HOOK_AGENTS[agent].label;
  const agentFlag = agent === "claude" ? "" : ` --agent ${agent}`;
  console.log(chalk.gray(`  Each finished ${label} session is reflected in the background.`));
  console.log(
    chalk.gray(`  Log: ${result.logPath}   Remove: ${cli} hook uninstall${agentFlag}${flags.global ? " --global" : ""}`),
  );
  console.log(chalk.yellow(`  Restart ${label} for the hook to take effect.`));
}

async function uninstall(flags: HookFlags, startedAtMs: number): Promise<void> {
  const agent = parseHookAgent(flags.agent);
  if (!agent) return reportBadAgent(flags, startedAtMs);
  const scope: HookScope = flags.global ? "user" : "project";
  const settingsPath = (await resolveSettingsPath(scope, agent))!;
  let removed = false;
  if (await fileExists(settingsPath)) {
    let settings: Record<string, any>;
    try {
      settings = await readSettings(settingsPath);
    } catch (err: any) {
      reportError(`Could not parse ${settingsPath}`, {
        code: ErrorCode.CONFIG_INVALID,
        details: { path: settingsPath, error: err?.message ?? String(err) },
        json: flags.json,
        command: "hook",
        startedAtMs,
      });
      return;
    }
    removed = removeSessionEndHook(settings);
    if (removed) await atomicWrite(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  }
  if (flags.json) {
    printJsonResult("hook", { removed, agent, scope, settingsPath }, { startedAtMs });
    return;
  }
  console.log(
    removed
      ? chalk.green(`${icon("success")} Removed the auto-reflect hook from ${settingsPath}`)
      : chalk.gray(`No cm auto-reflect hook in ${settingsPath}`),
  );
}

export interface AutoReflectScopeStatus {
  agent: HookAgent;
  scope: HookScope;
  settingsPath: string;
  installed: boolean;
  hookCommand?: string;
  error?: string;
}

/** Where cm's SessionEnd auto-reflect hook is installed (each agent, project and user scope). */
export async function getAutoReflectStatus(): Promise<{
  autoReflect: boolean;
  scopes: AutoReflectScopeStatus[];
}> {
  const scopes: AutoReflectScopeStatus[] = [];
  for (const agent of Object.keys(HOOK_AGENTS) as HookAgent[]) {
    for (const scope of ["project", "user"] as HookScope[]) {
      const settingsPath = (await resolveSettingsPath(scope, agent))!;
      const entry: AutoReflectScopeStatus = { agent, scope, settingsPath, installed: false };
      try {
        const settings = await readSettings(settingsPath);
        const found = (Array.isArray(settings?.hooks?.SessionEnd) ? settings.hooks.SessionEnd : []).find(
          isCmHookEntry,
        );
        entry.installed = Boolean(found);
        const command = found?.hooks?.find((h: any) => h?.command?.includes(SESSION_END_HOOK_ARGS))
          ?.command;
        if (command) entry.hookCommand = command;
      } catch (err: any) {
        entry.error = err?.message ?? String(err);
      }
      scopes.push(entry);
    }
  }
  return { autoReflect: scopes.some((e) => e.installed), scopes };
}

async function status(flags: HookFlags, startedAtMs: number): Promise<void> {
  const result = { ...(await getAutoReflectStatus()), logPath: hookLogPath() };
  if (flags.json) {
    printJsonResult("hook", result, { startedAtMs });
    return;
  }
  for (const e of result.scopes) {
    const mark = e.installed ? chalk.green("installed") : chalk.gray("not installed");
    console.log(
      `${e.agent.padEnd(7)} ${e.scope.padEnd(8)} ${mark}  ${chalk.gray(e.settingsPath)}${e.error ? chalk.red(` (${e.error})`) : ""}`,
    );
  }
  if (!result.autoReflect) {
    console.log(
      chalk.gray(
        `\nEnable: ${getCliName()} hook install [--agent gemini] [--global]   (default: Claude Code, this project)`,
      ),
    );
  }
}

export async function hookCommand(
  action: "install" | "uninstall" | "status" | "session-end",
  flags: HookFlags = {},
): Promise<void> {
  const startedAtMs = Date.now();
  try {
    if (action === "install") return await install(flags, startedAtMs);
    if (action === "uninstall") return await uninstall(flags, startedAtMs);
    if (action === "status") return await status(flags, startedAtMs);
    return await sessionEnd(flags, startedAtMs);
  } catch (err: any) {
    if (action === "session-end") {
      // A hook must never fail the agent's shutdown.
      await appendHookLog(`session-end error: ${err?.message ?? String(err)}`);
      return;
    }
    reportError(err instanceof Error ? err : String(err), {
      code: ErrorCode.INTERNAL_ERROR,
      json: flags.json,
      command: "hook",
      startedAtMs,
    });
  }
}
