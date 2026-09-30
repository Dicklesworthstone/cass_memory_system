import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import type { Command } from "commander";
import yaml from "yaml";
import { createProgram } from "../src/cm.js";
import { contextCommand } from "../src/commands/context.js";
import { onboardCommand } from "../src/commands/onboard.js";
import { QuickstartResultSchema, quickstartCommand } from "../src/commands/quickstart.js";
import {
  buildRobotDocs,
  COMMAND_DATA_SCHEMAS,
  ErrorEnvelopeSchema,
  OnboardStatusResultSchema,
  ROBOT_DOCS_TOPICS,
  robotDocsCommand,
  successEnvelopeSchema,
} from "../src/commands/robot-docs.js";
import { ContextResultSchema } from "../src/types.js";
import { getVersion } from "../src/utils.js";
import { createTestBullet, createTestPlaybook } from "./helpers/factories.js";
import { withTempCassHome } from "./helpers/temp.js";

/** Run fn and return everything it wrote through console.log (structured output lands there in tests). */
async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return logs.join("\n");
}

function program(): Command {
  return createProgram(["bun", "src/cm.ts"]);
}

/** Split a shell-ish example line into tokens, honoring double quotes. */
function tokenize(line: string): string[] {
  return (line.match(/"[^"]*"|\S+/g) ?? []).map((t) => t.replace(/^"|"$/g, ""));
}

describe("cm robot-docs", () => {
  test("returns every topic with version metadata when no topic is given", () => {
    const doc = buildRobotDocs(program());
    expect(doc.schemaVersion).toBe(1);
    expect(doc.version).toBe(getVersion());
    expect(Object.keys(doc.topics).sort()).toEqual([...ROBOT_DOCS_TOPICS].sort());
  });

  test("a single topic returns only that topic", async () => {
    const out = await captureStdout(() => robotDocsCommand("exit-codes", program()));
    const payload = JSON.parse(out);
    expect(payload.success).toBe(true);
    expect(Object.keys(payload.data.topics)).toEqual(["exit-codes"]);
    const codes = payload.data.topics["exit-codes"].codes.map((c: any) => c.code);
    expect(codes).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  test("an unknown topic is a JSON input error with exit code 2", async () => {
    const saved = process.exitCode;
    try {
      const out = await captureStdout(() => robotDocsCommand("nope", program()));
      const payload = ErrorEnvelopeSchema.parse(JSON.parse(out));
      expect(payload.error.code).toBe("INVALID_INPUT");
      expect(payload.error.exitCode).toBe(2);
      expect(process.exitCode).toBe(2);
    } finally {
      process.exitCode = saved;
    }
  });

  test("commands topic mirrors the live CLI, including nested subcommands", () => {
    const p = program();
    const doc = buildRobotDocs(p, "commands").topics.commands as any;
    expect(doc.commands.map((c: any) => c.name)).toEqual(p.commands.map((c) => c.name()));
    expect(doc.commands.map((c: any) => c.name)).toContain("robot-docs");
    const playbook = doc.commands.find((c: any) => c.name === "playbook");
    const add = playbook.subcommands.find((c: any) => c.name === "add");
    expect(add.path).toBe("playbook add");
    const category = add.options.find((o: any) => o.long === "--category");
    expect(category).toMatchObject({ takesValue: true, valueRequired: true });
  });

  test("every example resolves to a real command and uses only real flags", () => {
    const p = program();
    const doc = buildRobotDocs(p, "examples").topics.examples as any;
    const steps = doc.workflows.flatMap((w: any) => w.steps.map((s: any) => s.command));
    expect(steps.length).toBeGreaterThan(10);

    for (const step of steps as string[]) {
      if (step.startsWith("#")) continue; // placeholder like "# ... do the work ..."
      const tokens = tokenize(step);
      tokens.shift(); // cli name
      let cmd: Command = p;
      const flagsSeen: string[] = [];
      for (const token of tokens) {
        if (token === ">" || token === "|") break;
        if (token.startsWith("--")) {
          flagsSeen.push(token.split("=")[0]);
          continue;
        }
        const sub = cmd.commands.find((c) => c.name() === token || c.aliases().includes(token));
        if (sub) cmd = sub;
      }
      expect({ step, resolved: cmd !== p }).toEqual({ step, resolved: true });
      const known = new Set(
        [...cmd.options, ...p.options].flatMap((o) => [o.long, o.negate ? o.long : undefined]),
      );
      for (const flag of flagsSeen) {
        expect({ step, flag, known: known.has(flag) }).toEqual({ step, flag, known: true });
      }
    }
  });

  test("schemas topic publishes open JSON Schemas for the envelope and documented commands", () => {
    const doc = buildRobotDocs(program(), "schemas").topics.schemas as any;
    expect(Object.keys(doc.commands)).toEqual(Object.keys(COMMAND_DATA_SCHEMAS));
    expect(doc.envelope.success.type).toBe("object");
    expect(doc.envelope.error.properties.error.properties.exitCode.type).toBe("integer");
    expect(doc.commands.context.properties.relevantBullets.type).toBe("array");
    const text = JSON.stringify(doc);
    expect(text).not.toContain('"additionalProperties":false');
  });
});

describe("robot-docs schemas match real command output", () => {
  test("quickstart --json", async () => {
    const out = await captureStdout(() => quickstartCommand({ json: true }));
    successEnvelopeSchema(QuickstartResultSchema).parse(JSON.parse(out));
  });

  test("onboard status --json (fresh and with rules)", async () => {
    await withTempCassHome(async (env) => {
      writeFileSync(
        env.playbookPath,
        yaml.stringify(
          createTestPlaybook([
            createTestBullet({ content: "Run the failing test alone first", category: "testing" }),
            createTestBullet({ content: "Bisect before guessing", category: "debugging" }),
          ]),
        ),
      );
      const out = await captureStdout(() => onboardCommand({ json: true, status: true }));
      const payload = successEnvelopeSchema(OnboardStatusResultSchema).parse(JSON.parse(out));
      expect(payload.data.gapAnalysis.totalRules).toBe(2);
    });
  });

  test("context --json", async () => {
    await withTempCassHome(async (env) => {
      writeFileSync(
        env.playbookPath,
        yaml.stringify(
          createTestPlaybook([
            createTestBullet({ content: "Validate JWT expiry on every request", category: "security" }),
          ]),
        ),
      );
      const out = await captureStdout(() => contextCommand("jwt expiry validation", { json: true }));
      const payload = successEnvelopeSchema(ContextResultSchema).parse(JSON.parse(out));
      expect(payload.data.task).toBe("jwt expiry validation");
    });
  });
});
