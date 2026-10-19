import fs from "node:fs/promises";
import path from "node:path";
import chalk from "chalk";
import { iconPrefix } from "../output.js";
import {
  GIT_PRECOMMIT_HOOK,
  renderGuardScript,
  TRAUMA_GUARD_SCRIPT,
} from "../trauma_guard_script.js";
import { ErrorCode } from "../types.js";
import {
  ensureDir,
  expandPath,
  fileExists,
  getCliName,
  printJsonResult,
  reportError,
  resolveGitRoot,
  resolveGlobalDir,
} from "../utils.js";

export async function guardCommand(flags: {
  install?: boolean;
  git?: boolean;
  user?: boolean;
  json?: boolean;
}) {
  const startedAtMs = Date.now();
  const command = "guard";
  const cli = getCliName();

  try {
    if (flags.user && !flags.install) {
      reportError("--user only applies to --install", {
        code: ErrorCode.INVALID_INPUT,
        hint: `Use: ${cli} guard --install --user    # Claude Code hook for every project`,
        details: { flag: "--user" },
        json: flags.json,
        command,
        startedAtMs,
      });
      return;
    }

    if (flags.install) {
      await installGuard(flags.json, false, { user: flags.user });
      return;
    }

    if (flags.git) {
      await installGitHook(flags.json);
      return;
    }

    reportError("Missing required flag: --install or --git", {
      code: ErrorCode.MISSING_REQUIRED,
      hint: `Examples:\n  ${cli} guard --install    # Claude Code hook\n  ${cli} guard --git        # Git pre-commit hook`,
      details: { missing: "--install or --git" },
      json: flags.json,
      command,
      startedAtMs,
    });
  } catch (err: any) {
    reportError(err instanceof Error ? err : String(err), {
      code: ErrorCode.INTERNAL_ERROR,
      json: flags.json,
      command,
      startedAtMs,
    });
  }
}

export const GUARD_SCRIPT_NAME = "trauma_guard.py";

/** Where a Claude Code hook is registered: one project, or every project. */
export type GuardScope = "project" | "user";

/** Claude Code's user-level config dir: `$CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export function resolveUserClaudeDir(): string {
  const configured = process.env.CLAUDE_CONFIG_DIR?.trim();
  return path.resolve(expandPath(configured || "~/.claude"));
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The PreToolUse command cm registers for the trauma guard (GH #93).
 *
 * Both forms fail open: when the script is not there (a branch or worktree
 * that predates the project install, a deleted user copy) the hook exits 0
 * quietly instead of printing "not found" on every Bash call. The script runs
 * through `python3` so a checkout that lost the executable bit still works.
 *
 * - project: the script inside the project, via `$CLAUDE_PROJECT_DIR`, so the
 *   committed `.claude/settings.json` works on every clone.
 * - user: the user-level copy, by `$HOME`-relative path when it lives under
 *   the home dir (dotfiles synced across machines keep working), otherwise by
 *   absolute path.
 */
export function guardHookCommand(scope: GuardScope, userScriptPath?: string): string {
  let target: string;
  if (scope === "project") {
    target = `"$CLAUDE_PROJECT_DIR/.claude/hooks/${GUARD_SCRIPT_NAME}"`;
  } else {
    const scriptPath = path.resolve(
      userScriptPath ?? path.join(resolveUserClaudeDir(), "hooks", GUARD_SCRIPT_NAME),
    );
    const home = path.resolve(expandPath("~"));
    const rel = path.relative(home, scriptPath).split(path.sep).join("/");
    const underHome = rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
    target =
      underHome && /^[A-Za-z0-9._/-]+$/.test(rel) ? `"$HOME/${rel}"` : shellSingleQuote(scriptPath);
  }
  return `g=${target}; [ -f "$g" ] || exit 0; exec python3 "$g"`;
}

