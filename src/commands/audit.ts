import { loadConfig } from "../config.js";
import { loadMergedPlaybook, getActiveBullets } from "../playbook.js";
import { scanSessionsForViolations } from "../audit.js";
import { scanForTraumas } from "../trauma.js";
import { AuditResult, ErrorCode } from "../types.js";
import { cassTimeline, type CassRunner } from "../cass.js";
import { getAvailableProviders, type LLMIO } from "../llm.js";
import chalk from "chalk";
import { getCliName, reportError, printJsonResult, validatePositiveInt } from "../utils.js";

export async function auditCommand(
  flags: { days?: number; json?: boolean; trauma?: boolean },
  deps: { io?: LLMIO; cassRunner?: CassRunner } = {}
) {
  const startedAtMs = Date.now();
  const command = "audit";
  try {
    const cli = getCliName();
    const daysCheck = validatePositiveInt(flags.days, "days", { min: 1, allowUndefined: true });
    if (!daysCheck.ok) {
      reportError(daysCheck.message, {
        code: ErrorCode.INVALID_INPUT,
        details: daysCheck.details,
        hint: `Example: ${cli} audit --days 30 --json`,
        json: flags.json,
        command,
        startedAtMs,
      });
      return;
    }

    const days = daysCheck.value ?? 7;
    const config = await loadConfig();

    // === TRAUMA SCAN MODE ===
    if (flags.trauma) {
      if (!flags.json) {
        console.log(chalk.bold.red("\n🔥 PROJECT HOT STOVE: Scanning for past catastrophes..."));
      }
      
      const candidates = await scanForTraumas(config, days, deps.cassRunner);
      
      if (flags.json) {
        printJsonResult(command, { candidates }, { startedAtMs });
        return;
      }
      
      if (candidates.length === 0) {
        console.log(chalk.green("No potential traumas found (or maybe you hid them well)."));
        return;
      }
      
      console.log(chalk.yellow(`Found ${candidates.length} candidate traumas:`));
      for (const c of candidates) {
        console.log(chalk.red(`\n[TRAUMA CANDIDATE]`));
        console.log(`  Pattern: ${chalk.bold(c.description)}`);
        console.log(`  Session: ${c.sessionPath}`);
        console.log(`  Evidence: ${chalk.white.bgRed(c.evidence)}`);
        // Show limited context
        const preview = c.context.length > 200 ? c.context.slice(0, 200) + "..." : c.context;
        console.log(`  Context:  "${preview.replace(/\n/g, " ")}"`);
      }
      console.log(chalk.bold("\nTo convert these to scars, use 'cm trauma add' (coming soon)."));
      return;
    }

    const cassRunner = deps.cassRunner;
    const hasApiKeyOverride = typeof config.apiKey === "string" && config.apiKey.trim() !== "";
    const availableProviders = getAvailableProviders();
    if (!hasApiKeyOverride && availableProviders.length === 0) {
      const message =
        "Audit requires LLM access. Set one of: ANTHROPIC_API_KEY, OPENAI_API_KEY, or GOOGLE_GENERATIVE_AI_API_KEY (or set apiKey in config).";
      reportError(message, { code: ErrorCode.MISSING_API_KEY, json: flags.json, command, startedAtMs });
      return;
    }

    const playbook = await loadMergedPlaybook(config);

    // Get recent sessions
    const timeline = cassRunner
      ? await cassTimeline(days, config.cassPath, cassRunner)
      : await cassTimeline(days, config.cassPath);
    
    // Safety check: timeline might be empty or malformed
    if (!timeline || !timeline.groups) {
      if (flags.json) {
        printJsonResult(
          command,
          {
            violations: [],
            stats: {
              sessionsScanned: 0,
              rulesChecked: 0,
              violationsFound: 0,
              bySeverity: { high: 0, medium: 0, low: 0 },
            },
            scannedAt: new Date().toISOString(),
          },
          { startedAtMs }
        );
      } else {
        console.log(chalk.yellow("No session history found."));
      }
      return;
    }

    const sessions = timeline.groups.flatMap((g: any) => g.sessions.map((s: any) => s.path));

    if (sessions.length === 0) {
      if (flags.json) {
        printJsonResult(
          command,
          {
            violations: [],
            stats: {
              sessionsScanned: 0,
              rulesChecked: 0,
              violationsFound: 0,
              bySeverity: { high: 0, medium: 0, low: 0 },
            },
            scannedAt: new Date().toISOString(),
          },
          { startedAtMs }
        );
      } else {
        console.log(chalk.yellow(`No sessions found in the last ${days} days.`));
      }
      return;
    }

    // Scan
    const violations = await scanSessionsForViolations(sessions, playbook, config, deps.io, cassRunner);

    // Stats
    const stats = {
      sessionsScanned: sessions.length,
      rulesChecked: getActiveBullets(playbook).length,
      violationsFound: violations.length,
      bySeverity: {
        high: violations.filter(v => v.severity === "high").length,
        medium: violations.filter(v => v.severity === "medium").length,
        low: violations.filter(v => v.severity === "low").length
      }
    };

    const result: AuditResult = {
      violations,
      stats,
      scannedAt: new Date().toISOString()
    };

    if (flags.json) {
      printJsonResult(command, result, { startedAtMs });
    } else {
      console.log(chalk.bold(`AUDIT RESULTS (last ${days} days)`));
      console.log(`Sessions scanned: ${stats.sessionsScanned}`);
      console.log(`Violations found: ${stats.violationsFound}`);
      console.log("");

      violations.forEach(v => {
        const color = v.severity === "high" ? chalk.red : v.severity === "medium" ? chalk.yellow : chalk.blue;
        console.log(color(`[${v.severity.toUpperCase()}] Rule ${v.bulletId}`));
        console.log(`  ${v.bulletContent}`);
        console.log(chalk.gray(`  Session: ${v.sessionPath}`));
        console.log(chalk.gray(`  Evidence: ${v.evidence}`));
        console.log("");
      });
    }
  } catch (err: any) {
    const message = err?.message || String(err);
    reportError(err instanceof Error ? err : message, {
      code: ErrorCode.AUDIT_FAILED,
      json: flags.json,
      command,
      startedAtMs,
    });
    return;
  }
}
