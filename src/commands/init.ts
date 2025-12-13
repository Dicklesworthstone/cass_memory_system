import { getDefaultConfig } from "../config.js";
import { createEmptyPlaybook, loadPlaybook, savePlaybook } from "../playbook.js";
import { expandPath, fileExists, warn, log, resolveRepoDir, ensureRepoStructure, ensureGlobalStructure, getCliName } from "../utils.js";
import { cassAvailable } from "../cass.js";
import { applyStarter, loadStarter } from "../starters.js";
import chalk from "chalk";
import yaml from "yaml";
import readline from "node:readline";

type InitOptions = { force?: boolean; json?: boolean; repo?: boolean; starter?: string; interactive?: boolean };

async function promptYesNo(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise<boolean>((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      const normalized = answer.trim().toLowerCase();
      resolve(normalized === "y" || normalized === "yes");
    });
  });
}

export async function initCommand(options: InitOptions) {
  const cli = getCliName();

  // If --repo flag is provided, initialize repo-level .cass/ structure
  if (options.repo) {
    await initRepoCommand(options);
    return;
  }

  const config = getDefaultConfig();
  const configPath = expandPath("~/.cass-memory/config.json");
  const playbookPath = expandPath("~/.cass-memory/playbook.yaml");
  const playbook = createEmptyPlaybook();
  
  const alreadyInitialized = await fileExists(configPath);

  if (alreadyInitialized && !options.force && !options.starter) {
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

  // Privacy-first: cross-agent enrichment requires explicit consent.
  // Only prompt in interactive CLI usage (tests/programmatic calls do not pass `interactive`).
  if (!alreadyInitialized && options.interactive && !options.json && process.stdin.isTTY && process.stdout.isTTY) {
    console.log(chalk.bold(`\nWelcome to ${cli}!\n`));
    console.log("Cross-Agent Enrichment (Optional):");
    console.log("cass-memory can enrich your diary entries by searching sessions from other agents (Claude, Cursor, Codex, etc.).");
    console.log("This never uploads data, but it may pull context across tools on your machine.\n");

    const enable = await promptYesNo("Enable cross-agent enrichment? [y/N]: ");
    if (enable) {
      config.crossAgent = {
        ...config.crossAgent,
        enabled: true,
        consentGiven: true,
        consentDate: new Date().toISOString(),
        // Default to common known agents; user can refine via `cm privacy allow/deny`.
        agents: ["claude", "cursor", "codex", "aider"],
      };
      console.log(chalk.green("\n✓ Cross-agent enrichment enabled.\n"));
    } else {
      config.crossAgent = {
        ...config.crossAgent,
        enabled: false,
        consentGiven: false,
        consentDate: null,
        agents: [],
      };
      console.log(chalk.yellow("\nCross-agent enrichment disabled (default).\n"));
    }
  }

  // Create structure
  const result = await ensureGlobalStructure(
    JSON.stringify(config, null, 2),
    yaml.stringify(playbook)
  );

  let starterOutcome: { added: number; skipped: number; name: string } | null = null;
  if (options.starter) {
    try {
      starterOutcome = await seedStarter(playbookPath, options.starter);
    } catch (err: any) {
      if (options.json) {
        console.log(JSON.stringify({
          success: false,
          error: err?.message || "Failed to apply starter"
        }));
      } else {
        console.error(chalk.red(err?.message || "Failed to apply starter"));
      }
      return;
    }
  }

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
      created: result.created,
      existed: result.existed,
      cassAvailable: cassOk,
      starter: starterOutcome
    }, null, 2));
  } else {
    if (result.created.length > 0) {
      for (const file of result.created) {
        console.log(chalk.green(`✓ Created ~/.cass-memory/${file}`));
      }
    }
    if (result.existed.length > 0) {
      for (const file of result.existed) {
        console.log(chalk.blue(`• ~/.cass-memory/${file} already exists`));
      }
    }
    
    // Ensure subdirectories are mentioned if created (implied by ensureGlobalStructure success)
    const diaryDir = expandPath("~/.cass-memory/diary");
    console.log(chalk.green(`✓ Verified directories: ${diaryDir} etc.`));

    console.log(`✓ cass available: ${cassOk ? chalk.green("yes") : chalk.red("no")}`);
    if (starterOutcome) {
      console.log(chalk.green(`✓ Applied starter "${starterOutcome.name}" (${starterOutcome.added} added, ${starterOutcome.skipped} skipped)`));
    }
    console.log("");
    console.log(chalk.bold(`${cli} initialized successfully!`));
    console.log("");
    console.log("Next steps:");
    console.log(chalk.cyan(`  ${cli} context "your task" --json  # Get context for a task`));
    console.log(chalk.cyan(`  ${cli} doctor                     # Check system health`));
    console.log(chalk.cyan(`  ${cli} init --repo                # Initialize repo-level .cass/`));
  }
}

