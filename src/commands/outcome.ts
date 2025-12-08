import chalk from "chalk";
import { loadConfig } from "../config.js";
import { 
  recordOutcome, 
  applyOutcomeFeedback, 
  scoreImplicitFeedback,
  loadOutcomes,
  OutcomeInput,
  OutcomeStatus,
  Sentiment 
} from "../outcome.js";
import { error as logError } from "../utils.js";

// Re-export for backward compat if needed
export { detectSentiment, scoreImplicitFeedback } from "../outcome.js";

// --- Helpers duplicate in outcome.ts now, removing local definitions ---

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

// Keep detection logic exposed if useful, or rely on flags
function detectSentiment(text?: string): Sentiment {
  if (!text) return "neutral";
  const positiveCount = POSITIVE_PATTERNS.filter((p) => p.test(text)).length;
  const negativeCount = NEGATIVE_PATTERNS.filter((p) => p.test(text)).length;
  if (positiveCount > negativeCount) return "positive";
  if (negativeCount > positiveCount) return "negative";
  return "neutral";
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
  
  // 1. Construct OutcomeInput
  const ruleIds = flags.rules.split(",").map((r) => r.trim()).filter(Boolean);
  
  const input: OutcomeInput = {
    sessionId: flags.session || "cli-manual",
    outcome: status,
    rulesUsed: ruleIds,
    durationSec: flags.duration,
    errorCount: flags.errors,
    hadRetries: flags.retries,
    sentiment,
    notes: flags.text
  };

  // 2. Preview Score (User Feedback)
  const scored = scoreImplicitFeedback(input);
  if (!scored) {
    console.error(chalk.yellow("No implicit signal strong enough to record feedback."));
    process.exit(0);
  }

  const config = await loadConfig();

  // 3. Record (Log)
  try {
    await recordOutcome(input, config);
  } catch (err: any) {
    logError(`Failed to log outcome: ${err.message}`);
    // Continue to apply feedback even if logging fails? Probably yes.
  }

  // 4. Apply Feedback (Learn)
  // Create a temporary record-like object to pass to applyOutcomeFeedback
  // We can just use input + timestamp, applyOutcomeFeedback expects OutcomeRecord array
  const tempRecord = {
    ...input,
    recordedAt: new Date().toISOString(),
    path: "cli-transient" 
  };

  const result = await applyOutcomeFeedback([tempRecord], config);

  // 5. Report
  const payload = {
    success: true,
    applied: result.applied,
    missing: result.missing,
    type: scored.type,
    weight: scored.decayedValue,
    sentiment,
  };

  if (flags.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (result.applied > 0) {
    console.log(
      chalk.green(
        `✓ Recorded implicit ${scored.type} feedback (${scored.decayedValue.toFixed(2)}) for ${result.applied} rule(s)`
      )
    );
  }

  if (result.missing.length > 0) {
    console.log(chalk.yellow(`Skipped missing rules: ${result.missing.join(", ")}`));
  }
}

export async function applyOutcomeLogCommand(flags: { session?: string; limit?: number; json?: boolean }) {
  const config = await loadConfig();
  const outcomes = await loadOutcomes(config, flags.limit ?? 50);

  if (flags.session) {
    const filtered = outcomes.filter((o) => o.sessionId === flags.session);
    if (filtered.length === 0) {
      console.error(chalk.yellow(`No outcomes found for session ${flags.session}`));
      process.exit(0);
    }
    const result = await applyOutcomeFeedback(filtered, config);
    if (flags.json) {
      console.log(JSON.stringify({ ...result, session: flags.session }, null, 2));
      return;
    }
    console.log(chalk.green(`Applied outcome feedback for session ${flags.session}: ${result.applied} updates`));
    if (result.missing.length > 0) {
      console.log(chalk.yellow(`Missing rules: ${result.missing.join(", ")}`));
    }
    return;
  }

  // No session filter: apply latest (limit) outcomes.
  const result = await applyOutcomeFeedback(outcomes, config);
  if (flags.json) {
    console.log(JSON.stringify({ ...result, totalOutcomes: outcomes.length }, null, 2));
    return;
  }
  console.log(chalk.green(`Applied outcome feedback for ${outcomes.length} outcomes: ${result.applied} updates`));
  if (result.missing.length > 0) {
    console.log(chalk.yellow(`Missing rules: ${result.missing.join(", ")}`));
  }
}