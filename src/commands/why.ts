/**
 * why command - Show bullet origin evidence
 *
 * Answers "Why was this rule learned?" by showing original reasoning,
 * source sessions, evidence quotes, and feedback history.
 */
import { loadConfig } from "../config.js";
import { findDiaryBySession, loadDiary, loadAllDiaries } from "../diary.js";
import { loadMergedPlaybook, findBullet } from "../playbook.js";
import { getEffectiveScore } from "../scoring.js";
import { truncate, printJsonResult, reportError, expandPath, getCliName } from "../utils.js";
import { ErrorCode } from "../types.js";
import { PlaybookBullet, DiaryEntry, Config } from "../types.js";
import chalk from "chalk";
import { formatKv, formatRule, formatTipPrefix, getOutputStyle, icon, wrapText } from "../output.js";
import path from "node:path";

export interface WhyFlags {
  verbose?: boolean;
  json?: boolean;
}

interface WhyResult {
  bullet: {
    id: string;
    content: string;
    category: string;
    maturity: string;
    score: number;
    createdAt: string;
    daysAgo: number;
  };
  reasoning: string | null;
  sourceSessions: Array<{
    path: string;
    date: string | null;
    snippet: string | null;
  }>;
  evidence: string[];
  diaryEntries: Array<{
    date: string;
    content: string;
  }>;
  feedbackHistory: Array<{
    type: "helpful" | "harmful";
    timestamp: string;
    sessionPath?: string;
    reason?: string;
    context?: string;
  }>;
  currentStatus: {
    helpfulCount: number;
    harmfulCount: number;
    effectiveness: string;
  };
}

function daysSince(dateStr: string): number {
  const date = new Date(dateStr);
  const now = new Date();
  return Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));
}

function getEffectiveness(score: number, helpfulCount: number): string {
  if (score >= 10 && helpfulCount >= 10) return "Very high";
  if (score >= 5 && helpfulCount >= 5) return "High";
  if (score >= 1) return "Moderate";
  if (score >= 0) return "Low";
  return "Negative";
}

export async function whyCommand(
  bulletId: string,
  flags: WhyFlags = {}
): Promise<void> {
  const startedAtMs = Date.now();
  const command = "why";
  const config = await loadConfig();
  const playbook = await loadMergedPlaybook(config);

  const needle = (bulletId || "").trim();
  if (!needle) {
    reportError("Bullet ID is required", {
      code: ErrorCode.MISSING_REQUIRED,
      details: { missing: "bulletId", usage: "cm why <bulletId>" },
      json: flags.json,
      command,
      startedAtMs,
    });
    return;
  }

  let bullet = findBullet(playbook, needle);
  if (!bullet) {
    const lower = needle.toLowerCase();
    const scored = playbook.bullets
      .map((b) => {
        const idLower = b.id.toLowerCase();
        const score =
          idLower === lower ? 3 : idLower.startsWith(lower) ? 2 : idLower.includes(lower) ? 1 : 0;
        return score > 0 ? { bullet: b, score } : null;
      })
      .filter((x): x is { bullet: PlaybookBullet; score: number } => x !== null);

    if (scored.length === 0) {
      reportError(`Bullet not found: ${needle}`, {
        code: ErrorCode.BULLET_NOT_FOUND,
        details: { bulletId: needle },
        json: flags.json,
        command,
        startedAtMs,
      });
      return;
    }

    const bestScore = Math.max(...scored.map((c) => c.score));
    const best = scored.filter((c) => c.score === bestScore).map((c) => c.bullet);

    if (best.length === 1) {
      bullet = best[0];
    } else {
      const ids = best.map((b) => b.id);
      const sample = ids.slice(0, 8).join(", ");
      reportError(`Ambiguous bullet id: ${needle}`, {
        code: ErrorCode.INVALID_INPUT,
        hint: `Matches: ${sample}${ids.length > 8 ? ` … (+${ids.length - 8} more)` : ""}`,
        details: { bulletId: needle, matchCount: ids.length, matches: ids.slice(0, 50) },
        json: flags.json,
        command,
        startedAtMs,
      });
      return;
    }
  }

  const result = await buildWhyResult(bullet, config, flags.verbose);

  if (flags.json) {
    printJsonResult(command, result, { startedAtMs });
  } else {
    printWhyResult(result, flags.verbose);
  }
}