async function sameDirectory(a: string, b: string): Promise<boolean> {
  try {
    const [ra, rb] = await Promise.all([fs.realpath(a), fs.realpath(b)]);
    return ra === rb;
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}

export async function installGuard(
  json?: boolean,
  silent?: boolean,
  options: { user?: boolean } = {},
) {
  const startedAtMs = Date.now();
  const command = "guard";
  const cli = getCliName();
  const userClaudeDir = resolveUserClaudeDir();
  // Running the project install from the home directory targets ~/.claude,
  // i.e. the user settings: treat that as a user install so the hook command
  // points at the script that was just written (GH #93).
  const scope: GuardScope =
    options.user || (await sameDirectory(".claude", userClaudeDir)) ? "user" : "project";
  const claudeDir = scope === "user" ? userClaudeDir : ".claude";
  const hooksDir = path.join(claudeDir, "hooks");
  const settingsPath = path.join(claudeDir, "settings.json");
  const scriptName = GUARD_SCRIPT_NAME;
  const scriptPath = path.join(hooksDir, scriptName);
  const hookCommand = guardHookCommand(scope, scriptPath);

  // 1. Ensure directories
  if (!(await fileExists(claudeDir))) {
    if (silent) return;
    if (scope === "user") {
      reportError(`No Claude Code user directory found at ${claudeDir}.`, {
        code: ErrorCode.FILE_NOT_FOUND,
        hint: "Run Claude Code once to create it (or set CLAUDE_CONFIG_DIR), then re-run this.",
        details: { missing: claudeDir },
        json,
        command,
        startedAtMs,
      });
      return;
    }
    reportError("No .claude directory found. Is this a Claude Code project?", {
      code: ErrorCode.FILE_NOT_FOUND,
      hint: `Run this command from a project root that contains a .claude directory, or use '${cli} guard --install --user' to guard every project.`,
      details: { missing: ".claude" },
      json,
      command,
      startedAtMs,
    });
    return;
  }

  await ensureDir(hooksDir);

  // Check for python3 availability (warn if missing)
  if (!silent) {
    try {
      const { exec } = await import("node:child_process");
      const { promisify } = await import("node:util");
      await promisify(exec)("python3 --version", { timeout: 2000 });
    } catch {
      console.warn(
        chalk.yellow(
          `${iconPrefix("warning")} Warning: 'python3' not found in PATH. The trauma guard requires Python 3.`,
        ),
      );
    }
  }

  // 2. Write Script
  // The script bakes in the global dir cm resolves now (GH #82), so re-running
  // the install always refreshes it.
  await fs.writeFile(scriptPath, renderGuardScript(TRAUMA_GUARD_SCRIPT, resolveGlobalDir()), {
    encoding: "utf-8",
    mode: 0o755,
  });

  // 2a. Post-write validation — confirm the script is parseable Python.
  //
  // Background: issue #48 (and previously #45) showed that build-time
  // normalisation drift in `bun build --compile` could ship a TRAUMA_GUARD_SCRIPT
  // containing invalid Unicode escapes, producing a Python file that fails at
  // ast.parse with "truncated \uXXXX escape". Claude Code's PreToolUse hook
  // surface silently no-ops on a SyntaxError, so the user gets a sham guard
  // that never fires. The unit-test suite catches this against the TS source,
  // but the compiled-binary path is the failure surface that bites users.
  //
  // We run `python3 -c 'import ast; ast.parse(open(path).read())'` against the
  // freshly-installed script. If parsing fails, we delete the bad script,
  // surface a structured error pointing at the upstream cm bug, and abort the
  // install — better to leave the user with no guard than a silent-no-op one.
  //
  // python3 missing is treated as a warning (not a failure), since the
  // existing python3-availability check already warns above and a missing
  // python3 means the guard wouldn't run anyway.
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const pExecFile = promisify(execFile);
    await pExecFile(
      "python3",
      ["-c", `import ast,sys; ast.parse(open(sys.argv[1]).read()); print("ok")`, scriptPath],
      { timeout: 5000 },
    );
  } catch (parseErr: any) {
    // python3 absent is a soft fail (already warned above). A real ast.parse
    // SyntaxError is hard-fail — don't ship a broken guard.
    const isMissingPython =
      parseErr?.code === "ENOENT" || /python3.*not found/i.test(String(parseErr?.message ?? ""));
    if (!isMissingPython) {
      try {
        await fs.unlink(scriptPath);
      } catch {
        // best-effort cleanup; continue to surface the error
      }
      const stderr = String(parseErr?.stderr ?? parseErr?.message ?? "unknown error");
      const msg = `Error: trauma guard installation aborted — the generated trauma_guard.py failed Python parse-time validation. This indicates an upstream cm template bug; please report.`;
      if (!silent) {
        reportError(msg, {
          code: ErrorCode.CONFIG_INVALID,
          hint: `Report the failing cm version at https://github.com/Dicklesworthstone/cass_memory_system/issues, including this stderr: ${stderr.trim().slice(0, 500)}`,
          details: { scriptPath, stderr: stderr.trim().slice(0, 1000) },
          json,
          command,
          startedAtMs,
        });
      }
      return;
    }
  }

  // 3. Update settings.json
  let settings: any = {};
  if (await fileExists(settingsPath)) {
    try {
      const content = await fs.readFile(settingsPath, "utf-8");
      settings = JSON.parse(content);
    } catch (e) {
      const msg = `Error: Could not parse ${settingsPath} (invalid JSON or comments). Aborting to prevent data loss.`;
      if (!silent) {
        reportError(msg, {
          code: ErrorCode.CONFIG_INVALID,
          hint: `Fix ${settingsPath} (must be strict JSON), then re-run: ${cli} guard --install${scope === "user" ? " --user" : ""}`,
          details: { path: settingsPath },
          json,
          command,
          startedAtMs,
        });
        if (!json) {
          console.error("Please manually add this hook to 'PreToolUse':");
          console.log(
            JSON.stringify(
              { matcher: "Bash", hooks: [{ type: "command", command: hookCommand }] },
              null,
              2,
            ),
          );
        }
      }
      return;
    }
  }

  // Ensure hooks structure (defensive: settings.json is user-owned)
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) settings = {};
  if (!settings.hooks || typeof settings.hooks !== "object" || Array.isArray(settings.hooks))
    settings.hooks = {};
  if (!Array.isArray(settings.hooks.PreToolUse)) settings.hooks.PreToolUse = [];

  // Find our existing hook entries. Older cm versions always wrote
  // `$CLAUDE_PROJECT_DIR/.claude/hooks/trauma_guard.py`, which errors in every
  // checkout without the script and, in the user settings, points at the
  // wrong file entirely (GH #93): rewrite such commands rather than treating
  // their presence as "already installed".
  let registered = false;
  let rewritten = false;
  for (const entry of settings.hooks.PreToolUse as any[]) {
    const hooks = entry && typeof entry === "object" ? (entry as any).hooks : undefined;
    if (!Array.isArray(hooks)) continue;
    for (const hook of hooks) {
      if (typeof hook?.command !== "string" || !hook.command.includes(scriptName)) continue;
      registered = true;
      if (hook.command !== hookCommand) {
        hook.command = hookCommand;
        rewritten = true;
      }
    }
  }

  if (!registered) {
    settings.hooks.PreToolUse.push({
      matcher: "Bash",
      hooks: [{ type: "command", command: hookCommand }],
    });
  }
  if (!registered || rewritten) {
    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
  }
  const alreadyInstalled = registered && !rewritten;

  if (silent) return;

  if (json) {
    printJsonResult(
      command,
      {
        message: alreadyInstalled
          ? "Trauma guard already installed."
          : rewritten
            ? "Trauma guard hook command updated."
            : "Trauma guard installed successfully.",
        alreadyInstalled,
        updated: rewritten,
        scope,
        scriptPath,
        settingsPath,
        hookCommand,
      },
      { startedAtMs },
    );
  } else {
    console.log(chalk.green(`✓ Installed ${scriptName} to ${hooksDir}`));
    console.log(
      chalk.green(
        `✓ ${alreadyInstalled ? "Verified" : rewritten ? "Updated the hook command in" : "Updated"} ${settingsPath}`,
      ),
    );
    console.log(
      chalk.gray(
        scope === "user"
          ? "  Scope: user (guards every project, including ones without their own copy)"
          : `  Scope: this project (use '${cli} guard --install --user' to guard every project)`,
      ),
    );
    console.log(
      chalk.bold.yellow("\nIMPORTANT: You must restart Claude Code for the hook to take effect."),
    );
  }
}

