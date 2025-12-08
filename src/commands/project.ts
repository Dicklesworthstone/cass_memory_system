import { loadConfig } from "../config.js";
import { loadMergedPlaybook, exportToMarkdown } from "../playbook.js";
import { error as logError } from "../utils.js";
import chalk from "chalk";
import fs from "node:fs/promises";

export async function projectCommand(
  flags: { output?: string; format?: string; top?: number }
) {
  const config = await loadConfig();
  const playbook = await loadMergedPlaybook(config);

  let output = "";

  if (flags.format === "json") {
    output = JSON.stringify(playbook, null, 2);
  } else if (flags.format === "yaml") {
    const yaml = await import("yaml");
    output = yaml.stringify(playbook);
  } else {
    // Markdown / AGENTS.md
    output = exportToMarkdown(playbook, { 
      topN: flags.top, 
      showCounts: true 
    });
  }

  if (flags.output) {
    await fs.writeFile(flags.output, output);
    console.log(chalk.green(`✓ Exported to ${flags.output}`));
  } else {
    console.log(output);
  }
}
