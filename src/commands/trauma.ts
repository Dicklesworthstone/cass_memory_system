import crypto from "node:crypto";
import fs from "node:fs/promises";
import chalk from "chalk";
import {
  loadTraumas,
  removeTraumaById,
  saveTrauma,
  saveTraumas,
  setTraumaStatusById,
} from "../trauma.js";
import { ErrorCode, type TraumaEntry } from "../types.js";
import {
  confirmDangerousAction,
  expandPath,
  fileExists,
  getCliName,
  now,
  printJsonResult,
  reportError,
  validateNonEmptyString,
  validateOneOf,
} from "../utils.js";

export async function traumaCommand(
  action: string | undefined,
  args: string[],
  flags: {
    severity?: string;
    message?: string;
    scope?: string;
    force?: boolean;
    yes?: boolean;
    json?: boolean;
  },
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

    if (action === "heal") {
      await healTrauma(args, flags);
      return;
    }

    if (action === "remove") {
      await removeTrauma(args, flags);
      return;
    }

    if (action === "import") {
      await importTraumas(args, flags);
      return;
    }

    const usage = `Usage: ${cli} trauma [list|add|heal|remove|import] ...`;
    if (flags.json) {
      reportError(`Unknown trauma subcommand: ${action}`, {
        code: ErrorCode.INVALID_INPUT,
        hint: usage,
        details: { action },
        json: flags.json,
        command,
        startedAtMs,
      });
      return;
    }
    console.log(usage);
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
  const allTraumas = await loadTraumas();
  const traumas = allTraumas.filter((t) => t.status === "active");

  if (json) {
    printJsonResult(
      "trauma list",
      { traumas, healedCount: allTraumas.length - traumas.length },
      { startedAtMs: Date.now() },
    );
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

async function addTrauma(
  args: string[],
  flags: { severity?: string; message?: string; scope?: string; json?: boolean },
) {
  const pattern = args[0];
  const patternCheck = validateNonEmptyString(pattern, "pattern");
  if (!patternCheck.ok) {
    throw new Error(patternCheck.message);
  }

  // Fail fast on invalid regex patterns so we don't store a "dead" trauma entry.
  try {
    // Use case-insensitive compile here to match runtime usage.
    // We don't store flags; only the raw pattern string is persisted.
    new RegExp(patternCheck.value, "i");
  } catch (err: any) {
    throw new Error(`Invalid regex pattern: ${err?.message || String(err)}`);
  }

  const severityCheck = validateOneOf(flags.severity, "severity", ["CRITICAL", "FATAL"] as const, {
    allowUndefined: true,
  });
  if (!severityCheck.ok) {
    throw new Error(severityCheck.message);
  }
  const severity = severityCheck.value || "CRITICAL";

  const scopeCheck = validateOneOf(flags.scope, "scope", ["global", "project"] as const, {
    allowUndefined: true,
  });
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
      human_message: message,
    },
    created_at: now(),
  };

  await saveTrauma(entry);

  if (flags.json) {
    printJsonResult("trauma add", { entry }, { startedAtMs: Date.now() });
  } else {
    console.log(chalk.green(`✓ Added trauma ${entry.id}`));
    console.log(chalk.yellow("The safety guard will now block this pattern."));
  }
}

