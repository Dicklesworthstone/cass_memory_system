import fs from "node:fs/promises";
import path from "node:path";
import { Config } from "./types.js";
import { expandPath, ensureDir, fileExists } from "./utils.js";
import { sanitize } from "./security.js";
import { getSanitizeConfig } from "./config.js";

export type OutcomeStatus = "success" | "failure" | "partial";

export interface OutcomeInput {
  sessionId: string;
  outcome: OutcomeStatus;
  rulesUsed?: string[];
  notes?: string;
  durationSec?: number;
  task?: string;
}

export interface OutcomeRecord extends OutcomeInput {
  recordedAt: string;
  path: string;
}

async function resolveOutcomeLogPath(): Promise<string> {
  const repoPath = expandPath(".cass/outcomes.jsonl");
  const repoDirExists = await fileExists(expandPath(".cass"));

  if (repoDirExists) {
    return repoPath;
  }

  return expandPath("~/.cass-memory/outcomes.jsonl");
}

export async function recordOutcome(
  input: OutcomeInput,
  config: Config
): Promise<OutcomeRecord> {
  const targetPath = await resolveOutcomeLogPath();
  const sanitizeConfig = getSanitizeConfig(config);
  const normalizedSanitizeConfig = {
    ...sanitizeConfig,
    extraPatterns: (sanitizeConfig.extraPatterns || []).map((p) =>
      typeof p === "string" ? new RegExp(p, "g") : p
    )
  };

  const cleanedNotes = input.notes
    ? sanitize(input.notes, normalizedSanitizeConfig)
    : undefined;

  const record: OutcomeRecord = {
    ...input,
    rulesUsed: input.rulesUsed || [],
    notes: cleanedNotes,
    recordedAt: new Date().toISOString(),
    path: targetPath
  };

  await ensureDir(path.dirname(targetPath));
  await fs.appendFile(targetPath, JSON.stringify(record) + "\n", "utf-8");

  return record;
}

