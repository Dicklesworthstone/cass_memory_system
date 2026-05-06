import fs from "node:fs/promises";
import path from "node:path";
import chalk from "chalk";
import { TRAUMA_GUARD_SCRIPT, GIT_PRECOMMIT_HOOK } from "../trauma_guard_script.js";
import {
  ensureDir,
  fileExists,
  getCliName,
  printJsonResult,
  reportError,
  resolveGitRoot
} from "../utils.js";
import { ErrorCode } from "../types.js";
import { iconPrefix } from "../output.js";

export async function guardCommand(flags: { install?: boolean; git?: boolean; json?: boolean }) {
  const startedAtMs = Date.now();
  const command = "guard";
  const cli = getCliName();

  try {
    if (flags.install) {
      await installGuard(flags.json);
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

export async function installGuard(json?: boolean, silent?: boolean) {
  const startedAtMs = Date.now();
  const command = "guard";
  const cli = getCliName();
  const claudeDir = ".claude";
  const hooksDir = path.join(claudeDir, "hooks");
  const settingsPath = path.join(claudeDir, "settings.json");
  const scriptName = "trauma_guard.py";
  const scriptPath = path.join(hooksDir, scriptName);

  // 1. Ensure directories
  if (!(await fileExists(claudeDir))) {
    if (silent) return;
    reportError("No .claude directory found. Is this a Claude Code project?", {
      code: ErrorCode.FILE_NOT_FOUND,
      hint: `Run this command from a project root that contains a .claude directory.`,
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
      console.warn(chalk.yellow(`${iconPrefix("warning")} Warning: 'python3' not found in PATH. The trauma guard requires Python 3.`));
    }
  }

  // 2. Write Script
  await fs.writeFile(scriptPath, TRAUMA_GUARD_SCRIPT, { encoding: "utf-8", mode: 0o755 });

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
      [
        "-c",
        `import ast,sys; ast.parse(open(sys.argv[1]).read()); print("ok")`,
        scriptPath,
      ],
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
      const msg = "Error: Could not parse .claude/settings.json (invalid JSON or comments). Aborting to prevent data loss.";
      if (!silent) {
        reportError(msg, {
          code: ErrorCode.CONFIG_INVALID,
          hint: `Fix ${settingsPath} (must be strict JSON), then re-run: ${cli} guard --install`,
          details: { path: settingsPath },
          json,
          command,
          startedAtMs,
        });
        if (!json) {
          console.error("Please manually add this hook to 'PreToolUse':");
          console.log(
            JSON.stringify(
              {
                matcher: "Bash",
                hooks: [{ type: "command", command: `$CLAUDE_PROJECT_DIR/.claude/hooks/${scriptName}` }],
              },
              null,
              2
            )
          );
        }
      }
      return;
    }
  }

  // Ensure hooks structure (defensive: settings.json is user-owned)
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) settings = {};
  if (!settings.hooks || typeof settings.hooks !== "object" || Array.isArray(settings.hooks)) settings.hooks = {};
  if (!Array.isArray(settings.hooks.PreToolUse)) settings.hooks.PreToolUse = [];

  // Check if already installed
  const alreadyInstalled = (settings.hooks.PreToolUse as any[]).some((entry: any) => {
    if (!entry || typeof entry !== "object") return false;
    const hooks = (entry as any).hooks;
    if (!Array.isArray(hooks)) return false;
    return hooks.some((hook: any) => typeof hook?.command === "string" && hook.command.includes(scriptName));
  });

  if (!alreadyInstalled) {
    // Add hook
    settings.hooks.PreToolUse.push({
      matcher: "Bash",
      hooks: [
        {
          type: "command",
          command: `$CLAUDE_PROJECT_DIR/.claude/hooks/${scriptName}`
        }
      ]
    });
    
    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
  }

  if (silent) return;

  if (json) {
    printJsonResult(
      command,
      {
        message: alreadyInstalled ? "Trauma guard already installed." : "Trauma guard installed successfully.",
        alreadyInstalled,
        scriptPath,
        settingsPath,
      },
      { startedAtMs }
    );
  } else {
    console.log(chalk.green(`✓ Installed ${scriptName} to ${hooksDir}`));
    console.log(chalk.green(`✓ ${alreadyInstalled ? "Verified" : "Updated"} ${settingsPath}`));
    console.log(chalk.bold.yellow("\nIMPORTANT: You must restart Claude Code for the hook to take effect."));
  }
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
      console.warn(chalk.yellow(`${iconPrefix("warning")} Warning: 'python3' not found in PATH. The git hook requires Python 3.`));
    }
  }

  // Check if pre-commit hook exists
  let existingHook = "";
  const hookExists = await fileExists(preCommitPath);
  if (hookExists) {
    existingHook = await fs.readFile(preCommitPath, "utf-8");
    // Check if our hook is already installed
    if (existingHook.includes("trauma-guard-precommit") || existingHook.includes("HOT STOVE")) {
      if (silent) return true;
      if (json) {
        printJsonResult(command, {
          message: "Git pre-commit trauma guard already installed.",
          alreadyInstalled: true,
          hookPath: preCommitPath,
        }, { startedAtMs });
      } else {
        console.log(chalk.blue(`• Git pre-commit trauma guard already installed at ${preCommitPath}`));
      }
      return true;
    }
  }

  // Write the guard script to a separate file
  const guardScriptPath = path.join(gitHooksDir, scriptName);
  await fs.writeFile(guardScriptPath, GIT_PRECOMMIT_HOOK, { encoding: "utf-8", mode: 0o755 });

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
    printJsonResult(command, {
      message: "Git pre-commit trauma guard installed successfully.",
      alreadyInstalled: false,
      hookPath: preCommitPath,
      guardScriptPath,
    }, { startedAtMs });
  } else {
    console.log(chalk.green(`✓ Installed ${scriptName} to ${gitHooksDir}`));
    console.log(chalk.green(`✓ Updated ${preCommitPath}`));
    console.log(chalk.bold.yellow("\nThe trauma guard will now check staged changes before each commit."));
    console.log(chalk.gray("Use 'git commit --no-verify' to bypass (not recommended)."));
  }
  return true;
}
