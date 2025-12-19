import { installGuard } from "./guard.js";
import { getDefaultConfig } from "../config.js";
import { createEmptyPlaybook, loadPlaybook, savePlaybook } from "../playbook.js";
import { expandPath, fileExists, warn, resolveRepoDir, ensureRepoStructure, ensureGlobalStructure, getCliName, printJsonResult, atomicWrite, reportError, now } from "../utils.js";
import { ErrorCode, Config, TraumaEntry } from "../types.js";
import { scanForTraumas, saveTrauma } from "../trauma.js";
import { cassAvailable } from "../cass.js";
import { applyStarter, loadStarter } from "../starters.js";
import chalk from "chalk";
import yaml from "yaml";
import readline from "node:readline";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { iconPrefix, icon, formatKv } from "../output.js";

type InitOptions = { force?: boolean; yes?: boolean; json?: boolean; repo?: boolean; starter?: string; interactive?: boolean };

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

async function runTraumaScan(config: Config) {
  console.log(chalk.bold("\n🔥 Project Hot Stove: Trauma Scan"));
  console.log("We can scan your past agent sessions for 'catastrophic' patterns (e.g., apologies followed by destruction).");
  console.log("This will seed your safety guard so you don't repeat past mistakes.\n");

  const doit = await promptYesNo("Scan past 90 days of history? [y/N]: ");
  if (!doit) return;

  console.log(chalk.gray("Scanning... (this may take a moment)"));
  const candidates = await scanForTraumas(config, 90);

  if (candidates.length === 0) {
    console.log(chalk.green("No obvious traumas found. Great job!"));
    return;
  }

  console.log(chalk.yellow(`\nFound ${candidates.length} potential traumas:`));
  for (const c of candidates) {
    console.log(`- ${chalk.red(c.matchedPattern)} (${c.description})`);
    console.log(`  Evidence: "${c.evidence.replace(/\n/g, " ")}"`);
  }

  const importAll = await promptYesNo("\nAdd these patterns to your permanent safety blocklist? [Y/n]: ");
  if (importAll) {
    let count = 0;
    for (const c of candidates) {
      const entry: TraumaEntry = {
        id: `trauma-${crypto.randomBytes(4).toString("hex")}`,
        severity: "CRITICAL", // Default to CRITICAL
        pattern: c.matchedPattern,
        scope: "global",
        status: "active",
        trigger_event: {
          session_path: c.sessionPath,
          timestamp: now(),
          human_message: `Auto-detected from history: ${c.description}`
        },
        created_at: now()
      };
      await saveTrauma(entry);
      count++;
    }
    console.log(chalk.green(`${icon("success")} Imported ${count} trauma patterns. The guard is now active.`));
  }
}