async function buildWhyResult(
  bullet: PlaybookBullet,
  config: Config,
  verbose?: boolean
): Promise<WhyResult> {
  const score = getEffectiveScore(bullet, config);
  const sourceSessions = bullet.sourceSessions || [];

  // Collect evidence from source sessions
  const sessionDetails: WhyResult["sourceSessions"] = [];
  const diaryDir = path.resolve(expandPath(config.diaryDir));
  for (const sessionPath of sourceSessions.slice(0, verbose ? 10 : 5)) {
    // Look up diaries by session path. If the value is a diary id or direct
    // diary JSON file under diaryDir, load it directly.
    let diary: DiaryEntry | null = null;
    const ref = (sessionPath || "").trim();
    if (ref) {
      const looksLikeId = !ref.includes("/") && !ref.includes("\\");
      if (looksLikeId) {
        diary = await loadDiary(ref, config);
      } else {
        const resolved = path.resolve(expandPath(ref));
        const rel = path.relative(diaryDir, resolved);
        const isDiaryFile =
          resolved.endsWith(".json") && rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
        if (isDiaryFile) {
          diary = await loadDiary(resolved, config);
        }
        if (!diary) {
          diary = await findDiaryBySession(ref, config.diaryDir);
        }
      }
    }

    sessionDetails.push({
      path: sessionPath,
      date: diary?.timestamp?.slice(0, 10) || null,
      snippet: diary?.keyLearnings?.[0] || diary?.accomplishments?.[0] || null
    });
  }

  // Find related diary entries around bullet creation
  const createdAt = new Date(bullet.createdAt);
  const allDiaries = await loadAllDiaries(config.diaryDir, 50);
  const relatedDiaries = allDiaries.filter(d => {
    const diaryDate = new Date(d.timestamp);
    const daysDiff = Math.abs(
      (diaryDate.getTime() - createdAt.getTime()) / (1000 * 60 * 60 * 24)
    );
    return daysDiff <= 7;
  });

  // Extract diary entries that might be related
  const diaryEntries = relatedDiaries.slice(0, 5).map(d => ({
    date: d.timestamp.slice(0, 10),
    content: d.keyLearnings?.[0] || d.accomplishments?.[0] || "Session recorded"
  }));

  // Feedback history
  const feedbackHistory = (bullet.feedbackEvents || [])
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, verbose ? 20 : 8)
    .map(e => ({
      type: e.type,
      timestamp: e.timestamp,
      sessionPath: e.sessionPath,
      reason: e.reason,
      context: e.context
    }));

  // Extract evidence from bullet tags/reasoning
  const evidence: string[] = [];
  if (bullet.reasoning) {
    // Extract quoted phrases from reasoning
    const quotes = bullet.reasoning.match(/"[^"]+"/g) || [];
    evidence.push(...quotes.map(q => q.replace(/"/g, "")));
  }

  return {
    bullet: {
      id: bullet.id,
      content: bullet.content,
      category: bullet.category || "uncategorized",
      maturity: bullet.maturity || "candidate",
      score: Number(score.toFixed(2)),
      createdAt: bullet.createdAt,
      daysAgo: daysSince(bullet.createdAt)
    },
    reasoning: bullet.reasoning || null,
    sourceSessions: sessionDetails,
    evidence,
    diaryEntries,
    feedbackHistory,
    currentStatus: {
      helpfulCount: bullet.helpfulCount || 0,
      harmfulCount: bullet.harmfulCount || 0,
      effectiveness: getEffectiveness(score, bullet.helpfulCount || 0)
    }
  };
}

function printWhyResult(result: WhyResult, verbose?: boolean): void {
  const style = getOutputStyle();
  const cli = getCliName();
  const maxWidth = Math.min(style.width, 84);
  const divider = chalk.dim(formatRule("─", { maxWidth }));
  const wrapWidth = Math.max(24, maxWidth - 4);

  const scoreColor =
    result.bullet.score >= 5 ? chalk.green : result.bullet.score >= 0 ? chalk.white : chalk.red;

  console.log(chalk.bold("WHY"));
  console.log(divider);
  console.log(
    chalk.bold(`[${result.bullet.id}]`) +
      chalk.dim(
        ` ${result.bullet.category} • ${result.bullet.maturity} • score ${scoreColor(
          result.bullet.score.toFixed(1)
        )}`
      )
  );
  console.log("");

  console.log(chalk.bold("Summary"));
  console.log(divider);
  console.log(
    formatKv(
      [
        {
          key: "Created",
          value: `${result.bullet.createdAt.slice(0, 10)} (${result.bullet.daysAgo} days ago)`,
        },
        {
          key: "Feedback",
          value: `${result.currentStatus.helpfulCount} helpful / ${result.currentStatus.harmfulCount} harmful • ${result.currentStatus.effectiveness}`,
        },
      ],
      { indent: "  ", width: maxWidth }
    )
  );
  console.log("");

  console.log(chalk.bold("Rule"));
  console.log(divider);
  for (const line of wrapText(result.bullet.content, wrapWidth)) {
    console.log(`  ${line}`);
  }
  console.log("");

  console.log(chalk.bold("Reasoning"));
  console.log(divider);
  if (result.reasoning) {
    const reasoningText = verbose ? result.reasoning : truncate(result.reasoning, 400);
    for (const line of wrapText(reasoningText, wrapWidth)) {
      console.log(chalk.gray(`  ${line}`));
    }
  } else {
    console.log(chalk.dim("  (No original reasoning recorded)"));
  }
  console.log("");

  console.log(chalk.bold(`Sources (${result.sourceSessions.length})`));
  console.log(divider);
  if (result.sourceSessions.length === 0) {
    console.log(chalk.dim("  (No source sessions recorded)"));
  } else {
    for (let i = 0; i < result.sourceSessions.length; i++) {
      const s = result.sourceSessions[i];
      const pathShort = s.path.split(/[\\/]/).slice(-2).join("/");
      console.log(
        `  ${i + 1}. ${chalk.blue(pathShort)}${s.date ? chalk.dim(` • ${s.date}`) : ""}`
      );
      if (s.snippet) {
        for (const line of wrapText(`"${truncate(s.snippet, 140)}"`, wrapWidth - 2)) {
          console.log(chalk.dim(`     ${line}`));
        }
      }
    }
  }
  console.log("");

  if (result.evidence.length > 0) {
    console.log(chalk.bold("Evidence"));
    console.log(divider);
    for (const e of result.evidence) {
      for (const line of wrapText(`• ${truncate(e, 180)}`, wrapWidth)) {
        console.log(chalk.green(`  ${line}`));
      }
    }
    console.log("");
  }

  if (result.diaryEntries.length > 0) {
    console.log(chalk.bold("Related diary entries"));
    console.log(divider);
    for (const d of result.diaryEntries) {
      for (const line of wrapText(`${d.date}: ${truncate(d.content, 200)}`, wrapWidth)) {
        console.log(chalk.dim(`  ${line}`));
      }
    }
    console.log("");
  }

  if (result.feedbackHistory.length > 0) {
    console.log(
      chalk.bold(
        `Feedback history (${result.currentStatus.helpfulCount} helpful, ${result.currentStatus.harmfulCount} harmful)`
      )
    );
    console.log(divider);

    for (const f of result.feedbackHistory.slice(0, verbose ? 10 : 5)) {
      const badge = f.type === "helpful" ? chalk.green(icon("success")) : chalk.red(icon("failure"));
      const session = f.sessionPath ? ` • ${path.basename(f.sessionPath)}` : "";
      const detail =
        f.type === "harmful"
          ? f.reason && f.context
            ? `${f.reason}: ${truncate(f.context, 80)}`
            : f.reason
              ? f.reason
              : f.context
                ? truncate(f.context, 80)
                : ""
          : f.context
            ? truncate(f.context, 80)
            : "";
      const suffix = detail ? ` • ${detail}` : "";
      console.log(`  ${f.timestamp.slice(0, 10)} ${badge} ${f.type}${session}${suffix}`);
    }
    if (result.feedbackHistory.length > (verbose ? 10 : 5)) {
      console.log(chalk.dim(`  … (${result.feedbackHistory.length - (verbose ? 10 : 5)} more)`));
    }
    console.log("");
  }

  console.log(
    chalk.gray(
      `${formatTipPrefix()}Next: '${cli} playbook get ${result.bullet.id}' or '${cli} mark ${result.bullet.id} --helpful|--harmful --reason \"...\"'`
    )
  );
}
