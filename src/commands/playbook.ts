import { loadConfig } from "../config.js";
import { loadMergedPlaybook, addBullet, deprecateBullet, savePlaybook, findBullet, getActiveBullets, loadPlaybook } from "../playbook.js";
import { error as logError, fileExists, now, resolveRepoDir, truncate, confirmDangerousAction, getCliName, printJson, printJsonResult, printJsonError } from "../utils.js";
import { withLock } from "../lock.js";
import { getEffectiveScore, getDecayedCounts } from "../scoring.js";
import { PlaybookBullet, Playbook, PlaybookSchema, PlaybookBulletSchema, ErrorCode } from "../types.js";
import { validateRule, formatValidationResult, hasIssues, type ValidationResult } from "../rule-validation.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import chalk from "chalk";
import yaml from "yaml";
import { z } from "zod";
import { iconPrefix, icon } from "../output.js";

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
    lines.push(chalk.blue.bold(`${iconPrefix("pin")}PINNED`));
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

/**
 * Schema for batch add input
 */
const BatchRuleSchema = z.object({
  content: z.string().min(1),
  category: z.string().optional(),
});

type BatchRule = z.infer<typeof BatchRuleSchema>;

interface BatchAddResult {
  success: boolean;
  added: Array<{ id: string; content: string; category: string; validation?: ValidationResult }>;
  skipped: Array<{ content: string; reason: string; validation?: ValidationResult }>;
  failed: Array<{ content: string; error: string }>;
  summary: { total: number; succeeded: number; skipped: number; failed: number };
}

/**
 * Handle batch add from file or stdin
 */
async function handleBatchAdd(
  config: Awaited<ReturnType<typeof loadConfig>>,
  flags: { file?: string; category?: string; check?: boolean; strict?: boolean }
): Promise<BatchAddResult> {
  const result: BatchAddResult = {
    success: false,
    added: [],
    skipped: [],
    failed: [],
    summary: { total: 0, succeeded: 0, skipped: 0, failed: 0 },
  };

  // Read input
  let rawInput: string;
  try {
    if (flags.file === "-") {
      // Read from stdin
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(chunk);
      }
      rawInput = Buffer.concat(chunks).toString("utf-8");
    } else {
      // Read from file
      rawInput = await readFile(flags.file!, "utf-8");
    }
  } catch (err: any) {
    result.failed.push({
      content: `[file: ${flags.file}]`,
      error: `Failed to read input: ${err.message}`,
    });
    result.summary.total = 1;
    result.summary.failed = 1;
    return result;
  }

  // Parse JSON
  let rules: unknown[];
  try {
    const parsed = JSON.parse(rawInput);
    if (!Array.isArray(parsed)) {
      throw new Error("Input must be a JSON array");
    }
    rules = parsed;
  } catch (err: any) {
    result.failed.push({
      content: "[input]",
      error: `Invalid JSON: ${err.message}`,
    });
    result.summary.total = 1;
    result.summary.failed = 1;
    return result;
  }

  if (rules.length === 0) {
    result.success = true;
    return result;
  }

  result.summary.total = rules.length;

  // Process rules within a single lock
  await withLock(config.playbookPath, async () => {
    const { loadPlaybook } = await import("../playbook.js");
    const playbook = await loadPlaybook(config.playbookPath);

    for (let i = 0; i < rules.length; i++) {
      const raw = rules[i];

      // Validate schema
      const validated = BatchRuleSchema.safeParse(raw);
      if (!validated.success) {
        const content = typeof raw === "object" && raw !== null && "content" in raw
          ? String((raw as any).content).slice(0, 50)
          : `[item ${i}]`;
        result.failed.push({
          content,
          error: validated.error.errors.map(e => e.message).join(", "),
        });
        continue;
      }

      const rule = validated.data;

      // Use per-rule category or fall back to flag category or "general"
      const category = rule.category || flags.category || "general";

      // Validate if --check flag is set
      let validation: ValidationResult | undefined;
      if (flags.check) {
        validation = await validateRule(rule.content, category, playbook);

        // In strict mode, skip rules with issues
        if (flags.strict && hasIssues(validation)) {
          result.skipped.push({
            content: rule.content.slice(0, 50),
            reason: "Validation failed in strict mode",
            validation,
          });
          result.summary.skipped++;
          continue;
        }
      }

      try {
        const bullet = addBullet(
          playbook,
          {
            content: rule.content,
            category,
            scope: "global",
            kind: "workflow_rule",
          },
          "manual-cli",
          config.scoring.decayHalfLifeDays
        );

        result.added.push({
          id: bullet.id,
          content: rule.content,
          category,
          validation,
        });
        result.summary.succeeded++;
      } catch (err: any) {
        result.failed.push({
          content: rule.content.slice(0, 50),
          error: err.message || "Unknown error",
        });
      }
    }

    // Save if any were added
    if (result.added.length > 0) {
      await savePlaybook(playbook, config.playbookPath);
    }
  });

  result.summary.failed = result.summary.total - result.summary.succeeded - result.summary.skipped;
  result.success = result.summary.failed === 0;

  return result;
}