/** A trauma-guard hook found in one of Claude Code's settings files. */
export interface GuardHookRegistration {
  scope: GuardScope;
  settingsPath: string;
  command: string;
  /** Script the command runs from `projectDir` (first existing candidate). */
  scriptPath: string;
  scriptExists: boolean;
  /** The command exits 0 when its script is absent (cm >= GH #93 form). */
  failOpen: boolean;
}

function expandHookPath(token: string, projectDir: string, expandVars: boolean): string {
  // An unquoted `g=/path/trauma_guard.py` token carries its assignment.
  let p = token.replace(/^[A-Za-z_][A-Za-z0-9_]*=/, "");
  if (expandVars) {
    const home = expandPath("~");
    p = p
      .replace(/\$\{CLAUDE_PROJECT_DIR\}|\$CLAUDE_PROJECT_DIR\b/g, projectDir)
      .replace(/\$\{HOME\}|\$HOME\b/g, home);
    if (p === "~" || p.startsWith("~/")) p = expandPath(p);
  }
  return path.resolve(projectDir, p);
}

/**
 * Every trauma-guard PreToolUse hook Claude Code would run in `projectDir`,
 * from the user settings and the project's settings files (GH #93), with the
 * script each one resolves to there.
 */
export async function inspectGuardHooks(
  projectDir: string = process.cwd(),
): Promise<GuardHookRegistration[]> {
  const userDir = resolveUserClaudeDir();
  const projectClaudeDir = path.join(projectDir, ".claude");
  const sources: Array<{ scope: GuardScope; settingsPath: string }> = [
    { scope: "user", settingsPath: path.join(userDir, "settings.json") },
  ];
  // From the home directory the project's .claude IS the user dir.
  if (!(await sameDirectory(projectClaudeDir, userDir))) {
    sources.push(
      { scope: "project", settingsPath: path.join(projectClaudeDir, "settings.json") },
      { scope: "project", settingsPath: path.join(projectClaudeDir, "settings.local.json") },
    );
  }

  const registrations: GuardHookRegistration[] = [];
  for (const { scope, settingsPath } of sources) {
    let settings: any;
    try {
      settings = JSON.parse(await fs.readFile(settingsPath, "utf-8"));
    } catch {
      continue; // Missing or unparseable: nothing Claude Code would run either.
    }
    const entries = settings?.hooks?.PreToolUse;
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const hooks = entry && typeof entry === "object" ? entry.hooks : undefined;
      if (!Array.isArray(hooks)) continue;
      for (const hook of hooks) {
        const command = hook?.command;
        if (typeof command !== "string" || !command.includes(GUARD_SCRIPT_NAME)) continue;
        const candidates: string[] = [];
        const tokenRe =
          /"([^"]*trauma_guard\.py)"|'([^']*trauma_guard\.py)'|([^\s"';|&]*trauma_guard\.py)/g;
        for (const m of command.matchAll(tokenRe)) {
          const singleQuoted = m[2] !== undefined;
          const token = m[1] ?? m[2] ?? m[3] ?? "";
          if (token) candidates.push(expandHookPath(token, projectDir, !singleQuoted));
        }
        let scriptPath = candidates[0] ?? "";
        let scriptExists = false;
        for (const candidate of candidates) {
          if (await fileExists(candidate)) {
            scriptPath = candidate;
            scriptExists = true;
            break;
          }
        }
        registrations.push({
          scope,
          settingsPath,
          command,
          scriptPath,
          scriptExists,
          failOpen: /\bexit 0\b/.test(command),
        });
      }
    }
  }
  return registrations;
}

