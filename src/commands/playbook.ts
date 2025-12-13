import { loadConfig } from "../config.js";
import { loadMergedPlaybook, addBullet, deprecateBullet, savePlaybook, findBullet, getActiveBullets, loadPlaybook } from "../playbook.js";
import { error as logError, fileExists, now, resolveRepoDir, truncate, confirmDangerousAction, getCliName } from "../utils.js";
import { withLock } from "../lock.js";
import { getEffectiveScore, getDecayedCounts } from "../scoring.js";
import { PlaybookBullet, Playbook, PlaybookSchema, PlaybookBulletSchema } from "../types.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import chalk from "chalk";
import yaml from "yaml";
import { z } from "zod";

// Helper function to format a bullet for detailed display
function formatBulletDetails(bullet: PlaybookBullet, effectiveScore: number, decayedCounts: { decayedHelpful: number; decayedHarmful: number }): string {
  const lines: string[] = [];

  lines.push(chalk.bold(`BULLET: ${bullet.id}`));
  lines.push("");
  lines.push(`Content: ${bullet.content}`);
  lines.push(`Category: ${chalk.cyan(bullet.category)}`);
  lines.push(`Kind: ${bullet.kind}`);
  lines.push(`Maturity: ${chalk.yellow(bullet.maturity)}`);
  lines.push(`Scope: ${bullet.scope}`);

  lines.push("");
  lines.push(chalk.bold("Scores:"));

  const rawScore = bullet.helpfulCount - bullet.harmfulCount * 4;
  lines.push(`  Raw score: ${rawScore}`);
  lines.push(`  Effective score: ${effectiveScore.toFixed(2)} (with decay)`);
  lines.push(`  Decayed helpful: ${decayedCounts.decayedHelpful.toFixed(2)}`);
  lines.push(`  Decayed harmful: ${decayedCounts.decayedHarmful.toFixed(2)}`);
  lines.push(`  Positive feedback: ${bullet.helpfulCount}`);
  lines.push(`  Negative feedback: ${bullet.harmfulCount}`);

  lines.push("");
  lines.push(chalk.bold("History:"));
  lines.push(`  Created: ${bullet.createdAt}`);
  lines.push(`  Last updated: ${bullet.updatedAt}`);

  const ageMs = Date.now() - new Date(bullet.createdAt).getTime();
  const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));
  lines.push(`  Age: ${ageDays} days`);

  if (bullet.sourceSessions && bullet.sourceSessions.length > 0) {
    lines.push("");
    lines.push(chalk.bold("Source sessions:"));
    for (const session of bullet.sourceSessions.slice(0, 5)) {
      lines.push(`  - ${session}`);
    }
    if (bullet.sourceSessions.length > 5) {
      lines.push(`  ... and ${bullet.sourceSessions.length - 5} more`);
    }
  }

  if (bullet.sourceAgents && bullet.sourceAgents.length > 0) {
    lines.push("");
    lines.push(chalk.bold("Source agents:"));
    lines.push(`  ${bullet.sourceAgents.join(", ")}`);
  }

  if (bullet.tags && bullet.tags.length > 0) {
    lines.push("");
    lines.push(`Tags: [${bullet.tags.join(", ")}]`);
  }

  if (bullet.deprecated) {
    lines.push("");
    lines.push(chalk.red.bold("Status: DEPRECATED"));
    if (bullet.deprecationReason) {
      lines.push(`Reason: ${bullet.deprecationReason}`);
    }
    if (bullet.deprecatedAt) {
      lines.push(`Deprecated at: ${bullet.deprecatedAt}`);
    }
  }

  if (bullet.pinned) {
    lines.push("");
    lines.push(chalk.blue.bold("📌 PINNED"));
  }

  return lines.join("\n");
}

// Find similar bullet IDs for suggestions
function findSimilarIds(bullets: PlaybookBullet[], targetId: string, maxSuggestions = 3): string[] {
  const similar: Array<{ id: string; score: number }> = [];
  const targetLower = targetId.toLowerCase();

  for (const bullet of bullets) {
    const idLower = bullet.id.toLowerCase();
    // Simple substring match
    if (idLower.includes(targetLower) || targetLower.includes(idLower)) {
      similar.push({ id: bullet.id, score: 2 });
    } else if (idLower.startsWith(targetLower.slice(0, 3))) {
      // Prefix match
      similar.push({ id: bullet.id, score: 1 });
    }
  }

  return similar
    .sort((a, b) => b.score - a.score)
    .slice(0, maxSuggestions)
    .map(s => s.id);
}

// Strip non-portable fields from bullet for export
function prepareBulletForExport(bullet: PlaybookBullet): Partial<PlaybookBullet> {
  // Create a copy without source session paths (not portable)
  const exported: Partial<PlaybookBullet> = { ...bullet };
  delete exported.sourceSessions; // Not portable between systems
  return exported;
}

