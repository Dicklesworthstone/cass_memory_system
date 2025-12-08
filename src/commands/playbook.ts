import { loadConfig } from "../config.js";
import { loadMergedPlaybook, addBullet, deprecateBullet, savePlaybook, findBullet, getActiveBullets } from "../playbook.js";
import { expandPath, error as logError } from "../utils.js";
import chalk from "chalk";

export async function playbookCommand(
  action: "list" | "add" | "remove",
  args: string[],
  flags: { category?: string; json?: boolean; hard?: boolean; reason?: string }
) {
  const config = await loadConfig();
  
  // For add/remove, we need to target specific file.
  // Default to global for add.
  // For remove, find where it lives.

  if (action === "list") {
    const playbook = await loadMergedPlaybook(config);
    let bullets = getActiveBullets(playbook);
    
    if (flags.category) {
      bullets = bullets.filter(b => b.category === flags.category);
    }

    if (flags.json) {
      console.log(JSON.stringify(bullets, null, 2));
    } else {
      console.log(chalk.bold(`PLAYBOOK RULES (${bullets.length}):`));
      bullets.forEach(b => {
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
    
    // Load global playbook for writing
    const { loadPlaybook } = await import("../playbook.js");
    const playbook = await loadPlaybook(config);
    
    const bullet = addBullet(playbook, {
      content,
      category: flags.category || "general"
    }, "manual-cli");

    await savePlaybook(playbook, config.playbookPath);

    if (flags.json) {
      console.log(JSON.stringify({ success: true, bullet }, null, 2));
    } else {
      console.log(chalk.green(`✓ Added bullet ${bullet.id}`));
    }
    return;
  }

  if (action === "remove") {
    const id = args[0];
    if (!id) {
      logError("ID required for remove");
      process.exit(1);
    }

    // Find where it lives
    const { loadPlaybook } = await import("../playbook.js");
    let playbook = await loadPlaybook(config);
    let savePath = config.playbookPath;
    let bullet = findBullet(playbook, id);

    if (!bullet) {
      const repoPath = ".cass/playbook.yaml";
      playbook = await loadPlaybook({ ...config, playbookPath: repoPath });
      bullet = findBullet(playbook, id);
      savePath = repoPath;
    }

    if (!bullet) {
      logError(`Bullet ${id} not found`);
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
  }
}