/**
 * Install git pre-commit hook for trauma pattern detection.
 */
export async function installGitHook(json?: boolean, silent?: boolean): Promise<boolean> {
  const startedAtMs = Date.now();
  const command = "guard";
  const cli = getCliName();
  const scriptName = "trauma-guard-precommit.py";

  // Find git repo root
  const repoDir = await resolveGitRoot();
  if (!repoDir) {
    if (silent) return false;
    reportError("Not in a git repository.", {
      code: ErrorCode.FILE_NOT_FOUND,
      hint: "Run this command from within a git repository.",
      json,
      command,
      startedAtMs,
    });
    return false;
  }

  const gitHooksDir = path.join(repoDir, ".git", "hooks");
  const preCommitPath = path.join(gitHooksDir, "pre-commit");

  // Ensure hooks directory exists
  await ensureDir(gitHooksDir);

  // Check for python3 availability (warn if missing)
  if (!silent) {
    try {
      const { exec } = await import("node:child_process");
      const { promisify } = await import("node:util");
      await promisify(exec)("python3 --version", { timeout: 2000 });
    } catch {
      console.warn(
        chalk.yellow(
          `${iconPrefix("warning")} Warning: 'python3' not found in PATH. The git hook requires Python 3.`,
        ),
      );
    }
  }

  // Check if pre-commit hook exists
  let existingHook = "";
  const hookExists = await fileExists(preCommitPath);
  if (hookExists) {
    existingHook = await fs.readFile(preCommitPath, "utf-8");
    // Check if our hook is already installed
    if (existingHook.includes("trauma-guard-precommit") || existingHook.includes("HOT STOVE")) {
      // The pre-commit wrapper stays as is, but the guard script it calls is
      // cm's own file: rewrite it so a re-run picks up fixes and the current
      // global dir (GH #82). Otherwise `cm guard --git` could never update it.
      let refreshed = false;
      if (existingHook.includes("trauma-guard-precommit")) {
        await fs.writeFile(
          path.join(gitHooksDir, scriptName),
          renderGuardScript(GIT_PRECOMMIT_HOOK, resolveGlobalDir()),
          { encoding: "utf-8", mode: 0o755 },
        );
        refreshed = true;
      }
      if (silent) return true;
      if (json) {
        printJsonResult(
          command,
          {
            message: refreshed
              ? "Git pre-commit trauma guard already installed; guard script refreshed."
              : "Git pre-commit trauma guard already installed.",
            alreadyInstalled: true,
            refreshed,
            hookPath: preCommitPath,
          },
          { startedAtMs },
        );
      } else {
        console.log(
          chalk.blue(`• Git pre-commit trauma guard already installed at ${preCommitPath}`),
        );
        if (refreshed) {
          console.log(chalk.green(`✓ Refreshed ${scriptName} in ${gitHooksDir}`));
        }
      }
      return true;
    }
  }

  // Write the guard script to a separate file
  const guardScriptPath = path.join(gitHooksDir, scriptName);
  await fs.writeFile(guardScriptPath, renderGuardScript(GIT_PRECOMMIT_HOOK, resolveGlobalDir()), {
    encoding: "utf-8",
    mode: 0o755,
  });

  // Create or update pre-commit hook to call our script
  // Escape quotes in path to prevent injection
  const safeGuardPath = guardScriptPath.replace(/"/g, '\\"');
  let newHookContent: string;
  if (hookExists && existingHook.trim()) {
    // Append to existing hook
    const callLine = `\n# Project Hot Stove: Trauma Guard\n"${safeGuardPath}" || exit 1\n`;
    newHookContent = existingHook.trimEnd() + callLine;
  } else {
    // Create new hook
    newHookContent = `#!/bin/sh
# Git pre-commit hook with Project Hot Stove trauma guard

# Trauma Guard: Block commits matching dangerous patterns
"${safeGuardPath}" || exit 1
`;
  }

  await fs.writeFile(preCommitPath, newHookContent, { encoding: "utf-8", mode: 0o755 });

  if (silent) return true;

  if (json) {
    printJsonResult(
      command,
      {
        message: "Git pre-commit trauma guard installed successfully.",
        alreadyInstalled: false,
        hookPath: preCommitPath,
        guardScriptPath,
      },
      { startedAtMs },
    );
  } else {
    console.log(chalk.green(`✓ Installed ${scriptName} to ${gitHooksDir}`));
    console.log(chalk.green(`✓ Updated ${preCommitPath}`));
    console.log(
      chalk.bold.yellow("\nThe trauma guard will now check staged changes before each commit."),
    );
    console.log(chalk.gray("Use 'git commit --no-verify' to bypass (not recommended)."));
  }
  return true;
}
