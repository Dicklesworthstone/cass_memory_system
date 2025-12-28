import { loadConfig } from "../config.js";
import { orchestrateReflection } from "../orchestrator.js";
import { getUsageStats, formatCostSummary } from "../cost.js";
import chalk from "chalk";
import {
  getCliName,
  printJson,
  printJsonResult,
  reportError,
  validateNonEmptyString,
  validatePositiveInt,
} from "../utils.js";
import { formatKv, formatRule, getOutputStyle, iconPrefix, icon, wrapText } from "../output.js";
import { createProgress, type ProgressReporter } from "../progress.js";
import { ErrorCode, type PlaybookDelta } from "../types.js";

type DeltaType = PlaybookDelta["type"];

function summarizeDeltas(deltas: PlaybookDelta[]): Record<DeltaType, number> {
  const counts: Record<DeltaType, number> = {
    add: 0,
    helpful: 0,
    harmful: 0,
    replace: 0,
    deprecate: 0,
    merge: 0,
  };

  for (const d of deltas) {
    counts[d.type] = (counts[d.type] ?? 0) + 1;
  }

  return counts;
}

function formatDeltaLine(delta: PlaybookDelta): string {
  switch (delta.type) {
    case "add":
      return `ADD  [${delta.bullet.category}] ${delta.bullet.content}`;
    case "replace":
      return `REPLACE  ${delta.bulletId} → ${delta.newContent}`;
    case "deprecate":
      return `DEPRECATE  ${delta.bulletId} (${delta.reason})`;
    case "helpful":
      return `HELPFUL  ${delta.bulletId}`;
    case "harmful":
      return `HARMFUL  ${delta.bulletId}${delta.reason ? ` (${delta.reason})` : ""}`;
    case "merge":
      return `MERGE  ${delta.bulletIds.join(", ")} → ${delta.mergedContent}`;
  }
}

// Internal exports for unit tests (kept small to avoid expanding public API surface).
export const __test = {
  summarizeDeltas,
  formatDeltaLine,
};

