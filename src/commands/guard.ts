import fs from "node:fs/promises";
import path from "node:path";
import chalk from "chalk";
import { TRAUMA_GUARD_SCRIPT } from "../trauma_guard_script.js";
import { 
  ensureDir, 
  fileExists, 
  getCliName, 
  reportError 
} from "../utils.js";
import { ErrorCode } from "../types.js";

export async function guardCommand(flags: { install?: boolean; json?: boolean }) {
  const startedAtMs = Date.now();
  const command = "guard";

  try {
    if (flags.install) {
      await installGuard(flags.json);
      return;
    }

    console.log("Usage: cm guard --install");
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
  const claudeDir = ".claude";
  const hooksDir = path.join(claudeDir, "hooks");
  const settingsPath = path.join(claudeDir, "settings.json");
  const scriptName = "trauma_guard.py";
  const scriptPath = path.join(hooksDir, scriptName);

  // 1. Ensure directories
  if (!(await fileExists(claudeDir))) {
    if (json) {
      console.log(JSON.stringify({ success: false, error: "No .claude directory found. Is this a Claude Code project?" }));
      return;
    }
    if (!silent) {
      console.error(chalk.red("Error: No .claude directory found."));
      console.error("Run this command from the root of a project managed by Claude Code.");
    }
    return;
  }

  await ensureDir(hooksDir);

  // 2. Write Script
  await fs.writeFile(scriptPath, TRAUMA_GUARD_SCRIPT, { encoding: "utf-8", mode: 0o755 });

  // 3. Update settings.json
  let settings: any = {};
  if (await fileExists(settingsPath)) {
    try {
      const content = await fs.readFile(settingsPath, "utf-8");
      settings = JSON.parse(content);
    } catch (e) {
      const msg = "Error: Could not parse .claude/settings.json (invalid JSON or comments). Aborting to prevent data loss.";
      if (json) {
        console.log(JSON.stringify({ success: false, error: msg }));
        return;
      }
      if (!silent) {
        console.error(chalk.red(msg));
        console.error("Please manually add this hook to 'PreToolUse':");
        console.log(JSON.stringify({
          matcher: "Bash",
          hooks: [{ type: "command", command: `$CLAUDE_PROJECT_DIR/.claude/hooks/${scriptName}` }]
        }, null, 2));
      }
      return;
    }
  }

  // Ensure hooks structure
  settings.hooks = settings.hooks || {};
  settings.hooks.PreToolUse = settings.hooks.PreToolUse || [];

  // Check if already installed
  const existingIdx = settings.hooks.PreToolUse.findIndex((h: any) => 
    h.hooks && h.hooks.some((cmd: any) => cmd.command?.includes(scriptName))
  );

  if (existingIdx === -1) {
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
    console.log(JSON.stringify({ success: true, message: "Trauma guard installed successfully." }));
  } else {
    console.log(chalk.green(`✓ Installed ${scriptName} to ${hooksDir}`));
    console.log(chalk.green(`✓ Updated ${settingsPath}`));
    console.log(chalk.bold.yellow("\nIMPORTANT: You must restart Claude Code for the hook to take effect."));
  }
}
