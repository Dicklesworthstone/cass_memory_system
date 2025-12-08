import { loadConfig } from "../config.js";
import { loadMergedPlaybook, getActiveBullets } from "../playbook.js";
import { scanSessionsForViolations } from "../audit.js";
import { AuditResult } from "../types.js";
import { cassTimeline } from "../cass.js";
import chalk from "chalk";

export async function auditCommand(flags: { days?: number; json?: boolean }) {
  const config = await loadConfig();
  const playbook = await loadMergedPlaybook(config);
  
  // Get recent sessions
  const timeline = await cassTimeline(flags.days || 7, config.cassPath);
  const sessions = timeline.groups.flatMap((g: any) => g.sessions.map((s: any) => s.path));

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
    console.log(JSON.stringify(result, null, 2));
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
}