import chalk from "chalk";
import { listStarters } from "../starters.js";
import { getCliName, printJsonResult } from "../utils.js";

export interface StartersOptions {
  json?: boolean;
}

export async function startersCommand(options: StartersOptions = {}) {
  const startedAtMs = Date.now();
  const command = "starters";
  const starters = await listStarters();

  if (options.json) {
    printJsonResult(command, { starters }, { startedAtMs });
    return;
  }

  if (starters.length === 0) {
    console.log(chalk.yellow("No starters found. Add custom starters under ~/.cass-memory/starters/."));
    return;
  }

  const builtins = starters.filter((s) => s.source === "builtin");
  const customs = starters.filter((s) => s.source === "custom");

  if (builtins.length > 0) {
    console.log(chalk.bold("\nBuilt-in starters:\n"));
    for (const starter of builtins) {
      console.log(`• ${chalk.cyan(starter.name)} - ${starter.description} (${starter.bulletCount} rules)`);
    }
  }

  if (customs.length > 0) {
    console.log(chalk.bold("\nCustom starters:\n"));
    for (const starter of customs) {
      const location = starter.path ? ` [${starter.path}]` : "";
      console.log(`• ${chalk.green(starter.name)} - ${starter.description} (${starter.bulletCount} rules)${location}`);
    }
  }

  console.log("");
  const cli = getCliName();
  console.log(chalk.gray(`Seed a playbook with: ${cli} init --starter=<name>`));
}
