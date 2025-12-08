import chalk from "chalk";
import { loadConfig } from "../config.js";
import { loadPlaybook, savePlaybook, findBullet } from "../playbook.js";
import { calculateMaturityState, getEffectiveScore } from "../scoring.js";
import { now, expandPath, fileExists } from "../utils.js";
import { FeedbackEvent, PlaybookBullet } from "../types.js";
import { withLock } from "../lock.js";

type OutcomeStatus = "success" | "failure" | "mixed";
type Sentiment = "positive" | "negative" | "neutral";

const FAST_THRESHOLD_SECONDS = 600; // 10 minutes
const SLOW_THRESHOLD_SECONDS = 3600; // 1 hour

const POSITIVE_PATTERNS = [
  /that worked/i,
  /perfect/i,
  /thanks/i,
  /great/i,
  /exactly what i needed/i,
  /solved it/i,
];

const NEGATIVE_PATTERNS = [
  /that('s| is) wrong/i,
  /doesn't work/i,
  /broke/i,
  /not what i wanted/i,
  /try again/i,
  /undo/i,
];

export function detectSentiment(text?: string): Sentiment {
  if (!text) return "neutral";
  const positiveCount = POSITIVE_PATTERNS.filter((p) => p.test(text)).length;
  const negativeCount = NEGATIVE_PATTERNS.filter((p) => p.test(text)).length;
  if (positiveCount > negativeCount) return "positive";
  if (negativeCount > positiveCount) return "negative";
  return "neutral";
}

type OutcomeSignals = {
  status: OutcomeStatus;
  durationSeconds?: number;
  errorCount?: number;
  hadRetries?: boolean;
  sentiment?: Sentiment;
};

export function scoreImplicitFeedback(signals: OutcomeSignals): {
  type: "helpful" | "harmful";
  decayedValue: number;
  context: string;
} | null {
  let helpfulScore = 0;
  let harmfulScore = 0;
  const reasons: string[] = [];

  if (signals.status === "success") {
    helpfulScore += 1;
    reasons.push("success");
  } else if (signals.status === "failure") {
    harmfulScore += 1;
    reasons.push("failure");
  } else {
    // mixed
    helpfulScore += 0.1;
    harmfulScore += 0.1;
    reasons.push("mixed");
  }

  if (typeof signals.durationSeconds === "number") {
    if (signals.durationSeconds > 0 && signals.durationSeconds < FAST_THRESHOLD_SECONDS && signals.status !== "failure") {
      helpfulScore += 0.5;
      reasons.push("fast");
    } else if (signals.durationSeconds > SLOW_THRESHOLD_SECONDS) {
      harmfulScore += 0.3;
      reasons.push("slow");
    }
  }

  if (typeof signals.errorCount === "number") {
    if (signals.errorCount >= 2) {
      harmfulScore += 0.7;
      reasons.push("errors>=2");
    } else if (signals.errorCount === 1) {
      harmfulScore += 0.3;
      reasons.push("error");
    }
  }

  if (signals.hadRetries) {
    harmfulScore += 0.5;
    reasons.push("retries");
  }

  if (signals.sentiment === "positive") {
    helpfulScore += 0.3;
    reasons.push("sentiment+");
  } else if (signals.sentiment === "negative") {
    harmfulScore += 0.5;
    reasons.push("sentiment-");
  }

  const helpfulFinal = Math.max(0, helpfulScore);
  const harmfulFinal = Math.max(0, harmfulScore);

  if (helpfulFinal === 0 && harmfulFinal === 0) return null;

  if (helpfulFinal >= harmfulFinal) {
    return {
      type: "helpful",
      decayedValue: Math.min(2, Math.max(0.1, helpfulFinal)),
      context: reasons.join(", "),
    };
  }

  return {
    type: "harmful",
    decayedValue: Math.min(2, Math.max(0.1, harmfulFinal)),
    context: reasons.join(", "),
  };
}

async function resolveTargetPath(bulletId: string, globalPath: string, repoPath: string): Promise<string | null> {
  if (await fileExists(repoPath)) {
    try {
      const repoPlaybook = await loadPlaybook(repoPath);
      if (findBullet(repoPlaybook, bulletId)) {
        return repoPath;
      }
    } catch {
      // fall back to global
    }
  }
  if (await fileExists(globalPath)) {
    const globalPlaybook = await loadPlaybook(globalPath);
    if (findBullet(globalPlaybook, bulletId)) return globalPath;
  }
  return null;
}

export async function outcomeCommand(
  _task: string | undefined,
  flags: {
    session?: string;
    status?: string;
    rules?: string;
    duration?: number;
    errors?: number;
    retries?: boolean;
    sentiment?: string;
    text?: string;
    json?: boolean;
  }
) {
  if (!flags.status) {
    console.error(chalk.red("Outcome status is required (--status success|failure|mixed)"));
    process.exit(1);
  }
  if (!flags.rules) {
    console.error(chalk.red("At least one rule id is required (--rules <id1,id2,....>)"));
    process.exit(1);
  }

  const status = flags.status as OutcomeStatus;
  if (!["success", "failure", "mixed"].includes(status)) {
    console.error(chalk.red("Status must be one of success|failure|mixed"));
    process.exit(1);
  }

  const sentiment = flags.sentiment ? (flags.sentiment as Sentiment) : detectSentiment(flags.text);
  const signals: OutcomeSignals = {
    status,
    durationSeconds: flags.duration,
    errorCount: flags.errors,
    hadRetries: flags.retries,
    sentiment,
  };

  const scored = scoreImplicitFeedback(signals);
  if (!scored) {
    console.error(chalk.yellow("No implicit signal strong enough to record feedback."));
    process.exit(0);
  }

  const config = await loadConfig();
  const globalPath = expandPath(config.playbookPath);
  const repoPath = expandPath(".cass/playbook.yaml");

  const ruleIds = flags.rules
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);

  // Group rules by target path to minimize locking/IO
  const updatesByPath: Record<string, string[]> = {};
  
  for (const ruleId of ruleIds) {
    const targetPath = await resolveTargetPath(ruleId, globalPath, repoPath);
    if (!targetPath) {
      missing.push(ruleId);
      continue;
    }
    if (!updatesByPath[targetPath]) {
      updatesByPath[targetPath] = [];
    }
    updatesByPath[targetPath].push(ruleId);
  }

  // Process each playbook file once
  for (const [targetPath, batchRuleIds] of Object.entries(updatesByPath)) {
    await withLock(targetPath, async () => {
      const playbook = await loadPlaybook(targetPath);
      let modified = false;

      for (const ruleId of batchRuleIds) {
        const bullet = findBullet(playbook, ruleId);
        if (!bullet) {
          // Should not happen given resolveTargetPath check, but safe guard
          missing.push(ruleId);
          continue;
        }

        const event: FeedbackEvent = {
          type: scored.type,
          timestamp: now(),
          sessionPath: flags.session,
          reason: scored.type === "harmful" ? "other" : undefined,
          context: scored.context || undefined,
          decayedValue: scored.decayedValue,
        };

        bullet.feedbackEvents = bullet.feedbackEvents || [];
        bullet.feedbackEvents.push(event);
        bullet.updatedAt = now();
        bullet.maturity = calculateMaturityState(bullet, config);
        modified = true;

        const effectiveScore = getEffectiveScore(bullet, config);
        recorded.push({ id: ruleId, target: targetPath, score: effectiveScore, type: scored.type });
      }

      if (modified) {
        await savePlaybook(playbook, targetPath);
      }
    });
  }

  const payload = {
    success: true,
    recorded,
    missing,
    type: scored.type,
    weight: scored.decayedValue,
    sentiment,
  };

  if (flags.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (recorded.length > 0) {
    console.log(
      chalk.green(
        `✓ Recorded implicit ${scored.type} feedback (${scored.decayedValue.toFixed(2)}) for ${recorded.length} rule(s)`
      )
    );
    recorded.forEach((r) => {
      console.log(
        `  - ${r.id} (${r.type}) → ${chalk.gray(r.target)} (score now ${r.score.toFixed(2)})`
      );
    });
  }

  if (missing.length > 0) {
    console.log(chalk.yellow(`Skipped missing rules: ${missing.join(", ")}`));
  }
}

