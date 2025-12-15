import { loadConfig } from "../config.js";
import {
  loadMergedPlaybook,
  exportToMarkdown,
  exportToAgentsMd,
  exportToClaudeMd
} from "../playbook.js";
import { error as logError, fileExists, getCliName, atomicWrite } from "../utils.js";
import chalk from "chalk";
import { icon } from "../output.js";

export async function projectCommand(
  flags: { output?: string; force?: boolean; format?: string; top?: number; showCounts?: boolean }
) {
  try {
    const config = await loadConfig();
    const playbook = await loadMergedPlaybook(config);
    const showCounts = flags.showCounts !== false; // default true

    let output = "";

    switch (flags.format) {
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
          topN: flags.top,
          showCounts
        });
        break;
      case "agents.md":
      case "agents":
      default:
        output = exportToAgentsMd(playbook, config, {
          topN: flags.top,
          showCounts
        });
        break;
    }

    if (flags.output) {
      const outputPath = flags.output;

      if (!flags.force && (await fileExists(outputPath))) {
        const cli = getCliName();
        const quotedPath = JSON.stringify(outputPath);
        console.error(chalk.red(`Refusing to overwrite existing file: ${outputPath}`));
        console.error(chalk.gray(`Re-run with: ${cli} project --output ${quotedPath} --force`));
        process.exitCode = 1;
        return;
      }

      await atomicWrite(outputPath, output);
      console.log(chalk.green(`${icon("success")} Exported to ${outputPath}`));
      return;
    }

    console.log(output);
  } catch (err: any) {
    logError(err?.message || String(err));
    process.exitCode = 1;
  }
}
