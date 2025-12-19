import chalk from "chalk";
import { 
  TraumaEntry, 
  TraumaSeverityEnum, 
  TraumaScopeEnum,
  ErrorCode 
} from "../types.js";
import { 
  loadTraumas, 
  saveTrauma,
  DOOM_PATTERNS
} from "../trauma.js";
import { 
  getCliName, 
  reportError, 
  printJsonResult, 
  validateNonEmptyString, 
  validateOneOf,
  now
} from "../utils.js";
import crypto from "node:crypto";

export async function traumaCommand(
  action: string | undefined, 
  args: string[], 
  flags: { 
    severity?: string; 
    message?: string; 
    scope?: string; 
    json?: boolean 
  }
) {
  const startedAtMs = Date.now();
  const command = "trauma";
  const cli = getCliName();

  try {
    if (!action || action === "list") {
      await listTraumas(flags.json);
      return;
    }

    if (action === "add") {
      await addTrauma(args, flags);
      return;
    }

    // if (action === "remove") ... (Future)

    console.log(`Usage: ${cli} trauma [list|add] ...`);
  } catch (err: any) {
    reportError(err instanceof Error ? err : String(err), {
      code: ErrorCode.INTERNAL_ERROR,
      json: flags.json,
      command,
      startedAtMs,
    });
  }
}

async function listTraumas(json?: boolean) {
  const traumas = await loadTraumas();
  
  if (json) {
    printJsonResult("trauma list", { traumas }, { startedAtMs: Date.now() });
    return;
  }

  if (traumas.length === 0) {
    console.log(chalk.green("No active traumas found. (Safe... for now.)"));
    return;
  }

  console.log(chalk.bold(`ACTIVE TRAUMAS (${traumas.length})`));
  console.log(chalk.gray("These patterns are strictly forbidden by the safety guard."));
  console.log("");

  for (const t of traumas) {
    const color = t.severity === "FATAL" ? chalk.bgRed.white : chalk.red;
    console.log(`${color(`[${t.severity}]`)} ${chalk.bold(t.id)}`);
    console.log(`  Pattern: ${chalk.cyan(t.pattern)}`);
    console.log(`  Scope:   ${t.scope}`);
    console.log(`  Reason:  ${t.trigger_event.human_message || "N/A"}`);
    console.log("");
  }
}

async function addTrauma(args: string[], flags: { severity?: string; message?: string; scope?: string; json?: boolean }) {
  const pattern = args[0];
  const patternCheck = validateNonEmptyString(pattern, "pattern");
  if (!patternCheck.ok) {
    throw new Error(patternCheck.message);
  }

  const severityCheck = validateOneOf(flags.severity, "severity", ["CRITICAL", "FATAL"] as const, { allowUndefined: true });
  if (!severityCheck.ok) {
    throw new Error(severityCheck.message);
  }
  const severity = severityCheck.value || "CRITICAL";

  const scopeCheck = validateOneOf(flags.scope, "scope", ["global", "project"] as const, { allowUndefined: true });
  if (!scopeCheck.ok) {
    throw new Error(scopeCheck.message);
  }
  const scope = scopeCheck.value || "global";

  const message = flags.message || "Manually added trauma.";

  const entry: TraumaEntry = {
    id: `trauma-${crypto.randomBytes(4).toString("hex")}`,
    severity,
    pattern: patternCheck.value,
    scope,
    status: "active",
    trigger_event: {
      session_path: "manual-entry",
      timestamp: now(),
      human_message: message
    },
    created_at: now()
  };

  await saveTrauma(entry);

  if (flags.json) {
    printJsonResult("trauma add", { entry }, { startedAtMs: Date.now() });
  } else {
    console.log(chalk.green(`✓ Added trauma ${entry.id}`));
    console.log(chalk.yellow("The safety guard will now block this pattern."));
  }
}
