import { copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import chalk from "chalk";
import yaml from "yaml";
import { z } from "zod";
import { loadConfig } from "../config.js";
import { findBulletConflicts } from "../curate.js";
import { withLock } from "../lock.js";
import {
  formatKv,
  formatRule,
  formatTipPrefix,
  getOutputStyle,
  icon,
  iconPrefix,
  wrapText,
} from "../output.js";
import {
  addBullet,
  deprecateBullet,
  findBullet,
  getActiveBullets,
  loadMergedPlaybook,
  loadPlaybook,
  mergeImportedBullet,
  type ScrubResult,
  savePlaybook,
  scrubFeedbackFromSessions,
  sessionPathMatcher,
} from "../playbook.js";
import { createProgress, type ProgressReporter } from "../progress.js";
import {
  formatValidationResult,
  hasIssues,
  type ValidationResult,
  validateRule,
} from "../rule-validation.js";
import { getDecayedCounts, getEffectiveScore } from "../scoring.js";
import { resolveSemanticEnabled } from "../semantic.js";
import { isCmSubprocessTranscriptPath } from "../subprocess-tag.js";
import {
  ErrorCode,
  Playbook,
  type PlaybookBullet,
  PlaybookBulletSchema,
  PlaybookSchema,
} from "../types.js";
import {
  confirmDangerousAction,
  expandPath,
  fileExists,
  getCliName,
  hashContent,
  isJsonOutput,
  jaccardSimilarity,
  tokenize,
  isToonOutput,
  now,
  printJsonResult,
  printStructuredResult,
  readStdinText,
  reportError,
  resolveRepoDir,
  truncate,
  validateOneOf,
} from "../utils.js";

/** Very short rules ("Use Node 18" / "Use Node 20") only merge on exact text. */
const MIN_TOKENS_FOR_SIMILAR_MERGE = 4;

// Helper function to format a bullet for detailed display
function formatBulletDetails(
  bullet: PlaybookBullet,
  effectiveScore: number,
  decayedCounts: { decayedHelpful: number; decayedHarmful: number },
): string {
  const style = getOutputStyle();
  const cli = getCliName();
  const maxWidth = Math.min(style.width, 84);
  const divider = chalk.dim(formatRule("─", { maxWidth }));
  const wrapWidth = Math.max(24, maxWidth - 4);

  const lines: string[] = [];

  const category = bullet.category || "uncategorized";
  const maturity = bullet.maturity || "candidate";
  const kind = bullet.kind || "workflow_rule";
  const scope = bullet.scope || "global";
  const state = bullet.state || "active";

  const createdAt = bullet.createdAt || "";
  const updatedAt = bullet.updatedAt || "";
  const createdMs = Date.parse(createdAt);
  const ageDays = Number.isFinite(createdMs)
    ? Math.floor((Date.now() - createdMs) / 86_400_000)
    : null;

  lines.push(chalk.bold(`BULLET: ${bullet.id}`));
  lines.push(divider);
  lines.push("");

  lines.push(chalk.bold("Content:"));
  lines.push(divider);
  for (const line of wrapText(bullet.content.trim().replace(/\s+/g, " "), wrapWidth)) {
    lines.push(`  ${line}`);
  }
  lines.push("");

  lines.push(chalk.bold("Details"));
  lines.push(divider);
  lines.push(
    formatKv(
      [
        { key: "Category", value: category },
        { key: "Kind", value: kind },
        { key: "Maturity", value: maturity },
        { key: "Scope", value: scope },
        { key: "State", value: state },
        ...(createdAt
          ? [
              {
                key: "Created",
                value: ageDays === null ? createdAt : `${createdAt} (${ageDays} days ago)`,
              },
            ]
          : []),
        ...(updatedAt ? [{ key: "Updated", value: updatedAt }] : []),
      ],
      { indent: "  ", width: maxWidth },
    ),
  );
  lines.push("");

  lines.push(chalk.bold("Scores:"));
  lines.push(divider);
  const rawScore = (bullet.helpfulCount || 0) - (bullet.harmfulCount || 0) * 4;
  lines.push(
    formatKv(
      [
        { key: "Effective", value: `${effectiveScore.toFixed(2)} (decay)` },
        { key: "Raw", value: String(rawScore) },
        {
          key: "Helpful",
          value: `${bullet.helpfulCount || 0} (decayed ${decayedCounts.decayedHelpful.toFixed(2)})`,
        },
        {
          key: "Harmful",
          value: `${bullet.harmfulCount || 0} (decayed ${decayedCounts.decayedHarmful.toFixed(2)})`,
        },
      ],
      { indent: "  ", width: maxWidth },
    ),
  );

  if (bullet.sourceSessions && bullet.sourceSessions.length > 0) {
    lines.push("");
    lines.push(chalk.bold(`Source sessions (${bullet.sourceSessions.length})`));
    lines.push(divider);
    for (const session of bullet.sourceSessions.slice(0, 8)) {
      lines.push(`  - ${session}`);
    }
    if (bullet.sourceSessions.length > 8) {
      lines.push(chalk.dim(`  … (${bullet.sourceSessions.length - 8} more)`));
    }
  }

  if (bullet.sourceAgents && bullet.sourceAgents.length > 0) {
    lines.push("");
    lines.push(chalk.bold("Source agents"));
    lines.push(divider);
    lines.push(`  ${bullet.sourceAgents.join(", ")}`);
  }

  if (bullet.tags && bullet.tags.length > 0) {
    lines.push("");
    lines.push(chalk.bold("Tags"));
    lines.push(divider);
    lines.push(`  ${bullet.tags.join(", ")}`);
  }

  if (bullet.deprecated) {
    lines.push("");
    lines.push(chalk.red.bold("Status: DEPRECATED"));
    if (bullet.deprecationReason) lines.push(`Reason: ${bullet.deprecationReason}`);
    if (bullet.deprecatedAt) lines.push(`Deprecated at: ${bullet.deprecatedAt}`);
  }

  if (bullet.pinned) {
    lines.push("");
    lines.push(chalk.blue.bold(`${iconPrefix("pin")}PINNED`));
  }

  lines.push("");
  lines.push(chalk.gray(`${formatTipPrefix()}See provenance: ${cli} why ${bullet.id}`));

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
    .map((s) => s.id);
}

// Strip non-portable fields from bullet for export
function prepareBulletForExport(bullet: PlaybookBullet): Partial<PlaybookBullet> {
  // Create a copy without source session paths (not portable)
  const exported: Partial<PlaybookBullet> = { ...bullet };
  delete exported.sourceSessions; // Not portable between systems
  delete exported.sourceAgents; // Not portable/privacy sensitive
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
  flags: { file?: string; category?: string; check?: boolean; strict?: boolean; repo?: boolean },
  targetPath: string,
  scope: "global" | "workspace",
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
      rawInput = await readStdinText();
    } else {
      // Read from file
      rawInput = await readFile(expandPath(flags.file!), "utf-8");
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

  // The similarity half of --check embeds, so it must respect the same
  // posture as every other semantic path (#75) — otherwise --check would
  // download the model behind the back of a user who opted out. Resolved once
  // for the whole batch.
  const semanticEnabled = flags.check ? (await resolveSemanticEnabled(config)).enabled : false;

  // Process rules within a single lock
  await withLock(targetPath, async () => {
    const { loadPlaybook } = await import("../playbook.js");
    const playbook = await loadPlaybook(targetPath);

    for (let i = 0; i < rules.length; i++) {
      const raw = rules[i];

      // Validate schema
      const validated = BatchRuleSchema.safeParse(raw);
      if (!validated.success) {
        const content =
          typeof raw === "object" && raw !== null && "content" in raw
            ? String((raw as any).content).slice(0, 50)
            : `[item ${i}]`;
        result.failed.push({
          content,
          error: validated.error.errors.map((e) => e.message).join(", "),
        });
        continue;
      }

      const rule = validated.data;

      // Use per-rule category or fall back to flag category or "general"
      const category = rule.category || flags.category || "general";

      // Validate if --check flag is set
      let validation: ValidationResult | undefined;
      if (flags.check) {
        validation = await validateRule(rule.content, category, playbook, {
          skipSimilarity: !semanticEnabled,
          model: config.embeddingModel,
        });

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
            scope,
            kind: "workflow_rule",
          },
          "manual-cli",
          config.scoring.decayHalfLifeDays,
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
      await savePlaybook(playbook, targetPath);
    }
  });

  result.summary.failed = result.summary.total - result.summary.succeeded - result.summary.skipped;
  result.success = result.summary.failed === 0;

  return result;
}

export async function playbookCommand(
  action: "list" | "add" | "remove" | "get" | "export" | "import" | "scrub" | "conflicts",
  args: string[],
  flags: {
    category?: string;
    json?: boolean;
    format?: "json" | "toon";
    stats?: boolean;
    hard?: boolean;
    yes?: boolean;
    dryRun?: boolean;
    reason?: string;
    all?: boolean;
    replace?: boolean;
    file?: string;
    session?: string;
    check?: boolean;
    strict?: boolean;
    repo?: boolean;
    fromSessions?: string[];
    cmSubprocessCalls?: boolean;
    deprecateOrphans?: boolean;
  },
) {
  const startedAtMs = Date.now();
  const command = `playbook:${action}`;
  const config = await loadConfig();

  if (action === "scrub") {
    await handleScrub(config, flags, command, startedAtMs);
    return;
  }

  if (action === "conflicts") {
    await handleConflicts(config, flags, command, startedAtMs);
    return;
  }

  if (action === "export") {
    const progressFormat = flags.json ? "json" : "text";
    const exportProgress = createProgress({
      message: "Exporting playbook...",
      format: progressFormat,
      stream: process.stderr,
    });
    exportProgress.update(0, "Exporting playbook...");
    const playbook = await loadMergedPlaybook(config);

    // Filter bullets based on --all flag
    const bulletsToExport = flags.all
      ? playbook.bullets
      : playbook.bullets.filter((b) => !b.deprecated);

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

    exportProgress.complete(`Export ready (${exportedBullets.length} bullets)`);

    // JSON envelope with --json; YAML (more human-readable) otherwise.
    if (flags.json) {
      printJsonResult(command, exportData, { startedAtMs });
    } else {
      console.log(yaml.stringify(exportData));
    }
    return;
  }

  if (action === "import") {
    const filePath = args[0];
    if (!filePath) {
      reportError("File path required for import", {
        code: ErrorCode.MISSING_REQUIRED,
        details: { missing: "filePath", usage: "cm playbook import <file>" },
        json: flags.json,
        command,
        startedAtMs,
      });
      return;
    }

    // Determine target path based on --repo flag
    let targetPath = config.playbookPath;
    if (flags.repo) {
      const repoDir = await resolveRepoDir();
      if (!repoDir) {
        reportError("Not in a git repository. Cannot import to repo playbook.", {
          code: ErrorCode.CONFIG_INVALID,
          hint: "Run inside a git repo or omit --repo",
          json: flags.json,
          command,
          startedAtMs,
        });
        return;
      }
      targetPath = path.join(repoDir, "playbook.yaml");
      // Ensure file exists (or at least directory)
      if (!(await fileExists(targetPath))) {
        // If it doesn't exist, check if we can create it (init --repo logic check)
        // But for import, we usually expect it to exist or we create it.
        // Let's assume we can create it if the dir exists.
        if (!(await fileExists(repoDir))) {
          await mkdir(repoDir, { recursive: true });
        }
      }
    }

    const progressFormat = flags.json ? "json" : "text";
    const expandedFilePath = expandPath(filePath);

    // Check file exists
    if (!(await fileExists(expandedFilePath))) {
      reportError(`File not found: ${expandedFilePath}`, {
        code: ErrorCode.FILE_NOT_FOUND,
        details: { path: expandedFilePath },
        json: flags.json,
        command,
        startedAtMs,
      });
      return;
    }

    // Read and parse file
    const content = await readFile(expandedFilePath, "utf-8");
    const format = detectFormat(content, expandedFilePath);

    let importedData: any;
    try {
      if (format === "json") {
        importedData = JSON.parse(content);
      } else {
        importedData = yaml.parse(content);
      }
    } catch (err: any) {
      const message = err?.message || String(err);
      reportError(`Parse error: ${message}`, {
        code: ErrorCode.INVALID_INPUT,
        details: { format, path: filePath },
        json: flags.json,
        command,
        startedAtMs,
      });
      return;
    }

    // Allow importing files that contain a standard cm JSON envelope (e.g. playbook export --json output).
    if (
      importedData &&
      typeof importedData === "object" &&
      !Array.isArray(importedData) &&
      "success" in importedData &&
      "data" in importedData
    ) {
      importedData = (importedData as any).data;
    }

    // Validate imported bullets
    const importedBullets: PlaybookBullet[] = [];
    const validationErrors: string[] = [];

    const bulletsArray = importedData.bullets || importedData;
    if (!Array.isArray(bulletsArray)) {
      reportError("Invalid format: expected bullets array", {
        code: ErrorCode.INVALID_INPUT,
        details: { expected: "array", path: filePath },
        json: flags.json,
        command,
        startedAtMs,
      });
      return;
    }

    const validateProgress = createProgress({
      message: "Validating imported bullets...",
      total: bulletsArray.length,
      showEta: true,
      format: progressFormat,
      stream: process.stderr,
    });
    validateProgress.update(0, "Validating imported bullets...");

    for (let i = 0; i < bulletsArray.length; i++) {
      validateProgress.update(i + 1, "Validating imported bullets...");
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

    validateProgress.complete("Validation complete");

    if (validationErrors.length > 0 && importedBullets.length === 0) {
      reportError("All bullets failed validation", {
        code: ErrorCode.VALIDATION_FAILED,
        details: { errors: validationErrors, path: filePath },
        json: flags.json,
        command,
        startedAtMs,
      });
      if (!flags.json) {
        validationErrors.forEach((e) => console.error(`  - ${e}`));
      }
      return;
    }

    const mergeProgress = createProgress({
      message: "Importing playbook...",
      total: importedBullets.length,
      showEta: true,
      format: progressFormat,
      stream: process.stderr,
    });
    mergeProgress.update(0, "Merging bullets...");
    let added = 0;
    let skipped = 0;
    let updated = 0;
    let merged = 0;
    let feedbackMerged = 0;
    const mergedInto: Array<{ importedId: string; existingId: string; how: "exact" | "similar" }> =
      [];
    let conflicts: Array<{ importedId: string; existingId: string; reason: string }> = [];

    // Merge with existing playbook. Beyond ids, rules are matched by content
    // (exact, or word overlap >= dedupSimilarityThreshold) so a teammate's
    // copy of a rule under another id merges its track record into ours
    // instead of becoming a duplicate.
    await withLock(targetPath, async () => {
      const existingPlaybook = await loadPlaybook(targetPath);
      const existingIds = new Set(existingPlaybook.bullets.map((b) => b.id));
      const isActive = (b: PlaybookBullet) =>
        !(b.deprecated || b.maturity === "deprecated" || b.state === "retired");
      const byHash = new Map<string, PlaybookBullet>();
      for (const b of existingPlaybook.bullets) {
        if (isActive(b)) byHash.set(hashContent(b.content), b);
      }
      const threshold =
        typeof config.dedupSimilarityThreshold === "number" ? config.dedupSimilarityThreshold : 0.85;
      const newlyAdded: PlaybookBullet[] = [];

      for (let i = 0; i < importedBullets.length; i++) {
        const bullet = importedBullets[i];
        const sameId = existingIds.has(bullet.id)
          ? existingPlaybook.bullets.find((b) => b.id === bullet.id)
          : undefined;
        if (sameId) {
          if (flags.replace) {
            const idx = existingPlaybook.bullets.indexOf(sameId);
            existingPlaybook.bullets[idx] = bullet;
            updated++;
          } else if (hashContent(sameId.content) === hashContent(bullet.content)) {
            feedbackMerged += mergeImportedBullet(sameId, bullet, config);
            merged++;
          } else {
            skipped++;
          }
        } else if (!isActive(bullet)) {
          existingPlaybook.bullets.push(bullet);
          added++;
        } else {
          const exact = byHash.get(hashContent(bullet.content));
          const similar =
            exact ??
            (tokenize(bullet.content).length >= MIN_TOKENS_FOR_SIMILAR_MERGE
              ? existingPlaybook.bullets.find(
                  (b) =>
                    isActive(b) &&
                    tokenize(b.content).length >= MIN_TOKENS_FOR_SIMILAR_MERGE &&
                    jaccardSimilarity(b.content, bullet.content) >= threshold,
                )
              : undefined);
          if (similar) {
            feedbackMerged += mergeImportedBullet(similar, bullet, config);
            mergedInto.push({
              importedId: bullet.id,
              existingId: similar.id,
              how: exact ? "exact" : "similar",
            });
            merged++;
          } else {
            existingPlaybook.bullets.push(bullet);
            existingIds.add(bullet.id);
            byHash.set(hashContent(bullet.content), bullet);
            newlyAdded.push(bullet);
            added++;
          }
        }
        mergeProgress.update(i + 1, "Merging bullets...");
      }

      // Contradictions between what was just imported and what was already there.
      const addedIds = new Set(newlyAdded.map((b) => b.id));
      conflicts = findBulletConflicts(existingPlaybook.bullets)
        .filter((p) => addedIds.has(p.a.id) !== addedIds.has(p.b.id))
        .map((p) =>
          addedIds.has(p.a.id)
            ? { importedId: p.a.id, existingId: p.b.id, reason: p.reason }
            : { importedId: p.b.id, existingId: p.a.id, reason: p.reason },
        );

      mergeProgress.update(importedBullets.length, "Saving playbook...");
      await savePlaybook(existingPlaybook, targetPath);
      mergeProgress.complete(
        `Import complete (${added} added, ${merged} merged, ${updated} updated, ${skipped} skipped)`,
      );

      if (flags.json) {
        printJsonResult(
          command,
          {
            file: filePath,
            target: targetPath,
            added,
            merged,
            feedbackEventsMerged: feedbackMerged,
            mergedInto,
            skipped,
            updated,
            conflicts,
            validationWarnings: validationErrors.length > 0 ? validationErrors : undefined,
          },
          { startedAtMs },
        );
      } else {
        console.log(chalk.green(`${icon("success")} Imported playbook from ${filePath}`));
        console.log(chalk.dim(`  Target: ${targetPath}`));
        console.log(`  - ${chalk.green(added)} bullets added`);
        if (merged > 0) {
          console.log(
            `  - ${chalk.cyan(merged)} bullets merged into existing rules (${feedbackMerged} feedback events combined)`,
          );
        }
        console.log(`  - ${chalk.yellow(skipped)} bullets skipped (already exist)`);
        if (conflicts.length > 0) {
          console.log(
            chalk.yellow(
              `  - ${conflicts.length} imported rule(s) may contradict existing ones; review: ${getCliName()} playbook conflicts`,
            ),
          );
        }
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
      reportError("Bullet ID required for get", {
        code: ErrorCode.MISSING_REQUIRED,
        details: { missing: "bulletId", usage: "cm playbook get <bulletId>" },
        json: flags.json,
        command,
        startedAtMs,
      });
      return;
    }

    const playbook = await loadMergedPlaybook(config);
    const bullet = findBullet(playbook, id);

    if (!bullet) {
      const allBullets = playbook.bullets || [];
      const similar = findSimilarIds(allBullets, id);
      const hint = similar.length > 0 ? `Did you mean: ${similar.join(", ")}?` : undefined;

      reportError(`Bullet '${id}' not found`, {
        code: ErrorCode.BULLET_NOT_FOUND,
        hint,
        details: { bulletId: id, suggestions: similar.length > 0 ? similar : undefined },
        json: flags.json,
        command,
        startedAtMs,
      });
      return;
    }

    const effectiveScore = getEffectiveScore(bullet, config);
    const decayedCounts = getDecayedCounts(bullet, config);

    if (flags.json) {
      const ageMs = Date.now() - new Date(bullet.createdAt).getTime();
      const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));

      printJsonResult(
        command,
        {
          bullet: {
            ...bullet,
            effectiveScore,
            decayedHelpful: decayedCounts.decayedHelpful,
            decayedHarmful: decayedCounts.decayedHarmful,
            ageDays,
          },
        },
        { startedAtMs },
      );
    } else {
      console.log(formatBulletDetails(bullet, effectiveScore, decayedCounts));
    }
    return;
  }

  if (action === "list") {
    const formatCheck = validateOneOf(flags.format, "format", ["json", "toon"] as const, {
      allowUndefined: true,
      caseInsensitive: true,
    });
    if (!formatCheck.ok) {
      reportError(formatCheck.message, {
        code: ErrorCode.INVALID_INPUT,
        details: formatCheck.details,
        hint: "Valid formats: json, toon",
        json: flags.json,
        format: flags.format,
        command,
        startedAtMs,
      });
      return;
    }
    const normalizedFlags = {
      ...flags,
      ...(formatCheck.value !== undefined ? { format: formatCheck.value } : {}),
    };

    const playbook = await loadMergedPlaybook(config);
    let bullets = getActiveBullets(playbook);

    if (flags.category) {
      bullets = bullets.filter((b: any) => b.category === flags.category);
    }

    const wantsJson = isJsonOutput(normalizedFlags);
    const wantsToon = isToonOutput(normalizedFlags);
    if (wantsJson || wantsToon) {
      printStructuredResult(command, { bullets }, normalizedFlags, { startedAtMs });
    } else {
      const style = getOutputStyle();
      const cli = getCliName();
      const maxWidth = Math.min(style.width, 84);
      const divider = chalk.dim(formatRule("─", { maxWidth }));
      const wrapWidth = Math.max(24, maxWidth - 6);

      console.log(chalk.bold(`PLAYBOOK RULES (${bullets.length}):`));
      console.log(divider);

      if (bullets.length === 0) {
        console.log(chalk.dim("(No active rules found)"));
        console.log(
          chalk.gray(
            `${formatTipPrefix()}Try '${cli} reflect' to learn rules from sessions, or '${cli} playbook add "..."'.`,
          ),
        );
        return;
      }

      for (const b of bullets) {
        const score = getEffectiveScore(b, config);
        const scoreColor = score >= 5 ? chalk.green : score >= 0 ? chalk.white : chalk.red;
        const scoreLabel = Number.isFinite(score) ? scoreColor(score.toFixed(1)) : chalk.dim("n/a");

        const pinnedLabel = b.pinned ? chalk.blue(` ${iconPrefix("pin")}PINNED`) : "";
        const meta = chalk.dim(
          ` ${b.category}/${b.scope} • ${b.kind} • ${b.maturity} • score ${scoreLabel}`,
        );
        console.log(chalk.bold(`[${b.id}]`) + meta + pinnedLabel);

        const preview = String(b.content || "")
          .trim()
          .replace(/\s+/g, " ");
        const wrapped = wrapText(preview, wrapWidth);
        for (const line of wrapped.slice(0, 2)) {
          console.log(chalk.gray(`  ${line}`));
        }
        if (wrapped.length > 2) {
          console.log(chalk.dim("  …"));
        }
      }

      console.log("");
      console.log(
        chalk.gray(`${formatTipPrefix()}Use '${cli} playbook get <id>' for full details.`),
      );
    }
    return;
  }

  if (action === "add") {
    // Handle batch add via --file
    if (flags.file) {
      // Determine target path and scope based on --repo flag
      let batchTargetPath = config.playbookPath;
      const batchScope: "global" | "workspace" = flags.repo ? "workspace" : "global";
      if (flags.repo) {
        const repoDir = await resolveRepoDir();
        if (!repoDir) {
          reportError("Not in a git repository. Cannot add to repo playbook.", {
            code: ErrorCode.CONFIG_INVALID,
            hint: "Run inside a git repo or omit --repo",
            json: flags.json,
            command,
            startedAtMs,
          });
          return;
        }
        batchTargetPath = path.join(repoDir, "playbook.yaml");
        // Ensure .cass/ directory exists
        if (!(await fileExists(repoDir))) {
          await mkdir(repoDir, { recursive: true });
        }
      }

      const result = await handleBatchAdd(config, flags, batchTargetPath, batchScope);

      // If --session was provided, update onboarding state
      if (flags.session && result.summary.succeeded > 0) {
        const { markSessionProcessed } = await import("../onboard-state.js");
        await markSessionProcessed(flags.session, result.summary.succeeded);
      }

      if (flags.json) {
        // Include target info in JSON output
        const jsonResult = {
          ...result,
          target: flags.repo ? "repo" : "global",
          targetPath: batchTargetPath,
        };
        printJsonResult(command, jsonResult, { startedAtMs });
      } else {
        const targetLabel = flags.repo
          ? chalk.cyan("(repo playbook)")
          : chalk.dim("(global playbook)");
        console.log(chalk.bold(`BATCH ADD RESULTS ${targetLabel}`));
        console.log("");
        if (result.added.length > 0) {
          console.log(chalk.green(`${icon("success")} Added ${result.added.length} rules:`));
          for (const r of result.added) {
            console.log(chalk.dim(`  ${r.id}: ${truncate(r.content, 60)}`));
          }
        }
        if (result.skipped.length > 0) {
          console.log("");
          console.log(
            chalk.yellow(`${icon("skipped")} Skipped ${result.skipped.length} rules (--strict):`),
          );
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
      reportError("Content required for add", {
        code: ErrorCode.MISSING_REQUIRED,
        details: { missing: "content", usage: "cm playbook add <content>" },
        json: flags.json,
        command,
        startedAtMs,
      });
      return;
    }

    // Determine target path and scope based on --repo flag
    let targetPath = config.playbookPath;
    const scope: "global" | "workspace" = flags.repo ? "workspace" : "global";
    if (flags.repo) {
      const repoDir = await resolveRepoDir();
      if (!repoDir) {
        reportError("Not in a git repository. Cannot add to repo playbook.", {
          code: ErrorCode.CONFIG_INVALID,
          hint: "Run inside a git repo or omit --repo",
          json: flags.json,
          command,
          startedAtMs,
        });
        return;
      }
      targetPath = path.join(repoDir, "playbook.yaml");
      // Ensure .cass/ directory exists
      if (!(await fileExists(repoDir))) {
        await mkdir(repoDir, { recursive: true });
      }
    }

    await withLock(targetPath, async () => {
      const { loadPlaybook } = await import("../playbook.js");
      const playbook = await loadPlaybook(targetPath);
      const category = flags.category || "general";

      // Validate if --check flag is set
      let validation: ValidationResult | undefined;
      if (flags.check) {
        validation = await validateRule(content, category, playbook, {
          // Same posture gate as the batch path above (#75).
          skipSimilarity: !(await resolveSemanticEnabled(config)).enabled,
          model: config.embeddingModel,
        });

        // In strict mode, fail on warnings
        if (flags.strict && hasIssues(validation)) {
          reportError("Validation failed in strict mode", {
            code: ErrorCode.VALIDATION_FAILED,
            details: { validation },
            recovery: [
              "Fix the issues reported below and re-run.",
              "Or omit --strict to add anyway.",
            ],
            json: flags.json,
            command,
            startedAtMs,
          });
          if (!flags.json) {
            console.log(chalk.red("Validation failed (--strict mode):"));
            console.log(formatValidationResult(validation));
          }
          return;
        }
      }

      const bullet = addBullet(
        playbook,
        {
          content,
          category,
          scope,
          kind: "workflow_rule",
        },
        "manual-cli",
        config.scoring.decayHalfLifeDays,
      );

      await savePlaybook(playbook, targetPath);

      // Track session for provenance if --session was provided
      if (flags.session) {
        const { markSessionProcessed } = await import("../onboard-state.js");
        await markSessionProcessed(flags.session, 1);
      }

      if (flags.json) {
        const result: Record<string, unknown> = {
          bullet,
          target: flags.repo ? "repo" : "global",
          targetPath,
        };
        if (validation) result.validation = validation;
        printJsonResult(command, result, { startedAtMs });
      } else {
        if (validation) {
          console.log(chalk.bold("Validation:"));
          console.log(formatValidationResult(validation));
          console.log("");
        }
        const targetLabel = flags.repo ? chalk.cyan(" to repo playbook") : "";
        console.log(chalk.green(`${icon("success")} Added bullet ${bullet.id}${targetLabel}`));
      }
    });
    return;
  }

  if (action === "remove") {
    const id = args[0];
    if (!id) {
      reportError("ID required for remove", {
        code: ErrorCode.MISSING_REQUIRED,
        details: { missing: "bulletId", usage: "cm playbook remove <bulletId>" },
        json: flags.json,
        command,
        startedAtMs,
      });
      return;
    }

    // Determine target first (read-only check)
    const repoDir = await resolveRepoDir();
    const repoPath = repoDir ? path.join(repoDir, "playbook.yaml") : null;

    let savePath = config.playbookPath;
    let checkPlaybook = await loadPlaybook(config.playbookPath);

    if (repoPath && (await fileExists(repoPath))) {
      try {
        const repoPlaybook = await loadPlaybook(repoPath);
        // Prefer repo-level bullets when present (repo rules take precedence).
        if (findBullet(repoPlaybook, id)) {
          savePath = repoPath;
          checkPlaybook = repoPlaybook;
        }
      } catch (err: any) {
        const message = err?.message || String(err);
        reportError(err instanceof Error ? err : message, {
          code: ErrorCode.PLAYBOOK_CORRUPT,
          details: { path: repoPath },
          json: flags.json,
          command,
          startedAtMs,
        });
        return;
      }
    }

    if (!findBullet(checkPlaybook, id)) {
      reportError(`Bullet ${id} not found`, {
        code: ErrorCode.BULLET_NOT_FOUND,
        details: { bulletId: id },
        json: flags.json,
        command,
        startedAtMs,
      });
      return;
    }

    const candidate = findBullet(checkPlaybook, id);
    const preview = candidate ? truncate(candidate.content.trim().replace(/\s+/g, " "), 100) : "";

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
        printJsonResult(command, { plan }, { startedAtMs });
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
        console.log(
          `Feedback: ${candidate?.helpfulCount || 0}+ / ${candidate?.harmfulCount || 0}-`,
        );
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
        reportError("Confirmation required for --hard deletion", {
          code: ErrorCode.MISSING_REQUIRED,
          hint: `${cli} playbook remove ${id} --hard --yes`,
          recovery: [
            `Re-run with: ${cli} playbook remove ${id} --hard --yes`,
            "Or omit --hard to deprecate instead.",
          ],
          details: { bulletId: id },
          json: flags.json,
          command,
          startedAtMs,
        });
        return;
      }
    }

    // Acquire lock on the target file
    await withLock(savePath, async () => {
      // Reload inside lock
      const playbook = await loadPlaybook(savePath);
      const bullet = findBullet(playbook, id);

      if (!bullet) {
        reportError(`Bullet ${id} disappeared during lock acquisition`, {
          code: ErrorCode.BULLET_NOT_FOUND,
          details: { bulletId: id },
          json: flags.json,
          command,
          startedAtMs,
        });
        return;
      }

      if (flags.hard) {
        const bulletPreview = truncate(bullet.content.trim().replace(/\s+/g, " "), 100);
        playbook.bullets = playbook.bullets.filter((b) => b.id !== id);
        await savePlaybook(playbook, savePath);

        if (flags.json) {
          printJsonResult(
            command,
            { id, action: "deleted", path: savePath, preview: bulletPreview },
            { startedAtMs },
          );
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
        printJsonResult(
          command,
          { id, action: flags.hard ? "deleted" : "deprecated" },
          { startedAtMs },
        );
      } else {
        console.log(
          chalk.green(`${icon("success")} ${flags.hard ? "Deleted" : "Deprecated"} bullet ${id}`),
        );
      }
    });
  }
}

// --- scrub (#77) ---

interface ScrubTargetReport extends ScrubResult {
  path: string;
  scope: "global" | "repo";
  backupPath: string | null;
  deprecated: string[];
}

async function handleScrub(
  config: Awaited<ReturnType<typeof loadConfig>>,
  flags: {
    json?: boolean;
    dryRun?: boolean;
    fromSessions?: string[];
    cmSubprocessCalls?: boolean;
    deprecateOrphans?: boolean;
  },
  command: string,
  startedAtMs: number,
): Promise<void> {
  const cli = getCliName();
  const patterns = (flags.fromSessions ?? []).map((p) => p.trim()).filter((p) => p !== "");
  if (patterns.length === 0 && !flags.cmSubprocessCalls) {
    reportError("Nothing to scrub: pass --from-sessions <pattern> and/or --cm-subprocess-calls", {
      code: ErrorCode.MISSING_REQUIRED,
      hint: `${cli} playbook scrub --cm-subprocess-calls --dry-run --json`,
      details: { usage: "cm playbook scrub (--from-sessions <pattern>... | --cm-subprocess-calls)" },
      json: flags.json,
      command,
      startedAtMs,
    });
    return;
  }

  const matchers = patterns.map(sessionPathMatcher);
  if (flags.cmSubprocessCalls) {
    matchers.push((p) => isCmSubprocessTranscriptPath(p, config.cliSubprocessCwd));
  }
  const matches = (p: string) => matchers.some((m) => m(p));

  const targets: Array<{ path: string; scope: "global" | "repo" }> = [];
  const globalPath = expandPath(config.playbookPath);
  if (await fileExists(globalPath)) targets.push({ path: globalPath, scope: "global" });
  const repoDir = await resolveRepoDir();
  const repoPath = repoDir ? path.join(repoDir, "playbook.yaml") : null;
  if (repoPath && repoPath !== globalPath && (await fileExists(repoPath))) {
    targets.push({ path: repoPath, scope: "repo" });
  }

  const reports: ScrubTargetReport[] = [];
  try {
    for (const target of targets) {
      const report = await withLock(target.path, async () => {
        const playbook = await loadPlaybook(target.path);
        const scrub = scrubFeedbackFromSessions(playbook, matches, config);
        const deprecated: string[] = [];
        if (flags.deprecateOrphans) {
          for (const b of scrub.bullets) {
            if (!(b.noRemainingFeedback || b.noRemainingSources)) continue;
            const bullet = findBullet(playbook, b.id);
            if (!bullet || bullet.deprecated || bullet.pinned) continue;
            deprecateBullet(playbook, b.id, "Scrubbed: no genuine support left after cm playbook scrub");
            b.maturity.after = "deprecated";
            deprecated.push(b.id);
          }
        }

        let backupPath: string | null = null;
        if (!flags.dryRun && scrub.bulletsTouched > 0) {
          const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
          backupPath = `${target.path}.backup.${timestamp}`;
          await copyFile(target.path, backupPath);
          await savePlaybook(playbook, target.path);
        }
        return { ...scrub, path: target.path, scope: target.scope, backupPath, deprecated };
      });
      reports.push(report);
    }
  } catch (err: any) {
    reportError(err instanceof Error ? err : String(err), {
      code: ErrorCode.PLAYBOOK_CORRUPT,
      json: flags.json,
      command,
      startedAtMs,
    });
    return;
  }

  const all = reports.flatMap((r) => r.bullets);
  const noRemainingFeedback = all.filter((b) => b.noRemainingFeedback).map((b) => b.id);
  const noRemainingSources = all.filter((b) => b.noRemainingSources).map((b) => b.id);
  const summary = {
    dryRun: Boolean(flags.dryRun),
    patterns,
    cmSubprocessCalls: Boolean(flags.cmSubprocessCalls),
    bulletsTouched: reports.reduce((n, r) => n + r.bulletsTouched, 0),
    eventsRemoved: reports.reduce((n, r) => n + r.eventsRemoved, 0),
    sourcesRemoved: reports.reduce((n, r) => n + r.sourcesRemoved, 0),
    // Candidates for removal: reported, never deleted implicitly.
    noRemainingFeedback,
    noRemainingSources,
    deprecated: reports.flatMap((r) => r.deprecated),
    playbooks: reports,
  };

  if (flags.json) {
    printJsonResult(command, summary, { startedAtMs });
    return;
  }

  const style = getOutputStyle();
  console.log(
    chalk.bold(flags.dryRun ? "PLAYBOOK SCRUB (dry run - no changes written)" : "PLAYBOOK SCRUB"),
  );
  console.log(chalk.gray(formatRule("─", { maxWidth: style.width })));
  if (targets.length === 0) {
    console.log(chalk.gray("No playbook files found."));
    return;
  }
  for (const r of reports) {
    console.log(
      `${r.scope === "repo" ? "Repo" : "Global"} playbook ${chalk.gray(r.path)}: ` +
        `${r.eventsRemoved} feedback event(s) and ${r.sourcesRemoved} source session(s) removed from ${r.bulletsTouched} bullet(s)`,
    );
    if (r.backupPath) console.log(chalk.gray(`  Backup: ${r.backupPath}`));
    for (const b of r.bullets) {
      const maturity =
        b.maturity.before === b.maturity.after
          ? b.maturity.after
          : `${b.maturity.before} -> ${b.maturity.after}`;
      console.log(
        `  ${chalk.cyan(b.id)} -${b.removedEvents} events, ` +
          `${b.helpfulCount.before}+/${b.harmfulCount.before}- -> ${b.helpfulCount.after}+/${b.harmfulCount.after}-, ${maturity}`,
      );
    }
  }
  if (noRemainingFeedback.length > 0 || noRemainingSources.length > 0) {
    console.log();
    const orphans = Array.from(new Set([...noRemainingFeedback, ...noRemainingSources]));
    console.log(
      chalk.yellow(
        `${orphans.length} bullet(s) have no genuine support left (no remaining feedback or sources):`,
      ),
    );
    console.log(`  ${orphans.join(" ")}`);
    if (summary.deprecated.length > 0) {
      console.log(chalk.green(`  Deprecated ${summary.deprecated.length} (--deprecate-orphans).`));
    } else {
      console.log(
        chalk.gray(
          `  Review with '${cli} playbook get <id>'; remove with '${cli} playbook remove <id>' or re-run with --deprecate-orphans.`,
        ),
      );
    }
  }
  if (flags.dryRun && summary.bulletsTouched > 0) {
    console.log();
    console.log(chalk.gray("Re-run without --dry-run to apply (playbooks are backed up first)."));
  }
}

// --- conflicts ---

async function handleConflicts(
  config: Awaited<ReturnType<typeof loadConfig>>,
  flags: { json?: boolean; category?: string },
  command: string,
  startedAtMs: number,
): Promise<void> {
  const cli = getCliName();
  let bullets: PlaybookBullet[];
  try {
    bullets = getActiveBullets(await loadMergedPlaybook(config));
  } catch (err: any) {
    reportError(err instanceof Error ? err : String(err), {
      code: ErrorCode.PLAYBOOK_CORRUPT,
      json: flags.json,
      command,
      startedAtMs,
    });
    return;
  }
  if (flags.category) bullets = bullets.filter((b) => b.category === flags.category);
  const byId = new Map(bullets.map((b) => [b.id, b]));
  const describe = (id: string) => {
    const b = byId.get(id)!;
    return {
      id,
      content: b.content,
      category: b.category,
      maturity: b.maturity,
      pinned: Boolean(b.pinned),
      helpfulCount: b.helpfulCount ?? 0,
      harmfulCount: b.harmfulCount ?? 0,
      effectiveScore: Math.round(getEffectiveScore(b, config) * 1000) / 1000,
    };
  };

  const conflicts = findBulletConflicts(bullets).map((p) => {
    const a = describe(p.a.id);
    const b = describe(p.b.id);
    // Suggest keeping the better-supported rule; pinned always wins. No suggestion on a tie.
    const score = (x: typeof a) => (x.pinned ? Number.POSITIVE_INFINITY : x.effectiveScore);
    const weaker = score(a) === score(b) ? null : score(a) < score(b) ? a : b;
    return {
      a,
      b,
      reason: p.reason,
      ...(weaker
        ? {
            suggestion: `Keep ${weaker === a ? b.id : a.id} (better supported); retire ${weaker.id}: ${cli} playbook remove ${weaker.id} --reason "Contradicts ${weaker === a ? b.id : a.id}"`,
          }
        : {
            suggestion: `Equal support: decide which applies, or merge them into one rule with an explicit exception`,
          }),
    };
  });

  if (flags.json) {
    printJsonResult(
      command,
      { bulletsChecked: bullets.length, count: conflicts.length, conflicts },
      { startedAtMs },
    );
    return;
  }

  const style = getOutputStyle();
  console.log(chalk.bold(`PLAYBOOK CONFLICTS (${conflicts.length})`));
  console.log(chalk.gray(formatRule("─", { maxWidth: style.width })));
  if (conflicts.length === 0) {
    console.log(chalk.green(`No contradicting rules among ${bullets.length} active bullet(s).`));
    return;
  }
  const width = Math.max(40, style.width - 6);
  for (const c of conflicts) {
    console.log(chalk.yellow(c.reason));
    for (const side of [c.a, c.b]) {
      const lines = wrapText(side.content, width);
      console.log(
        `  ${chalk.cyan(side.id)} ${chalk.gray(`(${side.maturity}, score ${side.effectiveScore}${side.pinned ? ", pinned" : ""})`)}`,
      );
      for (const line of lines) console.log(`    ${line}`);
    }
    console.log(chalk.gray(`  ${c.suggestion}`));
    console.log();
  }
}

