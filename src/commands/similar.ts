import chalk from "chalk";
import { loadConfig } from "../config.js";
import { loadMergedPlaybook, getActiveBullets } from "../playbook.js";
import { findSimilarBulletsSemantic, getSemanticStatus, formatSemanticModeMessage } from "../semantic.js";
import { getEffectiveScore } from "../scoring.js";
import { isJsonOutput, isToonOutput, jaccardSimilarity, truncate, getCliName, printStructuredResult, reportError, validateOneOf, warn } from "../utils.js";
import { ErrorCode, PlaybookBullet } from "../types.js";
import { formatRule, formatTipPrefix, getOutputStyle, wrapText } from "../output.js";

export type SimilarScope = "global" | "workspace" | "all";

export interface SimilarFlags {
  limit?: number;
  threshold?: number;
  scope?: SimilarScope;
  json?: boolean;
  format?: "json" | "toon";
  stats?: boolean;
}

export interface SimilarResultItem {
  id: string;
  similarity: number;
  content: string;
  category: string;
  scope: string;
  effectiveScore: number;
  preview: string;
}

export interface SimilarResult {
  query: string;
  mode: "semantic" | "keyword";
  results: SimilarResultItem[];
}

function filterBulletsByScope(bullets: PlaybookBullet[], scope: SimilarScope): PlaybookBullet[] {
  if (scope === "all") return bullets;
  return bullets.filter((b) => b.scope === scope);
}

function isValidScope(value: string): value is SimilarScope {
  return value === "global" || value === "workspace" || value === "all";
}

export async function generateSimilarResults(
  query: string,
  flags: SimilarFlags = {}
): Promise<SimilarResult> {
  const cleaned = query?.trim();
  if (!cleaned) {
    throw new Error("Query is required");
  }

  const providedLimit = flags.limit;
  if (providedLimit !== undefined) {
    if (typeof providedLimit !== "number" || !Number.isFinite(providedLimit) || !Number.isInteger(providedLimit)) {
      throw new Error("--limit must be an integer >= 1");
    }
    if (providedLimit < 1) {
      throw new Error("--limit must be an integer >= 1");
    }
  }
  const limit = providedLimit ?? 5;

  const providedThreshold = flags.threshold;
  if (providedThreshold !== undefined) {
    if (typeof providedThreshold !== "number" || !Number.isFinite(providedThreshold)) {
      throw new Error("--threshold must be between 0 and 1");
    }
  }
  const threshold = providedThreshold ?? 0.7;

  if (threshold < 0 || threshold > 1) {
    throw new Error("--threshold must be between 0 and 1");
  }

  const scopeRaw = typeof flags.scope === "string" ? flags.scope.trim() : "";
  const scope = (scopeRaw ? scopeRaw.toLowerCase() : "all") as string;
  if (!isValidScope(scope)) {
    throw new Error(`Invalid --scope "${String(flags.scope)}" (expected: global|workspace|all)`);
  }

  const config = await loadConfig();
  const playbook = await loadMergedPlaybook(config);
  const bullets = filterBulletsByScope(getActiveBullets(playbook), scope);

  let mode: SimilarResult["mode"] = "keyword";
  let matches: Array<{ bullet: PlaybookBullet; similarity: number }> = [];

  const embeddingModel =
    typeof config.embeddingModel === "string" && config.embeddingModel.trim() !== ""
      ? config.embeddingModel.trim()
      : undefined;
  const semanticEnabled = config.semanticSearchEnabled && embeddingModel !== "none";

  if (semanticEnabled) {
    try {
      const semanticMatches = await findSimilarBulletsSemantic(cleaned, bullets, limit, {
        threshold,
        model: embeddingModel,
      });
      matches = semanticMatches.map((m) => ({ bullet: m.bullet, similarity: m.similarity }));
      mode = "semantic";
    } catch (err: any) {
      // Caller decides whether to display warnings; we fall back silently here.
      warn(`[similar] Semantic search failed: ${err.message || String(err)}. Falling back to keyword search.`);
      matches = [];
      mode = "keyword";
    }
  }

  if (mode === "keyword") {
    matches = bullets
      .map((bullet) => ({
        bullet,
        similarity: jaccardSimilarity(cleaned, bullet.content),
      }))
      .filter((m) => m.similarity >= threshold)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);
  }

  const results: SimilarResultItem[] = matches.map(({ bullet, similarity }) => {
    const effectiveScore = getEffectiveScore(bullet, config);
    return {
      id: bullet.id,
      similarity,
      content: bullet.content,
      category: bullet.category,
      scope: bullet.scope,
      effectiveScore,
      preview: truncate(bullet.content.trim().replace(/\s+/g, " "), 120),
    };
  });

  return { query: cleaned, mode, results };
}

export async function similarCommand(query: string, flags: SimilarFlags): Promise<void> {
  const startedAtMs = Date.now();
  const command = "similar";
  try {
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

    const normalizedFlags: SimilarFlags = {
      ...flags,
      ...(formatCheck.value !== undefined ? { format: formatCheck.value } : {}),
    };

    const result = await generateSimilarResults(query, normalizedFlags);

    const wantsJson = isJsonOutput(normalizedFlags);
    const wantsToon = isToonOutput(normalizedFlags);
    if (wantsJson || wantsToon) {
      printStructuredResult(command, result, normalizedFlags, { startedAtMs });
      return;
    }

    const config = await loadConfig();
    const semanticStatus = getSemanticStatus(config);
    const style = getOutputStyle();
    const modeMessage = formatSemanticModeMessage(result.mode, semanticStatus);

    const maxWidth = Math.min(style.width, 84);
    const divider = chalk.dim(formatRule("─", { maxWidth }));

    console.log(chalk.bold("SIMILAR"));
    console.log(divider);
    console.log(chalk.dim(`Query: ${result.query}`));
    console.log((result.mode === "semantic" ? chalk.green : chalk.yellow)(modeMessage));
    console.log("");

    if (result.results.length === 0) {
      console.log(chalk.gray("No matches found."));
      console.log(chalk.gray(`${formatTipPrefix()}Try lowering the threshold: ${getCliName()} similar "<query>" --threshold 0.5`));
      return;
    }

    console.log(chalk.bold(`Matches (${result.results.length})`));
    console.log(divider);
    console.log("");

    for (let i = 0; i < result.results.length; i++) {
      const r = result.results[i];
      const sim = r.similarity.toFixed(2);
      const score = r.effectiveScore.toFixed(1);
      console.log(
        chalk.bold(`${i + 1}. [${r.id}]`) +
        chalk.dim(` • sim ${sim} • score ${score} • ${r.category}/${r.scope}`)
      );

      const contentWidth = Math.max(24, maxWidth - 4);
      for (const line of wrapText(r.preview, contentWidth)) {
        console.log(`  ${line}`);
      }
      console.log("");
    }

    const cli = getCliName();
    console.log(chalk.gray(`${formatTipPrefix()}Use '${cli} playbook get <id>' to see full details.`));
  } catch (err: any) {
    const message = err?.message || String(err);
    const code =
      message.includes("Query is required") ||
      message.includes("--threshold must be between") ||
      message.includes("--limit must be") ||
      message.includes("Invalid --scope")
        ? ErrorCode.INVALID_INPUT
        : ErrorCode.INTERNAL_ERROR;
    reportError(err instanceof Error ? err : message, {
      code,
      details: { query },
      json: flags.json,
      format: flags.format,
      command,
      startedAtMs,
    });
  }
}
