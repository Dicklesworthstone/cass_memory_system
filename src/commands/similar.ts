import chalk from "chalk";
import { loadConfig } from "../config.js";
import { loadMergedPlaybook, getActiveBullets } from "../playbook.js";
import { findSimilarBulletsSemantic, getSemanticStatus, formatSemanticModeMessage } from "../semantic.js";
import { getEffectiveScore } from "../scoring.js";
import { error as logError, jaccardSimilarity, truncate, getCliName, printJson, printJsonError } from "../utils.js";
import { ErrorCode, PlaybookBullet } from "../types.js";
import { getOutputStyle } from "../output.js";

export type SimilarScope = "global" | "workspace" | "all";

export interface SimilarFlags {
  limit?: number;
  threshold?: number;
  scope?: SimilarScope;
  json?: boolean;
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

function coerceNumber(value: any, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return fallback;
}

export async function generateSimilarResults(
  query: string,
  flags: SimilarFlags = {}
): Promise<SimilarResult> {
  const cleaned = query?.trim();
  if (!cleaned) {
    throw new Error("Query is required");
  }

  const limit = Math.max(1, Math.floor(coerceNumber(flags.limit, 5)));
  const threshold = coerceNumber(flags.threshold, 0.7);

  if (threshold < 0 || threshold > 1) {
    throw new Error("--threshold must be between 0 and 1");
  }

  const scope = flags.scope ?? "all";
  if (!isValidScope(scope)) {
    throw new Error(`Invalid --scope "${String(scope)}" (expected: global|workspace|all)`);
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
    } catch {
      // Caller decides whether to display warnings; we fall back silently here.
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
  try {
    const result = await generateSimilarResults(query, flags);

    if (flags.json) {
      printJson(result);
      return;
    }

    const config = await loadConfig();
    const semanticStatus = getSemanticStatus(config);
    const style = getOutputStyle();
    const modeMessage = formatSemanticModeMessage(result.mode, semanticStatus);

    console.log(chalk.bold(`SIMILAR BULLETS TO: "${result.query}"`));
    console.log("=".repeat(Math.max(10, Math.min(80, result.query.length + 22))));
    console.log("");

    // Show mode with appropriate styling
    if (result.mode === "semantic") {
      const icon = style.emoji ? "🔍 " : "";
      console.log(chalk.green(`${icon}${modeMessage}`));
    } else {
      const icon = style.emoji ? "🔤 " : "";
      console.log(chalk.yellow(`${icon}${modeMessage}`));
    }
    console.log("");

    if (result.results.length === 0) {
      console.log(chalk.gray("No matches found (try lowering --threshold)."));
      return;
    }

    console.log(`Found ${result.results.length} similar bullet(s):`);
    console.log("");

    for (let i = 0; i < result.results.length; i++) {
      const r = result.results[i];
      console.log(
        `${i + 1}. [Similarity: ${r.similarity.toFixed(2)}] ${truncate(r.preview, 80)}`
      );
      console.log(
        `   ID: ${r.id} | Category: ${chalk.cyan(r.category)} | Score: ${r.effectiveScore.toFixed(2)}`
      );
      console.log(`   "${r.preview}"`);
      console.log("");
    }

    const cli = getCliName();
    console.log(`TIP: Use '${cli} playbook get <id>' to see full details`);
  } catch (err: any) {
    const message = err?.message || String(err);
    if (flags.json) {
      const code =
        message.includes("Query is required") ||
        message.includes("--threshold must be between") ||
        message.includes("Invalid --scope")
          ? ErrorCode.INVALID_INPUT
          : ErrorCode.INTERNAL_ERROR;
      printJsonError(message, { code, details: { query } });
    } else {
      logError(message);
    }
    process.exitCode = 1;
  }
}