async function healTrauma(
  args: string[],
  flags: { scope?: string; json?: boolean },
): Promise<void> {
  const cli = getCliName();
  const idRaw = args[0];
  const idCheck = validateNonEmptyString(idRaw, "id");
  if (!idCheck.ok) {
    reportError(idCheck.message, {
      code: ErrorCode.INVALID_INPUT,
      hint: `Example: ${cli} trauma heal trauma-abc123`,
      details: idCheck.details,
      json: flags.json,
      command: "trauma",
      startedAtMs: Date.now(),
    });
    return;
  }

  const scopeCheck = validateOneOf(flags.scope, "scope", ["global", "project", "all"] as const, {
    allowUndefined: true,
    caseInsensitive: true,
  });
  if (!scopeCheck.ok) {
    throw new Error(scopeCheck.message);
  }
  const scope = scopeCheck.value ?? "all";

  const result = await setTraumaStatusById(idCheck.value, "healed", { scope });
  if (result.updated === 0) {
    reportError(`Trauma ${idCheck.value} not found (nothing healed)`, {
      code: ErrorCode.TRAUMA_NOT_FOUND,
      details: { traumaId: idCheck.value, checkedPaths: result.checkedPaths },
      hint: `Try: ${cli} trauma list`,
      json: flags.json,
      command: "trauma",
      startedAtMs: Date.now(),
    });
    return;
  }

  if (flags.json) {
    printJsonResult("trauma heal", result, { startedAtMs: Date.now() });
    return;
  }

  console.log(
    chalk.green(
      `✓ Healed trauma ${idCheck.value} (${result.updated} entr${result.updated === 1 ? "y" : "ies"})`,
    ),
  );
  for (const p of result.updatedPaths) {
    console.log(chalk.gray(`  Updated: ${p}`));
  }
  console.log(chalk.yellow("This trauma will no longer block matching commands."));
}

async function removeTrauma(
  args: string[],
  flags: { scope?: string; force?: boolean; yes?: boolean; json?: boolean },
): Promise<void> {
  const startedAtMs = Date.now();
  const cli = getCliName();
  const idRaw = args[0];
  const idCheck = validateNonEmptyString(idRaw, "id");
  if (!idCheck.ok) {
    reportError(idCheck.message, {
      code: ErrorCode.INVALID_INPUT,
      hint: `Example: ${cli} trauma remove trauma-abc123 --force`,
      details: idCheck.details,
      json: flags.json,
      command: "trauma",
      startedAtMs,
    });
    return;
  }

  const scopeCheck = validateOneOf(flags.scope, "scope", ["global", "project", "all"] as const, {
    allowUndefined: true,
    caseInsensitive: true,
  });
  if (!scopeCheck.ok) {
    throw new Error(scopeCheck.message);
  }
  const scope = scopeCheck.value ?? "all";

  if (!flags.force) {
    reportError("Refusing to remove trauma without --force", {
      code: ErrorCode.MISSING_REQUIRED,
      hint: `Example: ${cli} trauma remove ${idCheck.value} --force`,
      details: { missing: "--force", traumaId: idCheck.value },
      json: flags.json,
      command: "trauma",
      startedAtMs,
    });
    return;
  }

  const confirmed = await confirmDangerousAction({
    action: `Remove trauma ${idCheck.value} (delete entry from registry)`,
    details: [`Trauma id: ${idCheck.value}`, `Scope: ${scope}`],
    confirmPhrase: "REMOVE",
    yes: flags.yes,
    json: flags.json,
  });
  if (!confirmed) {
    if (flags.json) {
      printJsonResult(
        "trauma remove",
        { removed: 0, checkedPaths: [], updatedPaths: [] },
        { startedAtMs, effect: false, reason: "User did not confirm removal" },
      );
    }
    return;
  }

  const result = await removeTraumaById(idCheck.value, { scope });
  if (result.removed === 0) {
    reportError(`Trauma ${idCheck.value} not found (nothing removed)`, {
      code: ErrorCode.TRAUMA_NOT_FOUND,
      details: { traumaId: idCheck.value, checkedPaths: result.checkedPaths },
      hint: `Try: ${cli} trauma list`,
      json: flags.json,
      command: "trauma",
      startedAtMs,
    });
    return;
  }

  if (flags.json) {
    printJsonResult("trauma remove", result, { startedAtMs });
    return;
  }

  console.log(
    chalk.green(
      `✓ Removed trauma ${idCheck.value} (${result.removed} entr${result.removed === 1 ? "y" : "ies"})`,
    ),
  );
  for (const p of result.updatedPaths) {
    console.log(chalk.gray(`  Updated: ${p}`));
  }
}