export async function reflectCommand(
  options: {
    days?: number;
    maxSessions?: number;
    agent?: string;
    workspace?: string;
    dryRun?: boolean;
    json?: boolean;
    llm?: boolean; // Ignored, always uses LLM if validation enabled
    session?: string;
  } = {}
): Promise<void> {
  const startedAtMs = Date.now();
  const command = "reflect";
  const cli = getCliName();

  const daysCheck = validatePositiveInt(options.days, "days", { min: 1, allowUndefined: true });
  if (!daysCheck.ok) {
    reportError(daysCheck.message, {
      code: ErrorCode.INVALID_INPUT,
      details: daysCheck.details,
      hint: `Example: ${cli} reflect --days 7 --json`,
      json: options.json,
      command,
      startedAtMs,
    });
    return;
  }

  const maxSessionsCheck = validatePositiveInt(options.maxSessions, "max-sessions", { min: 1, allowUndefined: true });
  if (!maxSessionsCheck.ok) {
    reportError(maxSessionsCheck.message, {
      code: ErrorCode.INVALID_INPUT,
      details: maxSessionsCheck.details,
      hint: `Example: ${cli} reflect --max-sessions 50 --json`,
      json: options.json,
      command,
      startedAtMs,
    });
    return;
  }

  const agentCheck = validateNonEmptyString(options.agent, "agent", { allowUndefined: true });
  if (!agentCheck.ok) {
    reportError(agentCheck.message, {
      code: ErrorCode.INVALID_INPUT,
      details: agentCheck.details,
      hint: `Example: ${cli} reflect --agent claude --json`,
      json: options.json,
      command,
      startedAtMs,
    });
    return;
  }

  const workspaceCheck = validateNonEmptyString(options.workspace, "workspace", { allowUndefined: true });
  if (!workspaceCheck.ok) {
    reportError(workspaceCheck.message, {
      code: ErrorCode.INVALID_INPUT,
      details: workspaceCheck.details,
      hint: `Example: ${cli} reflect --workspace . --json`,
      json: options.json,
      command,
      startedAtMs,
    });
    return;
  }

  const sessionCheck = validateNonEmptyString(options.session, "session", { allowUndefined: true });
  if (!sessionCheck.ok) {
    reportError(sessionCheck.message, {
      code: ErrorCode.INVALID_INPUT,
      details: sessionCheck.details,
      hint: `Example: ${cli} reflect --session <id> --json`,
      json: options.json,
      command,
      startedAtMs,
    });
    return;
  }

  const normalizedOptions = {
    ...options,
    ...(daysCheck.value !== undefined ? { days: daysCheck.value } : {}),
    ...(maxSessionsCheck.value !== undefined ? { maxSessions: maxSessionsCheck.value } : {}),
    ...(agentCheck.value !== undefined ? { agent: agentCheck.value } : {}),
    ...(workspaceCheck.value !== undefined ? { workspace: workspaceCheck.value } : {}),
    ...(sessionCheck.value !== undefined ? { session: sessionCheck.value } : {}),
  };

  const config = await loadConfig();
  const statsBefore = await getUsageStats(config);

  const maxWidth = Math.min(getOutputStyle().width, 84);
  const divider = chalk.dim(formatRule("─", { maxWidth }));

  if (!normalizedOptions.json) {
    console.log(chalk.bold("REFLECT"));
    console.log(divider);
    console.log(chalk.dim(`Workspace: ${normalizedOptions.workspace || "global"}`));
    if (normalizedOptions.session) console.log(chalk.dim(`Session: ${normalizedOptions.session}`));
    if (normalizedOptions.dryRun) console.log(chalk.dim("Mode: dry-run (no changes will be written)"));
    console.log("");
  }

  const progressRef: { current: ProgressReporter | null } = { current: null };

  const result = await orchestrateReflection(config, {
    days: normalizedOptions.days,
    maxSessions: normalizedOptions.maxSessions,
    agent: normalizedOptions.agent,
    workspace: normalizedOptions.workspace,
    session: normalizedOptions.session,
    dryRun: normalizedOptions.dryRun,
    onProgress: (event) => {
      if (normalizedOptions.json) {
        if (event.phase === "discovery") {
          const total = event.totalSessions ?? 0;
          progressRef.current = createProgress({
            message: "Processing sessions...",
            total,
            showEta: true,
            format: "json",
            stream: process.stderr,
          });
          progressRef.current.update(0, `Found ${total} new session(s) to process.`);
          if (total === 0) {
            progressRef.current.complete("No new sessions to process");
            progressRef.current = null;
          }
          return;
        }

        if (!progressRef.current) return;

        if (event.phase === "session_skip") {
          progressRef.current.update(event.index, `Skipped (${event.reason})`);
          return;
        }
        if (event.phase === "session_done") {
          const suffix = event.deltasGenerated > 0 ? ` (${event.deltasGenerated} deltas)` : "";
          progressRef.current.update(event.index, `Processed${suffix}`);
          return;
        }
        if (event.phase === "session_error") {
          progressRef.current.update(event.index, `Error: ${event.error}`);
        }
        return;
      }

      if (event.phase === "discovery") {
        console.log(chalk.dim(`Found ${event.totalSessions} new session(s) to process.`));
        return;
      }
      if (event.phase === "session_skip") {
        console.log(chalk.dim(`• [${event.index}/${event.totalSessions}] skipped (${event.reason})`));
        return;
      }
      if (event.phase === "session_done") {
        const suffix = event.deltasGenerated > 0 ? ` (${event.deltasGenerated} deltas)` : "";
        console.log(chalk.dim(`${icon("success")} [${event.index}/${event.totalSessions}] processed${suffix}`));
        return;
      }
      if (event.phase === "session_error") {
        console.error(chalk.yellow(`${iconPrefix("warning")}[${event.index}/${event.totalSessions}] ${event.error}`));
      }
    },
  });

  if (result.errors.length > 0 && !normalizedOptions.json) {
    console.error(chalk.yellow.bold(`${iconPrefix("warning")}Errors (${result.errors.length})`));
    const shown = Math.min(5, result.errors.length);
    result.errors.slice(0, shown).forEach((e) => console.error(chalk.yellow(`- ${e}`)));
    if (result.errors.length > shown) {
      console.error(chalk.yellow(`- … and ${result.errors.length - shown} more`));
    }
    console.error("");
  }

  if (normalizedOptions.json && progressRef.current) {
    progressRef.current.complete("Reflection complete");
    progressRef.current = null;
  }

  if (normalizedOptions.dryRun) {
    if (normalizedOptions.json) {
      printJsonResult(command, { deltas: result.dryRunDeltas }, { startedAtMs });
    } else {
      const deltas = result.dryRunDeltas || [];
      const byType = summarizeDeltas(deltas);

      console.log(chalk.bold(`${iconPrefix("note")}DRY RUN`));
      console.log(divider);
      console.log(
        formatKv(
          [
            { key: "Sessions processed", value: String(result.sessionsProcessed) },
            { key: "Proposed changes", value: String(deltas.length) },
          ],
          { indent: "  ", width: maxWidth }
        )
      );

      console.log("");
      console.log(chalk.bold("Proposed changes (by type):"));
      console.log(
        formatKv(
          [
            { key: "add", value: String(byType.add) },
            { key: "replace", value: String(byType.replace) },
            { key: "deprecate", value: String(byType.deprecate) },
            { key: "helpful", value: String(byType.helpful) },
            { key: "harmful", value: String(byType.harmful) },
            { key: "merge", value: String(byType.merge) },
          ],
          { indent: "  ", width: maxWidth }
        )
      );

      if (deltas.length > 0) {
        const previewLimit = 10;
        const shown = Math.min(previewLimit, deltas.length);
        const showing = deltas.length > shown ? ` (showing ${shown} of ${deltas.length})` : "";

        console.log("");
        console.log(chalk.bold(`Preview${showing}`));
        console.log(divider);

        const lineWidth = Math.max(24, maxWidth - 2);
        for (const d of deltas.slice(0, shown)) {
          const line = formatDeltaLine(d);
          const wrapped = wrapText(line, lineWidth);
          if (wrapped.length === 0) continue;
          console.log(`- ${wrapped[0]}`);
          for (const extra of wrapped.slice(1)) {
            console.log(`  ${extra}`);
          }
        }

        console.log(chalk.gray(`\n${cli} reflect --dry-run --json  # full delta JSON`));
      } else {
        console.log("");
        console.log(chalk.gray("No changes proposed."));
      }
    }
    return;
  }

  if (normalizedOptions.json) {
    printJsonResult(
      command,
      {
        global: result.globalResult,
        repo: result.repoResult,
        errors: result.errors,
      },
      { startedAtMs }
    );
    return;
  }

  // CLI Output
  if (result.sessionsProcessed === 0 && result.errors.length === 0) {
    console.log(chalk.green("No new sessions to reflect on."));
  } else {
    console.log(chalk.green(`\n${iconPrefix("check")}Reflection complete.`));
    console.log(
      formatKv(
        [
          { key: "Sessions processed", value: String(result.sessionsProcessed) },
          { key: "Deltas generated", value: String(result.deltasGenerated) },
        ],
        { indent: "  ", width: maxWidth }
      )
    );
    console.log("");

    if (result.globalResult) {
      console.log(chalk.bold(`Global Updates:`));
      console.log(
        formatKv(
          [
            { key: "Applied", value: String(result.globalResult.applied) },
            { key: "Skipped", value: String(result.globalResult.skipped) },
            { key: "Inversions", value: String(result.globalResult.inversions.length) },
          ],
          { indent: "  ", width: maxWidth }
        )
      );
      if (result.globalResult.inversions.length > 0) {
        console.log(chalk.yellow(`  Inverted ${result.globalResult.inversions.length} harmful rules.`));
      }
    }

    if (result.repoResult) {
      console.log(chalk.bold(`Repo Updates:`));
      console.log(
        formatKv(
          [
            { key: "Applied", value: String(result.repoResult.applied) },
            { key: "Skipped", value: String(result.repoResult.skipped) },
            { key: "Inversions", value: String(result.repoResult.inversions.length) },
          ],
          { indent: "  ", width: maxWidth }
        )
      );
      if (result.repoResult.inversions.length > 0) {
        console.log(chalk.yellow(`  Inverted ${result.repoResult.inversions.length} harmful rules.`));
      }
    }

    if (result.errors.length > 0) {
      console.log(chalk.gray(`\nNext: ${cli} doctor`));
    }
  }

  const statsAfter = await getUsageStats(config);
  const operationCost = statsAfter.today - statsBefore.today;
  if (operationCost > 0) {
    console.log(chalk.dim(formatCostSummary(operationCost, statsAfter)));
  }
}
