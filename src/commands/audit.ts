import { loadConfig } from "../config.js";
import { loadMergedPlaybook, getActiveBullets } from "../playbook.js";
import { scanSessionsForViolations } from "../audit.js";
import { AuditResult } from "../types.js";
import { cassTimeline } from "../cass.js";
import chalk from "chalk";
import { error as logError, printJsonError, printJsonResult } from "../utils.js";
import { ErrorCode } from "../types.js";

export async function auditCommand(flags: { days?: number; json?: boolean }) {
  try {
    const config = await loadConfig();
    if (!config.apiKey) {
      const message = "Audit requires LLM access (missing API key). Set ANTHROPIC_API_KEY or OPENAI_API_KEY, or run with a provider configured in config.";
      if (flags.json) {
        printJsonError(message, { code: ErrorCode.MISSING_REQUIRED });
      } else {
        logError(message);
      }
      process.exitCode = 1;
      return;
    }

    const playbook = await loadMergedPlaybook(config);
    
    // Get recent sessions
    const timeline = await cassTimeline(flags.days || 7, config.cassPath);
    
    // Safety check: timeline might be empty or malformed
    if (!timeline || !timeline.groups) {
      if (flags.json) {
        printJsonResult({ violations: [], stats: { sessionsScanned: 0, rulesChecked: 0, violationsFound: 0, bySeverity: { high: 0, medium: 0, low: 0 } }, scannedAt: new Date().toISOString() });
      } else {
        console.log(chalk.yellow("No session history found."));
      }
      return;
    }

    const sessions = timeline.groups.flatMap((g: any) => g.sessions.map((s: any) => s.path));

    if (sessions.length === 0) {
      if (flags.json) {
        printJsonResult({ violations: [], stats: { sessionsScanned: 0, rulesChecked: 0, violationsFound: 0, bySeverity: { high: 0, medium: 0, low: 0 } }, scannedAt: new Date().toISOString() });
      } else {
        console.log(chalk.yellow(`No sessions found in the last ${flags.days || 7} days.`));
      }
      return;
    }

    // Scan
    const violations = await scanSessionsForViolations(sessions, playbook, config);

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
      printJsonResult(result);
    } else {
      console.log(chalk.bold(`AUDIT RESULTS (last ${flags.days || 7} days)`));
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
	    if (flags.json) {
	      printJsonError(message, { code: ErrorCode.AUDIT_FAILED });
	    } else {
	      logError(`Audit failed: ${message}`);
	    }
	    process.exitCode = 1;
	    return;
	  }
}
