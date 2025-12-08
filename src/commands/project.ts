import { loadConfig } from "../config.js";
import { loadMergedPlaybook, getActiveBullets, savePlaybook } from "../playbook.js";
import { exportToMarkdown } from "../playbook.js";
import { expandPath, error as logError } from "../utils.js";
import fs from "node:fs/promises";
import path from "node:path";
import chalk from "chalk";

export async function projectCommand(
  options: { 
    format?: "agents.md" | "claude.md" | "raw";
    output?: string;
    top?: number;
    showCounts?: boolean;
  }
): Promise<void> {
  const config = await loadConfig();
  const playbook = await loadMergedPlaybook(config);
  
  const format = options.format || "agents.md";
  let content = "";

  if (format === "raw") {
    content = JSON.stringify(playbook, null, 2);
  } else {
    // Markdown formats
    // Currently exportToMarkdown supports AGENTS.md style.
    // claude.md might be slightly different but AGENTS.md is standard.
    content = exportToMarkdown(playbook, {
      topN: options.top,
      showCounts: options.showCounts ?? true,
      includeAntiPatterns: true
    });
  }

  if (options.output) {
    const outputPath = expandPath(options.output);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, content, "utf-8");
    console.log(chalk.green(`✓ Exported playbook to ${outputPath}`));
  } else {
    console.log(content);
  }
}