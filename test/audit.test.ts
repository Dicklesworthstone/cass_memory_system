/**
 * Unit tests for audit command
 *
 * Covers:
 * - Session retrieval via cass timeline (days filtering)
 * - JSON output contract + stats
 * - Privacy: sanitization applied before LLM audit
 */
import { describe, test, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import yaml from "yaml";

import type { LLMIO } from "../src/llm.js";
import type { CassRunner } from "../src/cass.js";
import { auditCommand } from "../src/commands/audit.js";
import { withTempCassHome } from "./helpers/temp.js";
import { createTestBullet, createTestPlaybook } from "./helpers/factories.js";

function createCassRunnerStub(opts: { timeline: string; exportText: string }): CassRunner {
  return {
    execFile: async (_file, args) => {
      const cmd = args[0] ?? "";
      if (cmd === "timeline") return { stdout: opts.timeline, stderr: "" };
      if (cmd === "export") return { stdout: opts.exportText, stderr: "" };
      throw new Error(`Unexpected cass execFile command: ${cmd}`);
    },
    spawnSync: () => ({ status: 0, stdout: "", stderr: "" }),
    spawn: (() => {
      throw new Error("spawn not implemented in cass runner stub");
    }) as any,
  };
}

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
    lines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
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

type AuditJson = {
  violations: Array<{
    bulletId: string;
    bulletContent: string;
    sessionPath: string;
    evidence: string;
    severity: "high" | "medium" | "low";
    timestamp: string;
  }>;
  stats: {
    sessionsScanned: number;
    rulesChecked: number;
    violationsFound: number;
    bySeverity: { high: number; medium: number; low: number };
  };
  scannedAt: string;
};

describe("audit command - Unit Tests", () => {
  test("scans recent sessions, reports violations, and sanitizes secrets before LLM audit (JSON mode)", async () => {
    await withEnvAsync(
      {
        ANTHROPIC_API_KEY: undefined,
        OPENAI_API_KEY: undefined,
        GOOGLE_GENERATIVE_AI_API_KEY: undefined,
      },
      async () => {
        await withTempCassHome(async (env) => {
          await withCwd(env.home, async () => {
            const sessionPath = "/sessions/audit-s1.jsonl";
            const timelineJson = JSON.stringify({
              groups: [
                {
                  date: "2025-01-01",
                  sessions: [
                    {
                      path: sessionPath,
                      agent: "stub",
                      messageCount: 1,
                      startTime: "10:00",
                      endTime: "10:01",
                    },
                  ],
                },
              ],
            });

            const cassExportText = `User note: SUPER_SECRET should never appear in prompts.`;
            const cassRunner = createCassRunnerStub({ timeline: timelineJson, exportText: cassExportText });

            writeFileSync(
              env.configPath,
              JSON.stringify(
                {
                  cassPath: "cass",
                  apiKey: "sk-ant-test-0000000000000000",
                  sanitization: { enabled: true, extraPatterns: ["SUPER_SECRET"] },
                },
                null,
                2
              )
            );

            const bullet = createTestBullet({
              id: "b-audit-proven",
              category: "Security",
              scope: "global",
              state: "active",
              maturity: "proven",
              content: "Never leak secrets to logs or prompts.",
            });
            writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([bullet])));

            const prompts: string[] = [];
            const io: LLMIO = {
              generateObject: async <T>(options: any) => {
                const prompt = typeof options?.prompt === "string" ? options.prompt : "";
                prompts.push(prompt);
                return {
                  object: {
                    results: [
                      {
                        ruleId: bullet.id,
                        status: "violated",
                        evidence: "Found [REDACTED_CUSTOM][REDACTED] in session content.",
                      },
                    ],
                    summary: "1 violation",
                  } as any as T,
                };
              },
            };

            process.exitCode = 0;
            const { output } = await captureConsoleLog(() =>
              auditCommand({ days: 30, json: true }, { io, cassRunner })
            );

            const payload = JSON.parse(output) as JsonEnvelope<AuditJson>;
            expect(payload.success).toBe(true);
            expect(payload.command).toBe("audit");

            expect(payload.data?.stats.sessionsScanned).toBe(1);
            expect(payload.data?.stats.rulesChecked).toBe(1);
            expect(payload.data?.stats.violationsFound).toBe(1);
            expect(payload.data?.stats.bySeverity.high).toBe(1);

            expect(payload.data?.violations).toHaveLength(1);
            expect(payload.data?.violations[0]?.bulletId).toBe("b-audit-proven");
            expect(payload.data?.violations[0]?.severity).toBe("high");

            const promptJoined = prompts.join("\n");
            expect(promptJoined).not.toContain("SUPER_SECRET");
            expect(promptJoined).toContain("[REDACTED_CUSTOM][REDACTED]");

            expect(JSON.stringify(payload.data)).not.toContain("SUPER_SECRET");
          });
        });
      }
    );
  });

  test("returns empty stats when no sessions are found (JSON mode)", async () => {
    await withEnvAsync(
      {
        ANTHROPIC_API_KEY: undefined,
        OPENAI_API_KEY: undefined,
        GOOGLE_GENERATIVE_AI_API_KEY: undefined,
      },
      async () => {
        await withTempCassHome(async (env) => {
          await withCwd(env.home, async () => {
            const cassRunner = createCassRunnerStub({
              timeline: JSON.stringify({ groups: [] }),
              exportText: "",
            });

            writeFileSync(
              env.configPath,
              JSON.stringify({ cassPath: "cass", apiKey: "sk-ant-test-0000000000000000" }, null, 2)
            );

            writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])));

            const prompts: string[] = [];
            const io: LLMIO = {
              generateObject: async <T>(options: any) => {
                prompts.push(String(options?.prompt ?? ""));
                return { object: { results: [] } as any as T };
              },
            };

            process.exitCode = 0;
            const { output } = await captureConsoleLog(() =>
              auditCommand({ days: 30, json: true }, { io, cassRunner })
            );

            const payload = JSON.parse(output) as JsonEnvelope<AuditJson>;
            expect(payload.success).toBe(true);
            expect(payload.command).toBe("audit");
            expect(payload.data?.stats.sessionsScanned).toBe(0);
            expect(payload.data?.stats.violationsFound).toBe(0);
            expect(prompts).toHaveLength(0);
          });
        });
      }
    );
  });

  test("fails fast on invalid days (JSON mode)", async () => {
    process.exitCode = 0;
    const badDays = await captureConsoleLog(() => auditCommand({ days: 0, json: true }));
    const payload = JSON.parse(badDays.output) as any;
    expect(payload.success).toBe(false);
    expect(payload.command).toBe("audit");
    expect(payload.error.code).toBe("INVALID_INPUT");
    expect(process.exitCode).toBe(2);
  });
});
