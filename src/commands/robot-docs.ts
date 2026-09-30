/**
 * robot-docs command - machine-readable CLI documentation for agents.
 *
 * `cm robot-docs [topic]` prints one JSON document (data only on stdout) with:
 * - guide:      the `cm quickstart --json` content
 * - commands:   every command, argument and option, read from the live
 *               commander program (so it cannot drift from the real CLI)
 * - examples:   copy-paste workflows (the same list as `cm --examples`)
 * - exit-codes: the exit codes cm actually uses, and the JSON error shape
 * - schemas:    JSON Schema for the JSON envelope and for the `data` of
 *               `context`, `quickstart` and `onboard status`
 *
 * Without a topic, all topics are returned.
 */

import { zodSchema } from "ai";
import type { Command, Option } from "commander";
import { z } from "zod";
import { getWorkflows } from "../examples.js";
import { PlaybookGapAnalysisSchema } from "../gap-analysis.js";
import { OnboardProgressSchema } from "../onboard-state.js";
import { ContextResultSchema, ErrorCode } from "../types.js";
import {
  ERROR_CATEGORY_EXIT_CODES,
  getCliName,
  getVersion,
  printJsonResult,
  reportError,
} from "../utils.js";
import { OnboardStatusSchema } from "./onboard.js";
import { getQuickstartJson, QuickstartResultSchema } from "./quickstart.js";

/** Bumped when the shape of the robot-docs document itself changes. */
export const ROBOT_DOCS_SCHEMA_VERSION = 1;

export const ROBOT_DOCS_TOPICS = ["guide", "commands", "examples", "exit-codes", "schemas"] as const;
export type RobotDocsTopic = (typeof ROBOT_DOCS_TOPICS)[number];

// --- JSON envelope schemas (mirror buildJsonSuccessPayload / buildJsonErrorPayload) ---

const EnvelopeMetadataSchema = z
  .object({ executionMs: z.number().min(0), version: z.string() })
  .strict();

export function successEnvelopeSchema<T extends z.ZodTypeAny>(data: T) {
  return z
    .object({
      success: z.literal(true),
      command: z.string(),
      timestamp: z.string(),
      data,
      warnings: z.array(z.string()).optional(),
      metadata: EnvelopeMetadataSchema,
      effect: z.literal(false).optional(),
      reason: z.string().optional(),
    })
    .strict();
}

export const ErrorEnvelopeSchema = z
  .object({
    success: z.literal(false),
    command: z.string(),
    timestamp: z.string(),
    error: z
      .object({
        message: z.string(),
        code: z.string(),
        exitCode: z.number().int(),
        recovery: z.array(z.string()),
        cause: z.string().optional(),
        docs: z.string().optional(),
        hint: z.string().optional(),
        retryable: z.boolean().optional(),
        details: z.unknown().optional(),
      })
      .strict(),
    metadata: EnvelopeMetadataSchema,
  })
  .strict();

export const OnboardStatusResultSchema = z
  .object({
    status: OnboardStatusSchema,
    progress: OnboardProgressSchema,
    gapAnalysis: PlaybookGapAnalysisSchema,
  })
  .strict();

/** The `data` schema of each documented command's `--json` output. */
export const COMMAND_DATA_SCHEMAS = {
  context: ContextResultSchema,
  quickstart: QuickstartResultSchema,
  "onboard status": OnboardStatusResultSchema,
} as const;

/**
 * Convert a zod schema to JSON Schema. Output schemas are published open
 * (no `additionalProperties: false`): consumers must ignore fields they do
 * not know, so adding a field is not a breaking change.
 */
function toOpenJsonSchema(schema: z.ZodTypeAny): unknown {
  const open = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(open);
    if (!node || typeof node !== "object") return node;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === "additionalProperties" && value === false) continue;
      if (key === "$schema") continue;
      out[key] = open(value);
    }
    return out;
  };
  return open(zodSchema(schema).jsonSchema);
}

function buildSchemasDoc() {
  const commands: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(COMMAND_DATA_SCHEMAS)) {
    commands[name] = toOpenJsonSchema(schema);
  }
  return {
    dialect: "http://json-schema.org/draft-07/schema#",
    note:
      "Every --json success is `envelope.success` with the command's schema below as `data`; " +
      "every error is `envelope.error`. Schemas are open: ignore unknown fields.",
    envelope: {
      success: toOpenJsonSchema(successEnvelopeSchema(z.unknown())),
      error: toOpenJsonSchema(ErrorEnvelopeSchema),
    },
    commands,
  };
}

// --- commands topic ---

interface OptionDoc {
  flags: string;
  long: string | null;
  short: string | null;
  description: string;
  takesValue: boolean;
  valueRequired: boolean;
  negate: boolean;
  default?: unknown;
}

interface ArgumentDoc {
  name: string;
  description: string;
  required: boolean;
  variadic: boolean;
}

