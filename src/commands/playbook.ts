import { loadConfig } from "../config.js";
import { loadMergedPlaybook, addBullet, deprecateBullet, savePlaybook, findBullet, getActiveBullets } from "../playbook.js";
import { error as logError } from "../utils.js";
import { withLock } from "../lock.js";
import chalk from "chalk";

export async function playbookCommand(
  action: "list" | "add" | "remove",
  args: string[],
  flags: { category?: string; json?: boolean; hard?: boolean; reason?: string }
) {
  const config = await loadConfig();
  
  if (action === "list") {
    const playbook = await loadMergedPlaybook(config);
    let bullets = getActiveBullets(playbook);
    
    if (flags.category) {
      bullets = bullets.filter((b: any) => b.category === flags.category);
    }

    if (flags.json) {
      console.log(JSON.stringify(bullets, null, 2));
    } else {
      console.log(chalk.bold(`PLAYBOOK RULES (${bullets.length}):`));
      bullets.forEach((b: any) => {
        console.log(`[${b.id}] ${chalk.cyan(b.category)}: ${b.content}`);
      });
    }
    return;
  }

  if (action === "add") {
    const content = args[0];
    if (!content) {
      logError("Content required for add");
      process.exit(1);
    }
    
    // Lock global playbook for writing
    await withLock(config.playbookPath, async () => {
        const { loadPlaybook } = await import("../playbook.js");
        const playbook = await loadPlaybook(config.playbookPath);
        
      const bullet = addBullet(
        playbook,
        {
          content,
          category: flags.category || "general",
          scope: "global",
          kind: "workflow_rule",
        },
        "manual-cli",
        config.scoring.decayHalfLifeDays
      );

        await savePlaybook(playbook, config.playbookPath);

        if (flags.json) {
          console.log(JSON.stringify({ success: true, bullet }, null, 2));
        } else {
          console.log(chalk.green(`✓ Added bullet ${bullet.id}`));
        }
    });
    return;
  }

  if (action === "remove") {
    const id = args[0];
    if (!id) {
      logError("ID required for remove");
      process.exit(1);
    }

    // Determine target first (read-only check)
    const { loadPlaybook } = await import("../playbook.js");
    let savePath = config.playbookPath;
    let checkPlaybook = await loadPlaybook(config.playbookPath);
    
    if (!findBullet(checkPlaybook, id)) {
        const repoPath = ".cass/playbook.yaml";
        const repoPlaybook = await loadPlaybook(repoPath);
        if (findBullet(repoPlaybook, id)) {
            savePath = repoPath;
        } else {
            logError(`Bullet ${id} not found`);
            process.exit(1);
        }
    }

    // Acquire lock on the target file
    await withLock(savePath, async () => {
        // Reload inside lock
        const playbook = await loadPlaybook(savePath);
        const bullet = findBullet(playbook, id);

        if (!bullet) {
             logError(`Bullet ${id} disappeared during lock acquisition`);
             process.exit(1);
        }

        if (flags.hard) {
          playbook.bullets = playbook.bullets.filter(b => b.id !== id);
        } else {
          deprecateBullet(playbook, id, flags.reason || "Removed via CLI");
        }

        await savePlaybook(playbook, savePath);

        if (flags.json) {
          console.log(JSON.stringify({ success: true, id, action: flags.hard ? "deleted" : "deprecated" }, null, 2));
        } else {
          console.log(chalk.green(`✓ ${flags.hard ? "Deleted" : "Deprecated"} bullet ${id}`));
        }
    });
  }
}
