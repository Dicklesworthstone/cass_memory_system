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
import { truncate, printJson, printJsonResult } from "../utils.js";
import { PlaybookBullet, DiaryEntry, Config } from "../types.js";
import chalk from "chalk";
import { icon } from "../output.js";

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
  const config = await loadConfig();
  const playbook = await loadMergedPlaybook(config);

  const bullet = findBullet(playbook, bulletId);
  if (!bullet) {
    if (flags.json) {
      printJson({ success: false, error: `Bullet not found: ${bulletId}` });
    } else {
      console.error(chalk.red(`Error: Bullet not found: ${bulletId}`));
    }
    process.exit(1);
  }

  const result = await buildWhyResult(bullet, config, flags.verbose);

  if (flags.json) {
    printJsonResult({ ...result });
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
  for (const sessionPath of sourceSessions.slice(0, verbose ? 10 : 5)) {
    // Only look up diary for actual file paths, not synthetic identifiers
    let diary: DiaryEntry | null = null;
    if (sessionPath) {
      if (sessionPath.endsWith(".json") || sessionPath.endsWith(".jsonl")) {
        // It's a direct file path to a diary
        diary = await loadDiary(sessionPath, config);
      } else {
        // It's a session path (e.g. from IDE), try to find corresponding diary
        diary = await findDiaryBySession(sessionPath, config.diaryDir);
      }
    } else {
      // Find latest diary
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
      reason: e.reason
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
  console.log(chalk.bold("\nWHY WAS THIS RULE LEARNED?"));
  console.log(chalk.gray("═".repeat(50)));
  console.log();

  // Bullet info
  console.log(chalk.bold(`Bullet: ${result.bullet.id}`));
  console.log(`Content: ${chalk.cyan(`"${result.bullet.content}"`)}`);
  console.log(chalk.gray(`Category: ${result.bullet.category} | Maturity: ${result.bullet.maturity}`));
  console.log(chalk.gray(`Created: ${result.bullet.createdAt.slice(0, 10)} (${result.bullet.daysAgo} days ago)`));
  console.log();

  // Reasoning
  if (result.reasoning) {
    console.log(chalk.bold("ORIGINAL REASONING:"));
    console.log(chalk.gray("─".repeat(40)));
    const reasoningText = verbose ? result.reasoning : truncate(result.reasoning, 300);
    console.log(`  ${reasoningText}`);
    console.log();
  } else {
    console.log(chalk.yellow("No original reasoning recorded"));
    console.log();
  }

  // Source sessions
  if (result.sourceSessions.length > 0) {
    console.log(chalk.bold(`SOURCE SESSIONS (${result.sourceSessions.length}):`));
    console.log(chalk.gray("─".repeat(40)));
    for (let i = 0; i < result.sourceSessions.length; i++) {
      const s = result.sourceSessions[i];
      const pathShort = s.path.split("/").slice(-2).join("/");
      console.log(`  ${i + 1}. ${chalk.blue(pathShort)}${s.date ? ` (${s.date})` : ""}`);
      if (s.snippet) {
        console.log(chalk.gray(`     "${truncate(s.snippet, 60)}"`));
      }
    }
    console.log();
  } else {
    console.log(chalk.gray("No source sessions recorded"));
    console.log();
  }

  // Evidence
  if (result.evidence.length > 0) {
    console.log(chalk.bold("KEY EVIDENCE QUOTES:"));
    console.log(chalk.gray("─".repeat(40)));
    for (const e of result.evidence) {
      console.log(chalk.green(`  • "${truncate(e, 70)}"`));
    }
    console.log();
  }

  // Diary entries
  if (result.diaryEntries.length > 0) {
    console.log(chalk.bold("RELATED DIARY ENTRIES:"));
    console.log(chalk.gray("─".repeat(40)));
    for (const d of result.diaryEntries) {
      console.log(`  ${d.date}: ${chalk.gray(truncate(d.content, 60))}`);
    }
    console.log();
  }

  // Feedback history
  const { helpfulCount, harmfulCount } = result.currentStatus;
  if (result.feedbackHistory.length > 0) {
    console.log(chalk.bold(`FEEDBACK HISTORY (${helpfulCount} helpful, ${harmfulCount} harmful):`));
    console.log(chalk.gray("─".repeat(40)));
    for (const f of result.feedbackHistory.slice(0, verbose ? 10 : 5)) {
      const feedbackIcon = f.type === "helpful" ? chalk.green(icon("success")) : chalk.red(icon("failure"));
      console.log(`  ${f.timestamp.slice(0, 10)}: ${feedbackIcon} ${f.type}${f.sessionPath ? ` (${f.sessionPath.split("/").pop()})` : ""}`);
    }
    if (result.feedbackHistory.length > (verbose ? 10 : 5)) {
      console.log(chalk.gray(`  ... (${result.feedbackHistory.length - (verbose ? 10 : 5)} more)`));
    }
    console.log();
  }

  // Current status
  console.log(chalk.bold("CURRENT STATUS:"));
  console.log(chalk.gray("─".repeat(40)));
  const scoreColor = result.bullet.score >= 5 ? chalk.green : result.bullet.score >= 0 ? chalk.white : chalk.red;
  console.log(`  Score: ${scoreColor(result.bullet.score.toFixed(1))} (${result.bullet.maturity})`);
  console.log(`  Effectiveness: ${result.currentStatus.effectiveness}`);
  console.log();
}