async function seedStarter(
  playbookPath: string,
  starterName: string
): Promise<{ added: number; skipped: number; name: string }> {
  const starter = await loadStarter(starterName);
  if (!starter) {
    throw new Error(`Starter "${starterName}" not found. Run "${getCliName()} starters" to list available names.`);
  }

  const playbook = await loadPlaybook(playbookPath);
  const { added, skipped } = applyStarter(playbook, starter, { preferExisting: true });
  await savePlaybook(playbook, playbookPath);

  return { added, skipped, name: starterName };
}

/**
 * Initialize repo-level .cass/ directory structure.
 * Creates project-specific playbook and blocked.log for team sharing.
 */
async function initRepoCommand(options: InitOptions) {
  const cassDir = await resolveRepoDir();

  if (!cassDir) {
    if (options.json) {
      console.log(JSON.stringify({
        success: false,
        error: "Not in a git repository. Run from within a git repo."
      }));
    } else {
      console.error(chalk.red("Error: Not in a git repository."));
      console.error("Run this command from within a git repository.");
    }
    process.exit(1);
  }

  // Check if already initialized
  const playbookPath = `${cassDir}/playbook.yaml`;
  const alreadyInitialized = await fileExists(playbookPath);

  if (alreadyInitialized && !options.force && !options.starter) {
    if (options.json) {
      console.log(JSON.stringify({
        success: false,
        error: "Repo already has .cass/ directory. Use --force to reinitialize."
      }));
    } else {
      console.log(chalk.yellow("Repo already has .cass/ directory. Use --force to reinitialize."));
    }
    return;
  }

  // Create the structure
  const result = await ensureRepoStructure(cassDir);

  let starterOutcome: { added: number; skipped: number; name: string } | null = null;
  if (options.starter) {
    try {
      starterOutcome = await seedStarter(playbookPath, options.starter);
    } catch (err: any) {
      if (options.json) {
        console.log(JSON.stringify({
          success: false,
          error: err?.message || "Failed to apply starter"
        }));
      } else {
        console.error(chalk.red(err?.message || "Failed to apply starter"));
      }
      return;
    }
  }

  if (options.json) {
    console.log(JSON.stringify({
      success: true,
      cassDir,
      created: result.created,
      existed: result.existed,
      starter: starterOutcome
    }, null, 2));
  } else {
    console.log(chalk.bold("\n🏗️  Initializing repo-level .cass/ structure\n"));

    if (result.created.length > 0) {
      for (const file of result.created) {
        console.log(chalk.green(`✓ Created .cass/${file}`));
      }
    }

    if (result.existed.length > 0) {
      for (const file of result.existed) {
        console.log(chalk.blue(`• .cass/${file} already exists`));
      }
    }

    if (starterOutcome) {
      console.log(chalk.green(`✓ Applied starter "${starterOutcome.name}" (${starterOutcome.added} added, ${starterOutcome.skipped} skipped)`));
    }

    console.log("");
    console.log(chalk.bold("Repo-level cass-memory initialized!"));
    console.log("");
    console.log("The .cass/ directory contains:");
    console.log(chalk.cyan("  • playbook.yaml  - Project-specific rules (commit to git)"));
    console.log(chalk.cyan("  • blocked.log    - Blocked patterns for this project"));
    console.log("");
    console.log("These files are merged with your global ~/.cass-memory/ settings.");
    console.log("Project rules take precedence over global rules.");
    console.log("");
    console.log(chalk.yellow("Remember: Commit .cass/ to version control to share with your team!"));
  }
}