interface CommandDoc {
  path: string;
  name: string;
  aliases: string[];
  description: string;
  usage: string;
  arguments: ArgumentDoc[];
  options: OptionDoc[];
  subcommands: CommandDoc[];
}

function describeOption(opt: Option): OptionDoc {
  return {
    flags: opt.flags,
    long: opt.long ?? null,
    short: opt.short ?? null,
    description: opt.description,
    takesValue: opt.required || opt.optional,
    valueRequired: opt.required,
    negate: opt.negate,
    ...(opt.defaultValue !== undefined ? { default: opt.defaultValue } : {}),
  };
}

function describeCommand(cmd: Command, parentPath: string): CommandDoc {
  const path = parentPath ? `${parentPath} ${cmd.name()}` : cmd.name();
  return {
    path,
    name: cmd.name(),
    aliases: cmd.aliases(),
    description: cmd.description(),
    usage: `${getCliName()} ${path} ${cmd.usage()}`.trim(),
    arguments: cmd.registeredArguments.map((a) => ({
      name: a.name(),
      description: a.description,
      required: a.required,
      variadic: a.variadic,
    })),
    options: cmd.options.map(describeOption),
    subcommands: cmd.commands.map((sub) => describeCommand(sub, path)),
  };
}

function buildCommandsDoc(program: Command) {
  return {
    globalOptions: program.options.map(describeOption),
    commands: program.commands.map((c) => describeCommand(c, "")),
    jsonOutput:
      "Most commands accept --json (or --format json); output then goes to stdout as one JSON document.",
  };
}

// --- examples topic ---

function buildExamplesDoc() {
  const cli = getCliName();
  return {
    workflows: getWorkflows().map((w) => ({
      title: w.title,
      description: w.description,
      steps: w.commands.map((line) => {
        const hash = line.search(/\s#\s/);
        const command = (hash === -1 ? line : line.slice(0, hash)).trim();
        const note = hash === -1 ? undefined : line.slice(hash).replace(/^\s*#\s*/, "").trim();
        return note ? { command, note } : { command };
      }),
    })),
    tip: `Run ${cli} <command> --help for command-specific examples`,
  };
}

// --- exit-codes topic ---

const EXIT_CODE_MEANINGS: Record<string, string> = {
  internal: "Unexpected error (a bug in cm, or an unclassified failure)",
  user_input: "Invalid arguments or input",
  configuration: "Invalid or unreadable configuration",
  filesystem: "File or directory problem (missing, permission denied, disk full)",
  network: "Network failure or timeout",
  cass: "cass is missing, failed, or its index is unavailable",
  llm: "LLM provider error (API key, rate limit, provider failure)",
};

function buildExitCodesDoc() {
  const codes = Object.entries(ERROR_CATEGORY_EXIT_CODES)
    .map(([category, code]) => ({
      code,
      category,
      meaning: EXIT_CODE_MEANINGS[category] ?? category,
    }))
    .sort((a, b) => a.code - b.code);
  return {
    codes: [{ code: 0, category: "success", meaning: "Success" }, ...codes],
    errorShape:
      "With --json, an error is printed to stdout as the error envelope (see the `schemas` topic); " +
      "`error.exitCode` equals the process exit code and `error.recovery` lists next steps.",
  };
}

// --- command entry ---

export function buildRobotDocs(program: Command, topic?: RobotDocsTopic) {
  const builders: Record<RobotDocsTopic, () => unknown> = {
    guide: () => getQuickstartJson(getCliName()),
    commands: () => buildCommandsDoc(program),
    examples: () => buildExamplesDoc(),
    "exit-codes": () => buildExitCodesDoc(),
    schemas: () => buildSchemasDoc(),
  };
  const selected = topic ? [topic] : [...ROBOT_DOCS_TOPICS];
  const topics: Record<string, unknown> = {};
  for (const t of selected) topics[t] = builders[t]();
  return {
    schemaVersion: ROBOT_DOCS_SCHEMA_VERSION,
    version: getVersion(),
    availableTopics: [...ROBOT_DOCS_TOPICS],
    topics,
  };
}

export async function robotDocsCommand(
  topic: string | undefined,
  program: Command,
): Promise<void> {
  const startedAtMs = Date.now();
  const command = "robot-docs";
  const normalized = topic?.trim().toLowerCase();
  if (normalized && !(ROBOT_DOCS_TOPICS as readonly string[]).includes(normalized)) {
    reportError(`Unknown robot-docs topic: ${topic}`, {
      code: ErrorCode.INVALID_INPUT,
      hint: `Valid topics: ${ROBOT_DOCS_TOPICS.join(", ")} (or none for all)`,
      details: { topic, validTopics: [...ROBOT_DOCS_TOPICS] },
      json: true,
      command,
      startedAtMs,
    });
    return;
  }
  printJsonResult(command, buildRobotDocs(program, normalized as RobotDocsTopic | undefined), {
    startedAtMs,
  });
}
