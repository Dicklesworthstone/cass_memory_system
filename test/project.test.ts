/**
 * Unit tests for project command
 *
 * Covers:
 * - Export formats (agents.md, claude.md, raw)
 * - --top + --showCounts behavior
 * - Safe overwrite guard for --output
 */
import { describe, test, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import yaml from "yaml";

import { projectCommand } from "../src/commands/project.js";
import { withTempCassHome } from "./helpers/temp.js";
import { createTestBullet, createTestFeedbackEvent, createTestPlaybook } from "./helpers/factories.js";

async function withEnvAsync<T>(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<T>
): Promise<T> {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function withCwd<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.cwd();
  process.chdir(cwd);
  try {
    return await fn();
  } finally {
    process.chdir(previous);
  }
}

async function captureConsoleLog<T>(fn: () => Promise<T> | T): Promise<{ result: T; output: string }> {
  const original = console.log;
  const lines: string[] = [];

  // eslint-disable-next-line no-console
  console.log = (...args: unknown[]) => {
    lines.push(
      args
        .map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
        .join(" ")
    );
  };

  try {
    const result = await fn();
    return { result, output: lines.join("\n") };
  } finally {
    // eslint-disable-next-line no-console
    console.log = original;
  }
}

type JsonEnvelope<T> = {
  success: boolean;
  command: string;
  timestamp: string;
  data?: T;
  error?: { code: string; message: string; exitCode: number; hint?: string };
};

describe("project command - Unit Tests", () => {
  test("exports agents.md with --top and --showCounts=false", async () => {
    await withEnvAsync({ CASS_MEMORY_CLI_NAME: "cm" }, async () => {
      await withTempCassHome(async (env) => {
        await withCwd(env.home, async () => {
          const hi = createTestBullet({
            id: "b-project-hi",
            category: "Testing",
            content: "Prefer small, explicit edits over bulk refactors.",
            state: "active",
            helpfulCount: 5,
            harmfulCount: 2,
            feedbackEvents: [
              createTestFeedbackEvent("helpful", { timestamp: new Date().toISOString() }),
              createTestFeedbackEvent("helpful", { timestamp: new Date().toISOString() }),
            ],
          });
          const lo = createTestBullet({
            id: "b-project-lo",
            category: "Testing",
            content: "This lower-ranked rule should be filtered by --top 1.",
            state: "active",
            helpfulCount: 1,
            harmfulCount: 0,
            feedbackEvents: [createTestFeedbackEvent("helpful", { timestamp: new Date().toISOString() })],
          });
          const anti = createTestBullet({
            id: "b-project-anti",
            category: "Testing",
            content: "Commit secrets to git.",
            type: "anti-pattern",
            kind: "anti_pattern",
            state: "active",
          });

          writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([hi, lo, anti])));

          process.exitCode = 0;
          const { output } = await captureConsoleLog(() =>
            projectCommand({ json: true, format: "agents.md", top: 1, showCounts: false })
          );

          const payload = JSON.parse(output) as JsonEnvelope<{ format: string; content: string }>;
          expect(payload.success).toBe(true);
          expect(payload.command).toBe("project");
          expect(payload.data?.format).toBe("agents.md");
          expect(payload.data?.content).toContain("# AGENTS.md");
          expect(payload.data?.content).toContain(hi.content);
          expect(payload.data?.content).not.toContain(lo.content);
          expect(payload.data?.content).toContain("Anti-Patterns");
          expect(payload.data?.content).not.toContain("[5+/2-]");
        });
      });
    });
  });

  test("exports claude.md format and includes anti-patterns", async () => {
    await withTempCassHome(async (env) => {
      await withCwd(env.home, async () => {
        const rule = createTestBullet({
          id: "b-project-claude-rule",
          category: "Workflow",
          content: "Run `cm context` before starting non-trivial work.",
          state: "active",
        });
        const anti = createTestBullet({
          id: "b-project-claude-anti",
          category: "Workflow",
          content: "Ignore CI failures.",
          type: "anti-pattern",
          kind: "anti_pattern",
          state: "active",
        });
        writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([rule, anti])));

        process.exitCode = 0;
        const { output } = await captureConsoleLog(() =>
          projectCommand({ json: true, format: "claude.md", top: 10 })
        );

        const payload = JSON.parse(output) as JsonEnvelope<{ format: string; content: string }>;
        expect(payload.success).toBe(true);
        expect(payload.data?.format).toBe("claude.md");
        expect(payload.data?.content).toStartWith("<project_rules>");
        expect(payload.data?.content).toContain(`- ${rule.content}`);
        expect(payload.data?.content).toContain(`- DO NOT: ${anti.content}`);
      });
    });
  });

  test("exports raw playbook JSON", async () => {
    await withTempCassHome(async (env) => {
      await withCwd(env.home, async () => {
        const rule = createTestBullet({
          id: "b-project-raw",
          category: "General",
          content: "Treat lint warnings as errors.",
          state: "active",
        });
        writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([rule])));

        process.exitCode = 0;
        const { output } = await captureConsoleLog(() => projectCommand({ json: true, format: "raw" }));

        const payload = JSON.parse(output) as JsonEnvelope<{ format: string; content: string }>;
        expect(payload.success).toBe(true);
        expect(payload.data?.format).toBe("raw");

        const parsedPlaybook = JSON.parse(payload.data?.content ?? "{}") as { bullets?: Array<{ id: string }> };
        expect(parsedPlaybook.bullets?.map((b) => b.id)).toContain("b-project-raw");
      });
    });
  });

  test("refuses to overwrite an existing --output without --force (JSON mode)", async () => {
    await withEnvAsync({ CASS_MEMORY_CLI_NAME: "cm" }, async () => {
      await withTempCassHome(async (env) => {
        await withCwd(env.home, async () => {
          writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])));

          const outPath = path.join(env.home, "AGENTS.md");
          writeFileSync(outPath, "# existing");

          process.exitCode = 0;
          const { output } = await captureConsoleLog(() =>
            projectCommand({ json: true, format: "agents.md", output: outPath, force: false })
          );

          const payload = JSON.parse(output) as JsonEnvelope<unknown>;
          expect(payload.success).toBe(false);
          expect(payload.command).toBe("project");
          expect(payload.error?.code).toBe("ALREADY_EXISTS");
          expect(process.exitCode).toBe(2);
        });
      });
    });
  });

  test("fails fast on invalid format/top/output (JSON mode)", async () => {
    process.exitCode = 0;
    const badFormat = await captureConsoleLog(() => projectCommand({ json: true, format: "nope" }));
    const badFormatPayload = JSON.parse(badFormat.output) as any;
    expect(badFormatPayload.success).toBe(false);
    expect(badFormatPayload.command).toBe("project");
    expect(badFormatPayload.error.code).toBe("INVALID_INPUT");
    expect(process.exitCode).toBe(2);

    process.exitCode = 0;
    const badTop = await captureConsoleLog(() => projectCommand({ json: true, format: "agents.md", top: 0 }));
    const badTopPayload = JSON.parse(badTop.output) as any;
    expect(badTopPayload.success).toBe(false);
    expect(badTopPayload.command).toBe("project");
    expect(badTopPayload.error.code).toBe("INVALID_INPUT");
    expect(process.exitCode).toBe(2);

    process.exitCode = 0;
    const badOutput = await captureConsoleLog(() => projectCommand({ json: true, output: "   " }));
    const badOutputPayload = JSON.parse(badOutput.output) as any;
    expect(badOutputPayload.success).toBe(false);
    expect(badOutputPayload.command).toBe("project");
    expect(badOutputPayload.error.code).toBe("INVALID_INPUT");
    expect(process.exitCode).toBe(2);
  });
});
