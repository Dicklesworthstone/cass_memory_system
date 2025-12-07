import { loadConfig } from "../config.js";
import { loadPlaybook } from "../playbook.js";
import { cassAvailable, cassSearch } from "../cass.js";
import { extractKeywords, scoreBulletRelevance, log } from "../utils.js";
import { PlaybookBullet } from "../types.js";
import chalk from "chalk";

export async function contextCommand(
  task: string,
  options: {
    workspace?: string;
    maxBullets?: number;
    maxHistory?: number;
    json?: boolean;
  } = {}
): Promise<void> {
  const config = await loadConfig();
  const playbook = await loadPlaybook(config);

  const maxBullets = options.maxBullets || config.maxBulletsInContext;
  const maxHistory = options.maxHistory || config.maxHistoryInContext;

  log(`Generating context for task: "${task}"`, true);

  // 1. Extract keywords
  const keywords = extractKeywords(task);
  log(`Keywords: ${keywords.join(", ")}`, true);

  // 2. Search cass history
  let history: any[] = [];
  if (cassAvailable(config.cassPath)) {
    const results = await cassSearch(keywords.join(" "), {
      limit: maxHistory,
      days: config.sessionLookbackDays,
      workspace: options.workspace,
    });
    history = results;
  } else {
    log("cass not available - skipping history search", true);
  }

  // 3. Score bullets
  const scoredBullets = playbook.bullets
    .filter(b => !b.deprecated && b.state !== 'retired')
    .map(b => ({
      bullet: b,
      score: scoreBulletRelevance(b.content, b.tags, keywords)
    }))
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxBullets);

  const relevantBullets = scoredBullets.map(s => s.bullet);

  // 4. Output
  if (options.json) {
    console.log(JSON.stringify({
      task,
      relevantBullets,
      history
    }, null, 2));
  } else {
    console.log(chalk.bold("\n## Relevant Playbook Rules"));
    if (relevantBullets.length === 0) {
      console.log(chalk.gray("(No relevant rules found)"));
    } else {
      relevantBullets.forEach(b => {
        console.log(`${chalk.cyan(`[${b.id}]`)} ${b.content}`);
      });
    }

    console.log(chalk.bold("\n## Relevant History"));
    if (history.length === 0) {
      console.log(chalk.gray("(No history found)"));
    } else {
      history.forEach((h: any) => {
        console.log(chalk.dim(`--- ${h.source_path} ---`));
        console.log(h.snippet.trim());
      });
    }
    console.log(""); // trailing newline
  }
}