// src/commands/diary.ts
// Diary generation command - Generate a structured diary from a coding session

import { loadConfig, getSanitizeConfig } from "../config.js";
import { generateDiary, generateDiaryFromContent, formatRawSession } from "../diary.js";
import { sanitize, compileExtraPatterns } from "../sanitize.js";
import { expandPath, printJsonResult, reportError } from "../utils.js";
import { ErrorCode } from "../types.js";
import path from "node:path";
import fs from "node:fs/promises";
import chalk from "chalk";
import { iconPrefix } from "../output.js";

export interface DiaryCommandOptions {
  /** Output format: json or human-readable */
  json?: boolean;
  /** Save to diary directory instead of printing */
  save?: boolean;
  /** Skip cass export, use raw file */
  raw?: boolean;
}

/**
 * Main entry point for the 'cass-memory diary' command.
 *
 * @param sessionPath - Path to the session file to generate diary from
 * @param options - Command options
 *
 * @example
 * cass-memory diary ~/.claude/projects/.../session.jsonl
 * cass-memory diary ./session.jsonl --json
 * cass-memory diary ./session.jsonl --save
 */
export async function diaryCommand(
  sessionPath: string,
  options: DiaryCommandOptions = {}
): Promise<void> {
  const startedAtMs = Date.now();
  const command = "diary";
  // Validate session path exists
  const validatedPath = await validateSessionPath(sessionPath);
  if (!validatedPath) {
    reportError(`Session file not found: ${sessionPath}`, {
      code: ErrorCode.FILE_NOT_FOUND,
      details: { path: sessionPath },
      json: options.json,
      command,
      startedAtMs,
    });
    return;
  }

  const config = await loadConfig();

  try {
    // Generate the diary
    let diary: import("../types.js").DiaryEntry;
    if (options.raw) {
      const rawContent = await fs.readFile(validatedPath, "utf-8");
      const ext = path.extname(validatedPath).toLowerCase();
      const shouldFormat =
        ext === ".jsonl" || ext === ".json" || ext === ".md" || ext === ".markdown";
      const formatted = shouldFormat ? formatRawSession(rawContent, ext) : rawContent;

      const sanitizeConfig = getSanitizeConfig(config);
      const compiledConfig = {
        ...sanitizeConfig,
        extraPatterns: compileExtraPatterns(sanitizeConfig.extraPatterns)
      };
      const sanitized = sanitize(formatted, compiledConfig);

      diary = await generateDiaryFromContent(validatedPath, sanitized, config);
    } else {
      diary = await generateDiary(validatedPath, config);
    }

    // Handle output
    await handleDiaryOutput(diary, options, config, { command, startedAtMs });

  } catch (err: any) {
    const message = err?.message || String(err);
    reportError(`Failed to generate diary: ${message}`, {
      code: ErrorCode.REFLECTION_FAILED,
      details: { sessionPath },
      json: options.json,
      command,
      startedAtMs,
    });
  }
}

/**
 * Validate that a session path exists and is readable.
 *
 * @param sessionPath - Path to validate (can be relative or use ~)
 * @returns Expanded absolute path if valid, null if not found
 */
export async function validateSessionPath(sessionPath: string): Promise<string | null> {
  // Handle empty or missing path
  if (!sessionPath || sessionPath.trim() === "") {
    return null;
  }

  const expanded = path.resolve(expandPath(sessionPath));

  try {
    const stat = await fs.stat(expanded);
    if (!stat.isFile()) {
      return null;
    }
    return expanded;
  } catch {
    return null;
  }
}

/**
 * Handle diary output - either print to console or save to file.
 *
 * @param diary - The generated diary entry
 * @param options - Command options controlling output format
 * @param config - Configuration including diary directory
 */
export async function handleDiaryOutput(
  diary: import("../types.js").DiaryEntry,
  options: DiaryCommandOptions,
  config: import("../types.js").Config,
  meta: { command: string; startedAtMs: number }
): Promise<void> {
  const savedPath = config.diaryDir
    ? path.join(expandPath(config.diaryDir), `${diary.id}.json`)
    : null;

  if (options.json) {
    printJsonResult(meta.command, { diary, savedTo: savedPath }, { startedAtMs: meta.startedAtMs });
    return;
  }

  if (options.save) {
    const location = savedPath || "(unknown path)";
    console.log(chalk.dim(`${iconPrefix("folder")}Saved diary ${diary.id} to: ${location}`));
    return;
  }

  // Human-readable output
  console.log(chalk.bold.blue(`\n${iconPrefix("diary")}Diary: ${diary.id}\n`));
  console.log(chalk.dim(`Session: ${diary.sessionPath}`));
  console.log(chalk.dim(`Agent: ${diary.agent}`));
  console.log(chalk.dim(`Workspace: ${diary.workspace}`));
  console.log(chalk.dim(`Timestamp: ${diary.timestamp}`));

  const statusColor = diary.status === "success" ? chalk.green :
    diary.status === "failure" ? chalk.red : chalk.yellow;
  console.log(`Status: ${statusColor(diary.status)}\n`);

  if (diary.accomplishments.length > 0) {
    console.log(chalk.green.bold(`${iconPrefix("check")}Accomplishments:`));
    diary.accomplishments.forEach(a => console.log(`  • ${a}`));
    console.log();
  }

  if (diary.decisions.length > 0) {
    console.log(chalk.blue.bold(`${iconPrefix("target")}Decisions:`));
    diary.decisions.forEach(d => console.log(`  • ${d}`));
    console.log();
  }

  if (diary.challenges.length > 0) {
    console.log(chalk.yellow.bold(`${iconPrefix("warning")}Challenges:`));
    diary.challenges.forEach(c => console.log(`  • ${c}`));
    console.log();
  }

  if (diary.keyLearnings.length > 0) {
    console.log(chalk.magenta.bold(`${iconPrefix("tip")}Key Learnings:`));
    diary.keyLearnings.forEach(l => console.log(`  • ${l}`));
    console.log();
  }

  if (diary.preferences.length > 0) {
    console.log(chalk.cyan.bold(`${iconPrefix("palette")}Preferences:`));
    diary.preferences.forEach(p => console.log(`  • ${p}`));
    console.log();
  }

  if (diary.tags.length > 0) {
    console.log(chalk.dim(`Tags: ${diary.tags.join(", ")}`));
  }

  if (diary.relatedSessions.length > 0) {
    console.log(chalk.dim(`\nRelated Sessions: ${diary.relatedSessions.length} found`));
    diary.relatedSessions.slice(0, 3).forEach(r => {
      console.log(chalk.dim(`  • ${r.agent}: ${r.snippet.slice(0, 50)}...`));
    });
  }

  // Note about saving
  if (savedPath) {
    console.log(chalk.dim(`\n${iconPrefix("folder")}Saved to: ${savedPath}`));
  }
}