// Detect file format from content or extension
function detectFormat(content: string, filePath?: string): "yaml" | "json" {
  if (filePath?.endsWith(".json")) return "json";
  if (filePath?.endsWith(".yaml") || filePath?.endsWith(".yml")) return "yaml";

  // Try to detect from content
  const trimmed = content.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return "json";
  return "yaml";
}

export async function playbookCommand(
  action: "list" | "add" | "remove" | "get" | "export" | "import",
  args: string[],
  flags: { category?: string; json?: boolean; hard?: boolean; yes?: boolean; reason?: string; all?: boolean; replace?: boolean; yaml?: boolean }
) {
  const config = await loadConfig();

  if (action === "export") {
    const playbook = await loadMergedPlaybook(config);

    // Filter bullets based on --all flag
    let bulletsToExport = flags.all
      ? playbook.bullets
      : playbook.bullets.filter(b => !b.deprecated);

    // Prepare bullets for export (strip non-portable fields)
    const exportedBullets = bulletsToExport.map(prepareBulletForExport);

    // Create export structure
    const exportData = {
      schema_version: playbook.schema_version,
      name: playbook.name || "exported-playbook",
      description: playbook.description || "Exported from cass-memory",
      metadata: {
        ...playbook.metadata,
        exportedAt: now(),
        exportedBulletCount: exportedBullets.length,
      },
      deprecatedPatterns: playbook.deprecatedPatterns || [],
      bullets: exportedBullets,
    };

    // Output in requested format
    if (flags.json || (!flags.yaml && flags.json !== false)) {
      // Default to JSON if --json specified or neither specified
      if (flags.json) {
        console.log(JSON.stringify(exportData, null, 2));
      } else {
        // Default: YAML (more human-readable)
        console.log(yaml.stringify(exportData));
      }
    } else {
      // --yaml explicitly specified
      console.log(yaml.stringify(exportData));
    }
    return;
  }

  if (action === "import") {
    const filePath = args[0];
    if (!filePath) {
      logError("File path required for import");
      process.exit(1);
    }

    // Check file exists
    if (!(await fileExists(filePath))) {
      if (flags.json) {
        console.log(JSON.stringify({ success: false, error: `File not found: ${filePath}` }, null, 2));
      } else {
        logError(`File not found: ${filePath}`);
      }
      process.exit(1);
    }

    // Read and parse file
    const content = await readFile(filePath, "utf-8");
    const format = detectFormat(content, filePath);

    let importedData: any;
    try {
      if (format === "json") {
        importedData = JSON.parse(content);
      } else {
        importedData = yaml.parse(content);
      }
    } catch (err: any) {
      if (flags.json) {
        console.log(JSON.stringify({ success: false, error: `Parse error: ${err.message}` }, null, 2));
      } else {
        logError(`Failed to parse ${format.toUpperCase()}: ${err.message}`);
      }
      process.exit(1);
    }

    // Validate imported bullets
    const importedBullets: PlaybookBullet[] = [];
    const validationErrors: string[] = [];

    const bulletsArray = importedData.bullets || importedData;
    if (!Array.isArray(bulletsArray)) {
      if (flags.json) {
        console.log(JSON.stringify({ success: false, error: "Invalid format: expected bullets array" }, null, 2));
      } else {
        logError("Invalid format: expected bullets array or playbook with bullets field");
      }
      process.exit(1);
    }

    for (let i = 0; i < bulletsArray.length; i++) {
      try {
        // Add required fields if missing
        const bullet = {
          ...bulletsArray[i],
          createdAt: bulletsArray[i].createdAt || now(),
          updatedAt: bulletsArray[i].updatedAt || now(),
          helpfulCount: bulletsArray[i].helpfulCount ?? 0,
          harmfulCount: bulletsArray[i].harmfulCount ?? 0,
          feedbackEvents: bulletsArray[i].feedbackEvents || [],
          tags: bulletsArray[i].tags || [],
          sourceSessions: bulletsArray[i].sourceSessions || [],
          sourceAgents: bulletsArray[i].sourceAgents || [],
          deprecated: bulletsArray[i].deprecated ?? false,
          pinned: bulletsArray[i].pinned ?? false,
        };
        const validated = PlaybookBulletSchema.parse(bullet);
        importedBullets.push(validated);
      } catch (err: any) {
        validationErrors.push(`Bullet ${i}: ${err.message}`);
      }
    }

    if (validationErrors.length > 0 && importedBullets.length === 0) {
      if (flags.json) {
        console.log(JSON.stringify({ success: false, errors: validationErrors }, null, 2));
      } else {
        logError("All bullets failed validation:");
        validationErrors.forEach(e => console.error(`  - ${e}`));
      }
      process.exit(1);
    }

    // Merge with existing playbook
    await withLock(config.playbookPath, async () => {
      const existingPlaybook = await loadPlaybook(config.playbookPath);
      const existingIds = new Set(existingPlaybook.bullets.map(b => b.id));

      let added = 0;
      let skipped = 0;
      let updated = 0;

      for (const bullet of importedBullets) {
        if (existingIds.has(bullet.id)) {
          if (flags.replace) {
            // Replace existing bullet
            const idx = existingPlaybook.bullets.findIndex(b => b.id === bullet.id);
            if (idx >= 0) {
              existingPlaybook.bullets[idx] = bullet;
              updated++;
            }
          } else {
            skipped++;
          }
        } else {
          existingPlaybook.bullets.push(bullet);
          added++;
        }
      }

      await savePlaybook(existingPlaybook, config.playbookPath);

      if (flags.json) {
        console.log(JSON.stringify({
          success: true,
          file: filePath,
          added,
          skipped,
          updated,
          validationWarnings: validationErrors.length > 0 ? validationErrors : undefined,
        }, null, 2));
      } else {
        console.log(chalk.green(`✓ Imported playbook from ${filePath}`));
        console.log(`  - ${chalk.green(added)} bullets added`);
        console.log(`  - ${chalk.yellow(skipped)} bullets skipped (already exist)`);
        if (updated > 0) {
          console.log(`  - ${chalk.blue(updated)} bullets updated`);
        }
        if (validationErrors.length > 0) {
          console.log(chalk.yellow(`  - ${validationErrors.length} bullets failed validation`));
        }
      }
    });
    return;
  }

  if (action === "get") {
    const id = args[0];
    if (!id) {
      logError("Bullet ID required for get");
      process.exit(1);
    }

    const playbook = await loadMergedPlaybook(config);
    const bullet = findBullet(playbook, id);

    if (!bullet) {
      const allBullets = playbook.bullets || [];
      const similar = findSimilarIds(allBullets, id);

      if (flags.json) {
        console.log(JSON.stringify({
          success: false,
          error: `Bullet '${id}' not found`,
          suggestions: similar.length > 0 ? similar : undefined
        }, null, 2));
      } else {
        logError(`Bullet '${id}' not found`);
        if (similar.length > 0) {
          console.log(chalk.yellow(`Did you mean: ${similar.join(", ")}?`));
        }
      }
      process.exit(1);
    }

    const effectiveScore = getEffectiveScore(bullet, config);
    const decayedCounts = getDecayedCounts(bullet, config);

    if (flags.json) {
      const ageMs = Date.now() - new Date(bullet.createdAt).getTime();
      const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));

      console.log(JSON.stringify({
        success: true,
        bullet: {
          ...bullet,
          effectiveScore,
          decayedHelpful: decayedCounts.decayedHelpful,
          decayedHarmful: decayedCounts.decayedHarmful,
          ageDays
        }
      }, null, 2));
    } else {
      console.log(formatBulletDetails(bullet, effectiveScore, decayedCounts));
    }
    return;
  }

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
      const repoDir = await resolveRepoDir();
      const repoPath = repoDir ? path.join(repoDir, "playbook.yaml") : null;

      if (repoPath && (await fileExists(repoPath))) {
        try {
          const repoPlaybook = await loadPlaybook(repoPath);
          if (findBullet(repoPlaybook, id)) {
            savePath = repoPath;
            checkPlaybook = repoPlaybook;
          }
        } catch {
          // Ignore repo playbook load errors and report not found below.
        }
      }

      if (!findBullet(checkPlaybook, id)) {
        logError(`Bullet ${id} not found`);
        process.exit(1);
      }
    }

    if (flags.hard) {
      const candidate = findBullet(checkPlaybook, id);
      const preview = candidate
        ? truncate(candidate.content.trim().replace(/\s+/g, " "), 100)
        : "";

      const confirmed = await confirmDangerousAction({
        action: `Permanently delete bullet ${id}`,
        details: [
          `File: ${savePath}`,
          preview ? `Preview: "${preview}"` : undefined,
          `Tip: Use --yes to confirm in non-interactive mode`,
        ].filter(Boolean) as string[],
        confirmPhrase: "DELETE",
        yes: flags.yes,
        json: flags.json,
      });

      if (!confirmed) {
        const cli = getCliName();
        if (flags.json) {
          console.log(
            JSON.stringify(
              {
                success: false,
                error: "Confirmation required for --hard deletion",
                hint: `${cli} playbook remove ${id} --hard --yes`,
              },
              null,
              2
            )
          );
        } else {
          logError("Refusing to permanently delete without confirmation.");
          console.log(chalk.gray(`Re-run with: ${cli} playbook remove ${id} --hard --yes`));
          console.log(chalk.gray(`Or omit --hard to deprecate instead.`));
        }
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
          const preview = truncate(bullet.content.trim().replace(/\s+/g, " "), 100);
          playbook.bullets = playbook.bullets.filter(b => b.id !== id);
          await savePlaybook(playbook, savePath);

          if (flags.json) {
            console.log(JSON.stringify({ success: true, id, action: "deleted", path: savePath, preview }, null, 2));
          } else {
            console.log(chalk.green(`✓ Deleted bullet ${id}`));
            console.log(chalk.gray(`  File: ${savePath}`));
            console.log(chalk.gray(`  Preview: "${preview}"`));
          }
          return;
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
