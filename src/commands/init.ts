import { getDefaultConfig, saveConfig } from "../config.js";
import { createEmptyPlaybook, savePlaybook } from "../playbook.js";
import { expandPath, fileExists, ensureDir, warn, log } from "../utils.js";
import { cassAvailable } from "../cass.js";
import chalk from "chalk";

export async function initCommand(options: { force?: boolean; json?: boolean }) {
  const config = getDefaultConfig();
  const configPath = expandPath("~/.cass-memory/config.json");
  const playbookPath = expandPath(config.playbookPath);
  const diaryDir = expandPath(config.diaryDir);
  const reflectionsDir = expandPath("~/.cass-memory/reflections");
  const embeddingsDir = expandPath("~/.cass-memory/embeddings");
  const costDir = expandPath("~/.cass-memory/cost");
  
  const alreadyInitialized = await fileExists(configPath);
  
  if (alreadyInitialized && !options.force) {
    if (options.json) {
      console.log(JSON.stringify({
        success: false,
        error: "Already initialized. Use --force to reinitialize."
      }));
    } else {
      log(chalk.yellow("Already initialized. Use --force to reinitialize."), true);
    }
    return;
  }

  // 1. Create directories
  await ensureDir(diaryDir);
  await ensureDir(reflectionsDir);
  await ensureDir(embeddingsDir);
  await ensureDir(costDir);

  // 2. Create default config
  await saveConfig(config);

  // 3. Create empty playbook
  const playbook = createEmptyPlaybook();
  await savePlaybook(playbook, playbookPath);

  // 4. Check cass
  const cassOk = cassAvailable(config.cassPath);
  if (!cassOk && !options.json) {
    warn("cass is not available. Some features will not work.");
    console.log("Install cass from https://github.com/Dicklesworthstone/coding_agent_session_search");
  }

  // Output
  if (options.json) {
    console.log(JSON.stringify({
      success: true,
      configPath,
      playbookPath,
      cassAvailable: cassOk
    }, null, 2));
  } else {
    console.log(chalk.green("✓ Created ~/.cass-memory/config.json"));
    console.log(chalk.green("✓ Created ~/.cass-memory/playbook.yaml"));
    console.log(chalk.green(`✓ Created directories: ${diaryDir}, ${reflectionsDir}, ${embeddingsDir}`));
    console.log(`✓ cass available: ${cassOk ? chalk.green("yes") : chalk.red("no")}`);
    console.log("");
    console.log(chalk.bold("cass-memory initialized successfully!"));
    console.log("");
    console.log("Next steps:");
    console.log(chalk.cyan("  cass-memory context \"your task\" --json  # Get context for a task"));
    console.log(chalk.cyan("  cass-memory doctor                       # Check system health"));
  }
}
