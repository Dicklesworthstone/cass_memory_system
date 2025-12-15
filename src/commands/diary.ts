// src/commands/diary.ts
// Diary generation command - Generate a structured diary from a coding session

import { loadConfig } from "../config.js";
import { generateDiary } from "../diary.js";
import { expandPath, error as logError, printJsonResult, printJsonError } from "../utils.js";
import { ErrorCode } from "../types.js";
import { cassExport, cassAvailable } from "../cass.js";
import fs from "node:fs/promises";
import path from "node:path";
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
  // Validate session path exists
  const validatedPath = await validateSessionPath(sessionPath);
  if (!validatedPath) {
    if (options.json) {
      printJsonError(`Session file not found: ${sessionPath}`, {
        code: ErrorCode.FILE_NOT_FOUND,
        details: { path: sessionPath }
      });
    } else {
      logError(`Session file not found: ${sessionPath}`);
    }
    process.exitCode = 1;
    return;
  }

  const config = await loadConfig();

  try {
    // Generate the diary
    const diary = await generateDiary(validatedPath, config);

    // Handle output
    await handleDiaryOutput(diary, options, config);

  } catch (err: any) {
    if (options.json) {
      printJsonError(`Failed to generate diary: ${err.message}`, {
        code: ErrorCode.REFLECTION_FAILED,
        details: { sessionPath }
      });
    } else {
      logError(`Failed to generate diary: ${err.message}`);
    }
    process.exitCode = 1;
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

  const expanded = expandPath(sessionPath);

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
  config: import("../types.js").Config
): Promise<void> {
  if (options.json) {
    printJsonResult({ diary });
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
  if (!options.save && config.diaryDir) {
    console.log(chalk.dim(`\n${iconPrefix("folder")}Saved to: ${config.diaryDir}/${diary.id}.json`));
  }
}