export async function playbookCommand(
  action: "list" | "add" | "remove" | "get" | "export" | "import",
  args: string[],
  flags: {
    category?: string;
    json?: boolean;
    hard?: boolean;
    yes?: boolean;
    dryRun?: boolean;
    reason?: string;
    all?: boolean;
    replace?: boolean;
    yaml?: boolean;
    file?: string;
    session?: string;
    check?: boolean;
    strict?: boolean;
  }
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
        printJson(exportData);
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
      if (flags.json) {
        printJsonError("File path required for import", {
          code: ErrorCode.MISSING_REQUIRED,
          details: { missing: "filePath", usage: "cm playbook import <file>" }
        });
      } else {
        logError("File path required for import");
      }
      process.exitCode = 1;
      return;
    }

    // Check file exists
    if (!(await fileExists(filePath))) {
      if (flags.json) {
        printJsonError(`File not found: ${filePath}`, {
          code: ErrorCode.FILE_NOT_FOUND,
          details: { path: filePath }
        });
      } else {
        logError(`File not found: ${filePath}`);
      }
      process.exitCode = 1;
      return;
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
        printJsonError(`Parse error: ${err.message}`, {
          code: ErrorCode.INVALID_INPUT,
          details: { format, path: filePath }
        });
      } else {
        logError(`Failed to parse ${format.toUpperCase()}: ${err.message}`);
      }
      process.exitCode = 1;
      return;
    }

    // Validate imported bullets
    const importedBullets: PlaybookBullet[] = [];
    const validationErrors: string[] = [];

    const bulletsArray = importedData.bullets || importedData;
    if (!Array.isArray(bulletsArray)) {
      if (flags.json) {
        printJsonError("Invalid format: expected bullets array", {
          code: ErrorCode.INVALID_INPUT,
          details: { expected: "array", path: filePath }
        });
      } else {
        logError("Invalid format: expected bullets array or playbook with bullets field");
      }
      process.exitCode = 1;
      return;
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
        printJsonError("All bullets failed validation", {
          code: ErrorCode.VALIDATION_FAILED,
          details: { errors: validationErrors, path: filePath }
        });
      } else {
        logError("All bullets failed validation:");
        validationErrors.forEach(e => console.error(`  - ${e}`));
      }
      process.exitCode = 1;
      return;
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
        printJsonResult({
          file: filePath,
          added,
          skipped,
          updated,
          validationWarnings: validationErrors.length > 0 ? validationErrors : undefined,
        });
      } else {
        console.log(chalk.green(`${icon("success")} Imported playbook from ${filePath}`));
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
      if (flags.json) {
        printJsonError("Bullet ID required for get", {
          code: ErrorCode.MISSING_REQUIRED,
          details: { missing: "bulletId", usage: "cm playbook get <bulletId>" }
        });
      } else {
        logError("Bullet ID required for get");
      }
      process.exitCode = 1;
      return;
    }

    const playbook = await loadMergedPlaybook(config);
    const bullet = findBullet(playbook, id);

    if (!bullet) {
      const allBullets = playbook.bullets || [];
      const similar = findSimilarIds(allBullets, id);

      if (flags.json) {
        printJsonError(`Bullet '${id}' not found`, {
          code: ErrorCode.BULLET_NOT_FOUND,
          details: { bulletId: id, suggestions: similar.length > 0 ? similar : undefined }
        });
      } else {
        logError(`Bullet '${id}' not found`);
        if (similar.length > 0) {
          console.log(chalk.yellow(`Did you mean: ${similar.join(", ")}?`));
        }
      }
      process.exitCode = 1;
      return;
    }

    const effectiveScore = getEffectiveScore(bullet, config);
    const decayedCounts = getDecayedCounts(bullet, config);

    if (flags.json) {
      const ageMs = Date.now() - new Date(bullet.createdAt).getTime();
      const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));

      printJsonResult({
        bullet: {
          ...bullet,
          effectiveScore,
          decayedHelpful: decayedCounts.decayedHelpful,
          decayedHarmful: decayedCounts.decayedHarmful,
          ageDays
        }
      });
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
      printJsonResult({ bullets });
    } else {
      console.log(chalk.bold(`PLAYBOOK RULES (${bullets.length}):`));
      bullets.forEach((b: any) => {
        console.log(`[${b.id}] ${chalk.cyan(b.category)}: ${b.content}`);
      });
    }
    return;
  }

  if (action === "add") {
    // Handle batch add via --file
    if (flags.file) {
      const result = await handleBatchAdd(config, flags);

      // If --session was provided, update onboarding state
      if (flags.session && result.summary.succeeded > 0) {
        const { markSessionProcessed } = await import("../onboard-state.js");
        await markSessionProcessed(flags.session, result.summary.succeeded);
      }

      if (flags.json) {
        printJson(result);
      } else {
        console.log(chalk.bold("BATCH ADD RESULTS"));
        console.log("");
        if (result.added.length > 0) {
          console.log(chalk.green(`${icon("success")} Added ${result.added.length} rules:`));
          for (const r of result.added) {
            console.log(chalk.dim(`  ${r.id}: ${truncate(r.content, 60)}`));
          }
        }
        if (result.skipped.length > 0) {
          console.log("");
          console.log(chalk.yellow(`${icon("skipped")} Skipped ${result.skipped.length} rules (--strict):`));
          for (const r of result.skipped) {
            console.log(chalk.dim(`  "${truncate(r.content, 40)}": ${r.reason}`));
          }
        }
        if (result.failed.length > 0) {
          console.log("");
          console.log(chalk.red(`${icon("failure")} Failed ${result.failed.length} rules:`));
          for (const r of result.failed) {
            console.log(chalk.dim(`  "${truncate(r.content, 40)}": ${r.error}`));
          }
        }
        console.log("");
        const parts = [`${result.summary.succeeded} added`];
        if (result.summary.skipped > 0) parts.push(`${result.summary.skipped} skipped`);
        if (result.summary.failed > 0) parts.push(`${result.summary.failed} failed`);
        console.log(chalk.dim(`Summary: ${parts.join(", ")} (${result.summary.total} total)`));
      }
      return;
    }

    // Single rule add (existing behavior)
    const content = args[0];
    if (!content) {
      logError("Content required for add");
      throw new Error("Content required for add");
    }

    await withLock(config.playbookPath, async () => {
      const { loadPlaybook } = await import("../playbook.js");
      const playbook = await loadPlaybook(config.playbookPath);
      const category = flags.category || "general";

      // Validate if --check flag is set
      let validation: ValidationResult | undefined;
      if (flags.check) {
        validation = await validateRule(content, category, playbook);

        // In strict mode, fail on warnings
        if (flags.strict && hasIssues(validation)) {
          if (flags.json) {
            printJson({
              success: false,
              error: "Validation failed in strict mode",
              validation,
            });
          } else {
            console.log(chalk.red("Validation failed (--strict mode):"));
            console.log(formatValidationResult(validation));
          }
          throw new Error("Validation failed in strict mode");
        }
      }

      const bullet = addBullet(
        playbook,
        {
          content,
          category,
          scope: "global",
          kind: "workflow_rule",
        },
        "manual-cli",
        config.scoring.decayHalfLifeDays
      );

      await savePlaybook(playbook, config.playbookPath);

      // Track session for provenance if --session was provided
      if (flags.session) {
        const { markSessionProcessed } = await import("../onboard-state.js");
        await markSessionProcessed(flags.session, 1);
      }

      if (flags.json) {
        const result: Record<string, unknown> = { bullet };
        if (validation) result.validation = validation;
        printJsonResult(result);
      } else {
        if (validation) {
          console.log(chalk.bold("Validation:"));
          console.log(formatValidationResult(validation));
          console.log("");
        }
        console.log(chalk.green(`${icon("success")} Added bullet ${bullet.id}`));
      }
    });
    return;
  }

  if (action === "remove") {
    const id = args[0];
    if (!id) {
      if (flags.json) {
        printJsonError("ID required for remove", {
          code: ErrorCode.MISSING_REQUIRED,
          details: { missing: "bulletId", usage: "cm playbook remove <bulletId>" }
        });
      } else {
        logError("ID required for remove");
      }
      process.exitCode = 1;
      return;
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
        if (flags.json) {
          printJsonError(`Bullet ${id} not found`, {
            code: ErrorCode.BULLET_NOT_FOUND,
            details: { bulletId: id }
          });
        } else {
          logError(`Bullet ${id} not found`);
        }
        process.exitCode = 1;
        return;
      }
    }

    const candidate = findBullet(checkPlaybook, id);
    const preview = candidate
      ? truncate(candidate.content.trim().replace(/\s+/g, " "), 100)
      : "";

    // Handle --dry-run: show what would happen without making changes
    if (flags.dryRun) {
      const cli = getCliName();
      const actionType = flags.hard ? "delete" : "deprecate";
      const plan = {
        dryRun: true,
        action: actionType,
        bulletId: id,
        path: savePath,
        preview,
        category: candidate?.category,
        helpfulCount: candidate?.helpfulCount,
        harmfulCount: candidate?.harmfulCount,
        wouldChange: flags.hard
          ? "Bullet would be permanently removed from playbook"
          : "Bullet would be marked as deprecated (can be restored with cm undo)",
        applyCommand: flags.hard
          ? `${cli} playbook remove ${id} --hard --yes`
          : `${cli} playbook remove ${id}${flags.reason ? ` --reason "${flags.reason}"` : ""}`,
      };

      if (flags.json) {
        printJsonResult({ plan });
      } else {
        console.log(chalk.bold.yellow("DRY RUN - No changes will be made"));
        console.log(chalk.gray("─".repeat(50)));
        console.log();
        console.log(`Action: ${chalk.bold(actionType.toUpperCase())} bullet`);
        console.log(`Bullet ID: ${chalk.cyan(id)}`);
        console.log(`File: ${chalk.gray(savePath)}`);
        console.log(`Preview: ${chalk.cyan(`"${preview}"`)}`);
        if (candidate?.category) {
          console.log(`Category: ${chalk.cyan(candidate.category)}`);
        }
        console.log(`Feedback: ${candidate?.helpfulCount || 0}+ / ${candidate?.harmfulCount || 0}-`);
        console.log();
        console.log(chalk.yellow(`Would: ${plan.wouldChange}`));
        console.log();
        console.log(chalk.gray(`To apply: ${plan.applyCommand}`));
      }
      return;
    }

    if (flags.hard) {
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
          printJsonError("Confirmation required for --hard deletion", {
            code: ErrorCode.MISSING_REQUIRED,
            details: { bulletId: id, hint: `${cli} playbook remove ${id} --hard --yes` }
          });
        } else {
          logError("Refusing to permanently delete without confirmation.");
          console.log(chalk.gray(`Re-run with: ${cli} playbook remove ${id} --hard --yes`));
          console.log(chalk.gray(`Or omit --hard to deprecate instead.`));
        }
        process.exitCode = 1;
        return;
      }
    }

    // Acquire lock on the target file
    await withLock(savePath, async () => {
        // Reload inside lock
        const playbook = await loadPlaybook(savePath);
        const bullet = findBullet(playbook, id);

        if (!bullet) {
          if (flags.json) {
            printJsonError(`Bullet ${id} disappeared during lock acquisition`, {
              code: ErrorCode.BULLET_NOT_FOUND,
              details: { bulletId: id }
            });
          } else {
            logError(`Bullet ${id} disappeared during lock acquisition`);
          }
          process.exitCode = 1;
          return;
        }

        if (flags.hard) {
          const bulletPreview = truncate(bullet.content.trim().replace(/\s+/g, " "), 100);
          playbook.bullets = playbook.bullets.filter(b => b.id !== id);
          await savePlaybook(playbook, savePath);

          if (flags.json) {
            printJsonResult({ id, action: "deleted", path: savePath, preview: bulletPreview });
          } else {
            console.log(chalk.green(`${icon("success")} Deleted bullet ${id}`));
            console.log(chalk.gray(`  File: ${savePath}`));
            console.log(chalk.gray(`  Preview: "${bulletPreview}"`));
          }
          return;
        } else {
          deprecateBullet(playbook, id, flags.reason || "Removed via CLI");
        }

        await savePlaybook(playbook, savePath);

        if (flags.json) {
          printJsonResult({ id, action: flags.hard ? "deleted" : "deprecated" });
        } else {
          console.log(chalk.green(`${icon("success")} ${flags.hard ? "Deleted" : "Deprecated"} bullet ${id}`));
        }
    });
  }
}
