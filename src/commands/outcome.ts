import chalk from "chalk";
import { loadConfig } from "../config.js";
import {
  recordOutcome,
  applyOutcomeFeedback,
  scoreImplicitFeedback,
  loadOutcomes,
  detectSentiment,
  OutcomeInput,
  OutcomeStatus,
  Sentiment
} from "../outcome.js";
import { error as logError, printJsonResult } from "../utils.js";
import { icon } from "../output.js";

// Re-export for backward compat if needed
export { scoreImplicitFeedback, detectSentiment } from "../outcome.js";

export async function outcomeCommand(
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
    console.error(chalk.red("Outcome status is required (usage: cm outcome <status> <rules>)"));
    process.exit(1);
  }
  if (!flags.rules) {
    console.error(chalk.red("At least one rule id is required (usage: cm outcome <status> <rules>)"));
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
    if (flags.json) {
      printJsonResult(
        { feedbackRecorded: false, rulesProvided: ruleIds },
        { effect: false, reason: "No implicit signal strong enough to record feedback" }
      );
      return;
    }
    console.error(chalk.yellow("No implicit signal strong enough to record feedback."));
    return;
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
  if (flags.json) {
    printJsonResult({
      applied: result.applied,
      missing: result.missing,
      type: scored.type,
      weight: scored.decayedValue,
      sentiment,
    });
    return;
  }

  if (result.applied > 0) {
    console.log(
      chalk.green(
        `${icon("success")} Recorded implicit ${scored.type} feedback (${scored.decayedValue.toFixed(2)}) for ${result.applied} rule(s)`
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
      if (flags.json) {
        printJsonResult(
          { session: flags.session, outcomesFound: 0, applied: 0, missing: [] },
          { effect: false, reason: `No outcomes found for session ${flags.session}` }
        );
        return;
      }
      console.error(chalk.yellow(`No outcomes found for session ${flags.session}`));
      return;
    }
    const result = await applyOutcomeFeedback(filtered, config);
    if (flags.json) {
      printJsonResult({ ...result, session: flags.session });
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
    printJsonResult({ ...result, totalOutcomes: outcomes.length });
    return;
  }
  console.log(chalk.green(`Applied outcome feedback for ${outcomes.length} outcomes: ${result.applied} updates`));
  if (result.missing.length > 0) {
    console.log(chalk.yellow(`Missing rules: ${result.missing.join(", ")}`));
  }
}
