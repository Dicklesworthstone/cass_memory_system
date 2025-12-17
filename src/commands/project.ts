import { loadConfig } from "../config.js";
import {
  loadMergedPlaybook,
  exportToAgentsMd,
  exportToClaudeMd
} from "../playbook.js";
import {
  fileExists,
  getCliName,
  atomicWrite,
  reportError,
  printJsonResult,
  validateNonEmptyString,
  validateOneOf,
  validatePositiveInt,
} from "../utils.js";
import { ErrorCode } from "../types.js";
import chalk from "chalk";
import { icon } from "../output.js";

export async function projectCommand(
  flags: { output?: string; force?: boolean; format?: string; top?: number; showCounts?: boolean; json?: boolean }
) {
  const startedAtMs = Date.now();
  const command = "project";
  const cli = getCliName();

  const allowedFormats = ["agents.md", "agents", "claude.md", "claude", "raw", "json", "yaml"] as const;
  const formatCheck = validateOneOf(flags.format, "format", allowedFormats, {
    allowUndefined: true,
    caseInsensitive: true,
  });
  if (!formatCheck.ok) {
    reportError(formatCheck.message, {
      code: ErrorCode.INVALID_INPUT,
      details: formatCheck.details,
      hint: `Valid formats: ${allowedFormats.join(", ")}`,
      json: flags.json,
      command,
      startedAtMs,
    });
    return;
  }

  const topCheck = validatePositiveInt(flags.top, "top", { min: 1, allowUndefined: true });
  if (!topCheck.ok) {
    reportError(topCheck.message, {
      code: ErrorCode.INVALID_INPUT,
      details: topCheck.details,
      hint: `Example: ${cli} project --top 5 --format agents.md`,
      json: flags.json,
      command,
      startedAtMs,
    });
    return;
  }

  const outputCheck = validateNonEmptyString(flags.output, "output", { allowUndefined: true });
  if (!outputCheck.ok) {
    reportError(outputCheck.message, {
      code: ErrorCode.INVALID_INPUT,
      details: outputCheck.details,
      hint: `Example: ${cli} project --output AGENTS.md`,
      json: flags.json,
      command,
      startedAtMs,
    });
    return;
  }

  try {
    const config = await loadConfig();
    const playbook = await loadMergedPlaybook(config);
    const showCounts = flags.showCounts !== false; // default true

    let output = "";

    const format = formatCheck.value;
    switch (format) {
      case "raw":
      case "json":
        output = JSON.stringify(playbook, null, 2);
        break;
      case "yaml": {
        const yaml = await import("yaml");
        output = yaml.stringify(playbook);
        break;
      }
      case "claude.md":
      case "claude":
        output = exportToClaudeMd(playbook, config, {
          topN: topCheck.value,
          showCounts
        });
        break;
      case "agents.md":
      case "agents":
      default:
        output = exportToAgentsMd(playbook, config, {
          topN: topCheck.value,
          showCounts
        });
        break;
    }

    if (outputCheck.value) {
      const outputPath = outputCheck.value;

      if (!flags.force && (await fileExists(outputPath))) {
        const quotedPath = JSON.stringify(outputPath);
        reportError(`Refusing to overwrite existing file: ${outputPath}`, {
          code: ErrorCode.ALREADY_EXISTS,
          hint: `Re-run with: ${cli} project --output ${quotedPath} --force`,
          details: { outputPath },
          json: flags.json,
          command,
          startedAtMs,
        });
        return;
      }

      await atomicWrite(outputPath, output);
      if (flags.json) {
        printJsonResult(
          command,
          { outputPath, format: format ?? "agents.md", bytesWritten: Buffer.byteLength(output, "utf-8") },
          { startedAtMs }
        );
      } else {
        console.log(chalk.green(`${icon("success")} Exported to ${outputPath}`));
      }
      return;
    }

    if (flags.json) {
      printJsonResult(command, { format: format ?? "agents.md", content: output }, { startedAtMs });
    } else {
      console.log(output);
    }
  } catch (err: any) {
    reportError(err instanceof Error ? err : String(err), {
      code: ErrorCode.INTERNAL_ERROR,
      json: flags.json,
      command,
      startedAtMs,
    });
  }
}
