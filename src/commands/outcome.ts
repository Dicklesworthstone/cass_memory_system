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
import {
  error as logError,
  getCliName,
  printJsonResult,
  reportError,
  validateNonEmptyString,
  validateOneOf,
  validatePositiveInt,
} from "../utils.js";
import { ErrorCode } from "../types.js";
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
  const startedAtMs = Date.now();
  const command = "outcome";
  const cli = getCliName();

  const statusCheck = validateOneOf(flags.status, "status", ["success", "failure", "mixed", "partial"] as const, {
    caseInsensitive: true,
  });
  if (!statusCheck.ok) {
    reportError(statusCheck.message, {
      code: ErrorCode.INVALID_INPUT,
      details: statusCheck.details,
      hint: `Example: ${cli} outcome success b-abc123 --json`,
      json: flags.json,
      command,
      startedAtMs,
    });
    return;
  }

  const rulesCheck = validateNonEmptyString(flags.rules, "rules", { trim: true });
  if (!rulesCheck.ok) {
    reportError(rulesCheck.message, {
      code: ErrorCode.MISSING_REQUIRED,
      details: rulesCheck.details,
      hint: `Example: ${cli} outcome success b-abc123,b-def456 --json`,
      json: flags.json,
      command,
      startedAtMs,
    });
    return;
  }

  const sessionCheck = validateNonEmptyString(flags.session, "session", { allowUndefined: true });
  if (!sessionCheck.ok) {
    reportError(sessionCheck.message, {
      code: ErrorCode.INVALID_INPUT,
      details: sessionCheck.details,
      hint: `Example: ${cli} outcome success b-abc123 --session /path/to/session.jsonl --json`,
      json: flags.json,
      command,
      startedAtMs,
    });
    return;
  }

  const durationCheck = validatePositiveInt(flags.duration, "duration", { min: 0, allowUndefined: true });
  if (!durationCheck.ok) {
    reportError(durationCheck.message, {
      code: ErrorCode.INVALID_INPUT,
      details: durationCheck.details,
      hint: `Example: ${cli} outcome success b-abc123 --duration 600 --json`,
      json: flags.json,
      command,
      startedAtMs,
    });
    return;
  }

  const errorsCheck = validatePositiveInt(flags.errors, "errors", { min: 0, allowUndefined: true });
  if (!errorsCheck.ok) {
    reportError(errorsCheck.message, {
      code: ErrorCode.INVALID_INPUT,
      details: errorsCheck.details,
      hint: `Example: ${cli} outcome failure b-abc123 --errors 3 --json`,
      json: flags.json,
      command,
      startedAtMs,
    });
    return;
  }

  const sentimentCheck = validateOneOf(flags.sentiment, "sentiment", ["positive", "negative", "neutral"] as const, {
    allowUndefined: true,
    caseInsensitive: true,
  });
  if (!sentimentCheck.ok) {
    reportError(sentimentCheck.message, {
      code: ErrorCode.INVALID_INPUT,
      details: sentimentCheck.details,
      hint: `Valid sentiments: positive, negative, neutral`,
      json: flags.json,
      command,
      startedAtMs,
    });
    return;
  }

  const textCheck = validateNonEmptyString(flags.text, "text", { allowUndefined: true });
  if (!textCheck.ok) {
    reportError(textCheck.message, {
      code: ErrorCode.INVALID_INPUT,
      details: textCheck.details,
      hint: `Example: ${cli} outcome mixed b-abc123 --text \"kept timing out\" --json`,
      json: flags.json,
      command,
      startedAtMs,
    });
    return;
  }

  const status = statusCheck.value as OutcomeStatus;

  const sentiment =
    sentimentCheck.value !== undefined
      ? (sentimentCheck.value as Sentiment)
      : detectSentiment(textCheck.value);

  // 1. Construct OutcomeInput
  const ruleIds = rulesCheck.value.split(",").map((r) => r.trim()).filter(Boolean);
  if (ruleIds.length === 0) {
    reportError("At least one rule id is required.", {
      code: ErrorCode.MISSING_REQUIRED,
      details: { field: "rules", received: rulesCheck.value },
      hint: `Example: ${cli} outcome success b-abc123,b-def456 --json`,
      json: flags.json,
      command,
      startedAtMs,
    });
    return;
  }
  
  const input: OutcomeInput = {
    sessionId: sessionCheck.value ?? "cli-manual",
    outcome: status,
    rulesUsed: ruleIds,
    durationSec: durationCheck.value,
    errorCount: errorsCheck.value,
    hadRetries: flags.retries,
    sentiment,
    notes: textCheck.value
  };

  // 2. Preview Score (User Feedback)
  const scored = scoreImplicitFeedback(input);
  if (!scored) {
    if (flags.json) {
      printJsonResult(
        command,
        { feedbackRecorded: false, rulesProvided: ruleIds },
        { effect: false, reason: "No implicit signal strong enough to record feedback", startedAtMs }
      );
      return;
    }
    console.error(chalk.yellow("No implicit signal strong enough to record feedback."));
    return;
  }

  const config = await loadConfig();

  // 3. Record (Log)
  let recordedOutcome: Awaited<ReturnType<typeof recordOutcome>> | null = null;
  try {
    recordedOutcome = await recordOutcome(input, config);
  } catch (err: any) {
    logError(`Failed to log outcome: ${err.message}`);
    // Continue to apply feedback even if logging fails? Probably yes.
  }

  // 4. Apply Feedback (Learn)
  // Prefer the persisted record so outcome-apply can be idempotent across replays.
  // If logging failed, fall back to an in-memory record.
  const recordForApply =
    recordedOutcome ??
    ({
      ...input,
      recordedAt: new Date().toISOString(),
      path: "cli-transient",
    } as any);

  const result = await applyOutcomeFeedback([recordForApply], config);

  // 5. Report
  if (flags.json) {
    printJsonResult(
      command,
      {
        applied: result.applied,
        missing: result.missing,
        type: scored.type,
        weight: scored.decayedValue,
        sentiment,
      },
      { startedAtMs }
    );
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
  const startedAtMs = Date.now();
  const command = "outcome-apply";
  const cli = getCliName();

  const sessionCheck = validateNonEmptyString(flags.session, "session", { allowUndefined: true });
  if (!sessionCheck.ok) {
    reportError(sessionCheck.message, {
      code: ErrorCode.INVALID_INPUT,
      details: sessionCheck.details,
      hint: `Example: ${cli} outcome-apply --session my-session-id --json`,
      json: flags.json,
      command,
      startedAtMs,
    });
    return;
  }

  const limitCheck = validatePositiveInt(flags.limit, "limit", { min: 1, allowUndefined: true });
  if (!limitCheck.ok) {
    reportError(limitCheck.message, {
      code: ErrorCode.INVALID_INPUT,
      details: limitCheck.details,
      hint: `Example: ${cli} outcome-apply --limit 100 --json`,
      json: flags.json,
      command,
      startedAtMs,
    });
    return;
  }

  const config = await loadConfig();
  const outcomes = await loadOutcomes(config, limitCheck.value ?? 50);

  if (sessionCheck.value !== undefined) {
    const filtered = outcomes.filter((o) => o.sessionId === sessionCheck.value);
    if (filtered.length === 0) {
      if (flags.json) {
        printJsonResult(
          command,
          { session: sessionCheck.value, outcomesFound: 0, applied: 0, missing: [] },
          { effect: false, reason: `No outcomes found for session ${sessionCheck.value}`, startedAtMs }
        );
        return;
      }
      console.error(chalk.yellow(`No outcomes found for session ${sessionCheck.value}`));
      return;
    }
    const result = await applyOutcomeFeedback(filtered, config);
    if (flags.json) {
      printJsonResult(command, { ...result, session: sessionCheck.value }, { startedAtMs });
      return;
    }
    console.log(chalk.green(`Applied outcome feedback for session ${sessionCheck.value}: ${result.applied} updates`));
    if (result.missing.length > 0) {
      console.log(chalk.yellow(`Missing rules: ${result.missing.join(", ")}`));
    }
    return;
  }

  // No session filter: apply latest (limit) outcomes.
  const result = await applyOutcomeFeedback(outcomes, config);
  if (flags.json) {
    printJsonResult(command, { ...result, totalOutcomes: outcomes.length }, { startedAtMs });
    return;
  }
  console.log(chalk.green(`Applied outcome feedback for ${outcomes.length} outcomes: ${result.applied} updates`));
  if (result.missing.length > 0) {
    console.log(chalk.yellow(`Missing rules: ${result.missing.join(", ")}`));
  }
}