async function importTraumas(
  args: string[],
  flags: { severity?: string; message?: string; scope?: string; json?: boolean },
): Promise<void> {
  const startedAtMs = Date.now();
  const cli = getCliName();
  const fileRaw = args[0];
  const fileCheck = validateNonEmptyString(fileRaw, "file");
  if (!fileCheck.ok) {
    reportError(fileCheck.message, {
      code: ErrorCode.INVALID_INPUT,
      hint: `Example: ${cli} trauma import ./traumas.txt --scope global`,
      details: fileCheck.details,
      json: flags.json,
      command: "trauma",
      startedAtMs,
    });
    return;
  }

  const scopeCheck = validateOneOf(flags.scope, "scope", ["global", "project"] as const, {
    allowUndefined: true,
    caseInsensitive: true,
  });
  if (!scopeCheck.ok) {
    throw new Error(scopeCheck.message);
  }
  const scope = scopeCheck.value ?? "global";

  const severityCheck = validateOneOf(flags.severity, "severity", ["CRITICAL", "FATAL"] as const, {
    allowUndefined: true,
    caseInsensitive: true,
  });
  if (!severityCheck.ok) {
    throw new Error(severityCheck.message);
  }
  const severity = severityCheck.value ?? "CRITICAL";

  const expandedPath = expandPath(fileCheck.value);
  if (!(await fileExists(expandedPath))) {
    reportError(`File not found: ${fileCheck.value}`, {
      code: ErrorCode.FILE_NOT_FOUND,
      details: { file: fileCheck.value },
      hint: `Provide a readable file path (one pattern per line, or JSONL objects with {"pattern": "..."}).`,
      json: flags.json,
      command: "trauma",
      startedAtMs,
    });
    return;
  }

  const message = flags.message || `Imported from ${fileCheck.value}`;
  const content = await fs.readFile(expandedPath, "utf-8");
  const lines = content.split(/\r?\n/);

  const warnings: string[] = [];
  let imported = 0;

  const entriesToSave: TraumaEntry[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const trimmed = raw.trim();
    if (!trimmed) continue;

    const lineNumber = i + 1;

    const parsed = (() => {
      try {
        return JSON.parse(trimmed) as unknown;
      } catch {
        return undefined;
      }
    })();

    const pattern = (() => {
      if (typeof parsed === "string") return parsed;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const p = (parsed as any).pattern;
        return typeof p === "string" ? p : undefined;
      }
      return trimmed;
    })();

    if (typeof pattern !== "string" || !pattern.trim()) {
      warnings.push(`Line ${lineNumber}: missing pattern (skipped)`);
      continue;
    }

    try {
      new RegExp(pattern, "i");
    } catch (err: any) {
      warnings.push(
        `Line ${lineNumber}: invalid regex pattern (skipped): ${err?.message || String(err)}`,
      );
      continue;
    }

    const entry: TraumaEntry = {
      id: `trauma-${crypto.randomBytes(4).toString("hex")}`,
      severity,
      pattern,
      scope,
      status: "active",
      trigger_event: {
        session_path: "import",
        timestamp: now(),
        human_message: message,
      },
      created_at: now(),
    };

    entriesToSave.push(entry);
    imported += 1;
  }

  if (entriesToSave.length > 0) {
    await saveTraumas(entriesToSave);
  }

  if (flags.json) {
    printJsonResult(
      "trauma import",
      { imported, warningsCount: warnings.length },
      { startedAtMs, ...(warnings.length > 0 ? { warnings } : {}) },
    );
    return;
  }

  console.log(chalk.green(`✓ Imported ${imported} trauma entr${imported === 1 ? "y" : "ies"}`));
  if (warnings.length > 0) {
    console.log(chalk.yellow(`Warnings (${warnings.length}):`));
    for (const w of warnings) console.log(chalk.yellow(`  - ${w}`));
  }
}