export async function initCommand(options: InitOptions) {
  const startedAtMs = Date.now();
  const command = "init";
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
  
  const hasConfig = await fileExists(configPath);
  const hasPlaybook = await fileExists(playbookPath);
  const fullyInitialized = hasConfig && hasPlaybook;
  const hasAnyState = hasConfig || hasPlaybook;
  const backups: Array<{ file: string; backup: string }> = [];
  const overwritten: string[] = [];

  if (fullyInitialized && !options.force && !options.starter) {
    reportError("Already initialized. Use --force to reinitialize.", {
      code: ErrorCode.ALREADY_EXISTS,
      hint: "Use --force to reinitialize",
      json: options.json,
      command,
      startedAtMs,
    });
    return;
  }

  const needsForceConfirmation = hasAnyState && Boolean(options.force);
  if (needsForceConfirmation) {
    const canPrompt = Boolean(
      options.interactive !== false &&
      !options.json &&
      process.stdin.isTTY &&
      process.stdout.isTTY
    );

    if (canPrompt) {
      const ok = await promptYesNo(
        `This will back up and overwrite ~/.cass-memory/config.json and playbook.yaml. Continue? [y/N]: `
      );
      if (!ok) {
        console.log(chalk.yellow("Cancelled."));
        return;
      }
	    } else if (!options.yes) {
	      reportError("Refusing to overwrite existing files without --yes", {
	        code: ErrorCode.MISSING_REQUIRED,
	        hint: "Use --yes to confirm",
	        details: { missing: "confirmation" },
	        json: options.json,
          command,
          startedAtMs,
	      });
	      return;
	    }

    const ts = Date.now();
    const toBackup = [configPath, playbookPath];
    for (const file of toBackup) {
      if (await fileExists(file)) {
        const backupPath = `${file}.backup.${ts}`;
        await fs.copyFile(file, backupPath);
        backups.push({ file, backup: backupPath });
      }
    }
  }

  // Privacy-first: cross-agent enrichment requires explicit consent.
  // Only prompt in interactive CLI usage (tests/programmatic calls do not pass `interactive`).
  if (!hasConfig && options.interactive && !options.json && process.stdin.isTTY && process.stdout.isTTY) {
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
        agents: ["claude", "cursor", "codex", "aider", "pi_agent"],
      };
      console.log(chalk.green(`\n${icon("success")} Cross-agent enrichment enabled.\n`));
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

  const defaultConfigStr = JSON.stringify(config, null, 2);
  const defaultPlaybookStr = yaml.stringify(playbook);

  // Create structure
  const result = await ensureGlobalStructure(defaultConfigStr, defaultPlaybookStr);

  if (needsForceConfirmation) {
    await atomicWrite(configPath, defaultConfigStr);
    overwritten.push("config.json");
    await atomicWrite(playbookPath, defaultPlaybookStr);
    overwritten.push("playbook.yaml");
  }

  let starterOutcome: { added: number; skipped: number; name: string } | null = null;
	  if (options.starter) {
	    try {
	      starterOutcome = await seedStarter(playbookPath, options.starter);
	    } catch (err: any) {
	      reportError(err instanceof Error ? err : (err?.message || "Failed to apply starter"), {
	        code: ErrorCode.VALIDATION_FAILED,
	        details: { starter: options.starter },
	        json: options.json,
          command,
          startedAtMs,
	      });
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
    printJsonResult(command, {
      configPath,
      created: result.created,
      existed: result.existed,
      overwritten,
      backups,
      cassAvailable: cassOk,
      starter: starterOutcome
    }, { startedAtMs });
  } else {
    if (result.created.length > 0) {
      for (const file of result.created) {
        console.log(chalk.green(`${icon("success")} Created ~/.cass-memory/${file}`));
      }
    }
    if (result.existed.length > 0) {
      for (const file of result.existed) {
        console.log(chalk.blue(`• ~/.cass-memory/${file} already exists`));
      }
    }

    if (backups.length > 0) {
      console.log(chalk.yellow("\nBackups created:"));
      for (const b of backups) {
        console.log(chalk.yellow(`  • ${b.backup}`));
      }
    }

    if (overwritten.length > 0) {
      console.log(chalk.yellow(`\nOverwritten: ${overwritten.join(", ")}`));
    }
    
    const cassStatus = cassOk
      ? "available"
      : "not found (history disabled until installed/indexed)";

    if (starterOutcome) {
      console.log(
        chalk.green(
          `${icon("success")} Applied starter "${starterOutcome.name}" (${starterOutcome.added} added, ${starterOutcome.skipped} skipped)`
        )
      );
    }

    if (await fileExists(".claude")) {
      try {
        await installGuard(false, true);
        console.log(chalk.green(`${icon("success")} Auto-installed Project Hot Stove safety guard`));
      } catch (e) {
        // Ignore failures
      }
    }

    // Run Trauma Scan if interactive and cass is available
    if (options.interactive !== false && !options.json && process.stdin.isTTY && cassOk) {
      await runTraumaScan(config);
    }

    console.log("");
    console.log(chalk.bold(`${cli} initialized successfully.`));
    console.log("");

    console.log(chalk.bold("Created/verified:"));
    console.log(
      formatKv(
        [
          { key: "Config", value: "~/.cass-memory/config.json" },
          { key: "Playbook", value: "~/.cass-memory/playbook.yaml" },
          { key: "Diary", value: "~/.cass-memory/diary/" },
          { key: "cass", value: cassStatus },
        ],
        { indent: "  " }
      )
    );

    console.log("");
    console.log(chalk.bold("Next steps (copy/paste):"));
    console.log(chalk.cyan(`  ${cli} context "your task" --json`));
    console.log(chalk.cyan(`  ${cli} doctor --json`));
    console.log(chalk.cyan(`  ${cli} privacy status`));

    console.log(chalk.gray(`\nAutomation (operator): schedule ${cli} reflect --days 7 --json`));
    console.log(chalk.gray(`Project rules (repo): ${cli} init --repo`));
    console.log(chalk.gray("Semantic search: enabling it may download an embedding model on first use."));
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
  const startedAtMs = Date.now();
  const command = "init:repo";
  const cassDir = await resolveRepoDir();
  const backups: Array<{ file: string; backup: string }> = [];
  const overwritten: string[] = [];

	  if (!cassDir) {
	    reportError("Not in a git repository. Run from within a git repo.", {
	      code: ErrorCode.CONFIG_INVALID,
	      hint: "cd into a git repository first",
	      json: options.json,
        command,
        startedAtMs,
	    });
	    return;
	  }

  // Check if already initialized
  const playbookPath = `${cassDir}/playbook.yaml`;
  const blockedPath = `${cassDir}/blocked.log`;
  const hasPlaybook = await fileExists(playbookPath);
  const hasBlocked = await fileExists(blockedPath);
  const fullyInitialized = hasPlaybook && hasBlocked;
  const hasAnyState = hasPlaybook || hasBlocked;

  if (fullyInitialized && !options.force && !options.starter) {
    reportError("Repo already has .cass/ directory. Use --force to reinitialize.", {
      code: ErrorCode.ALREADY_EXISTS,
      hint: "Use --force to reinitialize",
      details: { cassDir },
      json: options.json,
      command,
      startedAtMs,
    });
    return;
  }

  const needsForceConfirmation = hasAnyState && Boolean(options.force);
  if (needsForceConfirmation) {
    const canPrompt = Boolean(
      options.interactive !== false &&
      !options.json &&
      process.stdin.isTTY &&
      process.stdout.isTTY
    );

    if (canPrompt) {
      const ok = await promptYesNo(
        `This will back up and overwrite ${cassDir}/playbook.yaml and blocked.log. Continue? [y/N]: `
      );
      if (!ok) {
        console.log(chalk.yellow("Cancelled."));
        return;
      }
	    } else if (!options.yes) {
	      reportError("Refusing to overwrite existing files without --yes", {
	        code: ErrorCode.MISSING_REQUIRED,
	        hint: "Use --yes to confirm",
	        details: { missing: "confirmation" },
	        json: options.json,
          command,
          startedAtMs,
	      });
	      return;
	    }

    const ts = Date.now();
    const toBackup = [playbookPath, blockedPath];
    for (const file of toBackup) {
      if (await fileExists(file)) {
        const backupPath = `${file}.backup.${ts}`;
        await fs.copyFile(file, backupPath);
        backups.push({ file, backup: backupPath });
      }
    }
  }

  // Create the structure
  const result = await ensureRepoStructure(cassDir);

  if (needsForceConfirmation) {
    const repoPlaybook = createEmptyPlaybook("repo-playbook");
    repoPlaybook.description = "Project-specific rules for this repository";
    await atomicWrite(playbookPath, yaml.stringify(repoPlaybook));
    overwritten.push("playbook.yaml");
    await atomicWrite(blockedPath, "");
    overwritten.push("blocked.log");
  }

  let starterOutcome: { added: number; skipped: number; name: string } | null = null;
	  if (options.starter) {
	    try {
	      starterOutcome = await seedStarter(playbookPath, options.starter);
	    } catch (err: any) {
	      reportError(err instanceof Error ? err : (err?.message || "Failed to apply starter"), {
	        code: ErrorCode.VALIDATION_FAILED,
	        details: { starter: options.starter, cassDir },
	        json: options.json,
          command,
          startedAtMs,
	      });
	      return;
	    }
	  }

  if (options.json) {
    printJsonResult(command, {
      cassDir,
      created: result.created,
      existed: result.existed,
      overwritten,
      backups,
      starter: starterOutcome
    }, { startedAtMs });
  } else {
    console.log(chalk.bold(`\n${iconPrefix("construction")}Initializing repo-level .cass/ structure\n`));

    if (result.created.length > 0) {
      for (const file of result.created) {
        console.log(chalk.green(`${icon("success")} Created .cass/${file}`));
      }
    }

    if (result.existed.length > 0) {
      for (const file of result.existed) {
        console.log(chalk.blue(`• .cass/${file} already exists`));
      }
    }

    if (backups.length > 0) {
      console.log(chalk.yellow("\nBackups created:"));
      for (const b of backups) {
        console.log(chalk.yellow(`  • ${b.backup}`));
      }
    }

    if (overwritten.length > 0) {
      console.log(chalk.yellow(`\nOverwritten: ${overwritten.join(", ")}`));
    }

    if (starterOutcome) {
      console.log(chalk.green(`${icon("success")} Applied starter "${starterOutcome.name}" (${starterOutcome.added} added, ${starterOutcome.skipped} skipped)`));
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
