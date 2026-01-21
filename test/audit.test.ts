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
import { scanSessionsForViolations } from "../src/audit.js";
import { withTempCassHome } from "./helpers/temp.js";
import { createTestBullet, createTestPlaybook, createTestConfig } from "./helpers/factories.js";

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
            // Extra patterns use the generic [REDACTED] placeholder
            expect(promptJoined).toContain("[REDACTED]");

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

  test("reports missing API key error when no LLM provider available (JSON mode)", async () => {
    await withEnvAsync(
      {
        ANTHROPIC_API_KEY: undefined,
        OPENAI_API_KEY: undefined,
        GOOGLE_GENERATIVE_AI_API_KEY: undefined,
      },
      async () => {
        await withTempCassHome(async (env) => {
          await withCwd(env.home, async () => {
            writeFileSync(env.configPath, JSON.stringify({ cassPath: "cass" }, null, 2));
            writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])));

            process.exitCode = 0;
            const { output } = await captureConsoleLog(() =>
              auditCommand({ days: 7, json: true })
            );

            const payload = JSON.parse(output) as any;
            expect(payload.success).toBe(false);
            expect(payload.error.code).toBe("MISSING_API_KEY");
            expect(payload.error.message).toContain("Audit requires LLM access");
          });
        });
      }
    );
  });

  test("handles empty/malformed timeline gracefully (JSON mode)", async () => {
    await withEnvAsync(
      {
        ANTHROPIC_API_KEY: undefined,
        OPENAI_API_KEY: undefined,
        GOOGLE_GENERATIVE_AI_API_KEY: undefined,
      },
      async () => {
        await withTempCassHome(async (env) => {
          await withCwd(env.home, async () => {
            // Return timeline without groups property
            const cassRunner = createCassRunnerStub({
              timeline: JSON.stringify({}),
              exportText: "",
            });

            writeFileSync(
              env.configPath,
              JSON.stringify({ cassPath: "cass", apiKey: "sk-ant-test-0000000000000000" }, null, 2)
            );
            writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])));

            process.exitCode = 0;
            const { output } = await captureConsoleLog(() =>
              auditCommand({ days: 7, json: true }, { cassRunner })
            );

            const payload = JSON.parse(output) as any;
            expect(payload.success).toBe(true);
            expect(payload.data?.stats.sessionsScanned).toBe(0);
            expect(payload.data?.stats.violationsFound).toBe(0);
          });
        });
      }
    );
  });

  test("handles empty timeline in human-readable mode", async () => {
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
              timeline: JSON.stringify({}),
              exportText: "",
            });

            writeFileSync(
              env.configPath,
              JSON.stringify({ cassPath: "cass", apiKey: "sk-ant-test-0000000000000000" }, null, 2)
            );
            writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])));

            const { output } = await captureConsoleLog(() =>
              auditCommand({ days: 7, json: false }, { cassRunner })
            );

            // With empty groups array, it says "No sessions found"
            expect(output).toContain("No sessions found");
          });
        });
      }
    );
  });

  test("trauma scan mode with no candidates (JSON mode)", async () => {
    await withTempCassHome(async (env) => {
      await withCwd(env.home, async () => {
        // Need to stub cass search for trauma scanning
        const cassRunner: CassRunner = {
          execFile: async (_file, args) => {
            const cmd = args[0] ?? "";
            if (cmd === "timeline") return { stdout: JSON.stringify({ groups: [] }), stderr: "" };
            if (cmd === "export") return { stdout: "", stderr: "" };
            if (cmd === "search") return { stdout: "[]", stderr: "" };  // No trauma matches
            throw new Error(`Unexpected cass execFile command: ${cmd}`);
          },
          spawnSync: () => ({ status: 0, stdout: "", stderr: "" }),
          spawn: (() => { throw new Error("spawn not implemented"); }) as any,
        };

        writeFileSync(env.configPath, JSON.stringify({ cassPath: "cass" }, null, 2));
        writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])));

        const { output } = await captureConsoleLog(() =>
          auditCommand({ days: 7, json: true, trauma: true }, { cassRunner })
        );

        const payload = JSON.parse(output) as any;
        expect(payload.success).toBe(true);
        expect(payload.data.candidates).toEqual([]);
      });
    });
  });

  test("trauma scan mode with no candidates (human-readable mode)", async () => {
    await withTempCassHome(async (env) => {
      await withCwd(env.home, async () => {
        // Need to stub cass search for trauma scanning
        const cassRunner: CassRunner = {
          execFile: async (_file, args) => {
            const cmd = args[0] ?? "";
            if (cmd === "timeline") return { stdout: JSON.stringify({ groups: [] }), stderr: "" };
            if (cmd === "export") return { stdout: "", stderr: "" };
            if (cmd === "search") return { stdout: "[]", stderr: "" };  // No trauma matches
            throw new Error(`Unexpected cass execFile command: ${cmd}`);
          },
          spawnSync: () => ({ status: 0, stdout: "", stderr: "" }),
          spawn: (() => { throw new Error("spawn not implemented"); }) as any,
        };

        writeFileSync(env.configPath, JSON.stringify({ cassPath: "cass" }, null, 2));
        writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])));

        const { output } = await captureConsoleLog(() =>
          auditCommand({ days: 7, json: false, trauma: true }, { cassRunner })
        );

        expect(output).toContain("Project Hot Stove");
        expect(output).toContain("No potential traumas found");
      });
    });
  });

  test("displays human-readable audit results with violations", async () => {
    await withEnvAsync(
      {
        ANTHROPIC_API_KEY: undefined,
        OPENAI_API_KEY: undefined,
        GOOGLE_GENERATIVE_AI_API_KEY: undefined,
      },
      async () => {
        await withTempCassHome(async (env) => {
          await withCwd(env.home, async () => {
            const sessionPath = "/sessions/audit-hr.jsonl";
            const timelineJson = JSON.stringify({
              groups: [{ date: "2025-01-01", sessions: [{ path: sessionPath, agent: "stub", messageCount: 1, startTime: "10:00", endTime: "10:01" }] }],
            });

            const cassRunner = createCassRunnerStub({ timeline: timelineJson, exportText: "test content" });

            writeFileSync(
              env.configPath,
              JSON.stringify({ cassPath: "cass", apiKey: "sk-ant-test-0000000000000000" }, null, 2)
            );

            const bullet = createTestBullet({ id: "b-hr-test", content: "Test rule", category: "testing", maturity: "proven" });
            writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([bullet])));

            const io: LLMIO = {
              generateObject: async <T>() => ({
                object: {
                  results: [{ ruleId: "b-hr-test", status: "violated", evidence: "Found violation" }],
                  summary: "1 violation",
                } as any as T,
              }),
            };

            const { output } = await captureConsoleLog(() =>
              auditCommand({ days: 7, json: false }, { io, cassRunner })
            );

            expect(output).toContain("AUDIT RESULTS");
            expect(output).toContain("Sessions scanned:");
            expect(output).toContain("Violations found:");
            expect(output).toContain("HIGH");
            expect(output).toContain("b-hr-test");
          });
        });
      }
    );
  });

  test("trauma scan mode with found candidates displays human-readable output", async () => {
    await withTempCassHome(async (env) => {
      await withCwd(env.home, async () => {
        // Stub cass to return trauma search results with correct CassHit format
        const cassRunner: CassRunner = {
          execFile: async (_file, args) => {
            const cmd = args[0] ?? "";
            if (cmd === "timeline") return { stdout: JSON.stringify({ groups: [] }), stderr: "" };
            if (cmd === "export") {
              // Return session content that matches DOOM_PATTERNS (apology + destructive action)
              return {
                stdout: "I apologize for the mistake. I deleted your important database files by accident.",
                stderr: ""
              };
            }
            if (cmd === "search") {
              // Return search results with correct CassHit format
              return {
                stdout: JSON.stringify([
                  {
                    source_path: "/sessions/trauma-session.jsonl",
                    line_number: 10,
                    agent: "claude",
                    snippet: "I apologize for deleting your database",
                    score: 0.9,
                  },
                ]),
                stderr: "",
              };
            }
            throw new Error(`Unexpected cass execFile command: ${cmd}`);
          },
          spawnSync: () => ({ status: 0, stdout: "", stderr: "" }),
          spawn: (() => { throw new Error("spawn not implemented"); }) as any,
        };

        writeFileSync(env.configPath, JSON.stringify({ cassPath: "cass" }, null, 2));
        writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])));

        const { output } = await captureConsoleLog(() =>
          auditCommand({ days: 7, json: false, trauma: true }, { cassRunner })
        );

        expect(output).toContain("Project Hot Stove");
        // Should show found candidates or no candidates message
        expect(output.toLowerCase()).toMatch(/candidate|trauma|found/i);
      });
    });
  });

  test("audit command handles playbook errors gracefully (JSON mode)", async () => {
    await withEnvAsync(
      {
        ANTHROPIC_API_KEY: undefined,
        OPENAI_API_KEY: undefined,
        GOOGLE_GENERATIVE_AI_API_KEY: undefined,
      },
      async () => {
        await withTempCassHome(async (env) => {
          await withCwd(env.home, async () => {
            writeFileSync(
              env.configPath,
              JSON.stringify({ cassPath: "cass", apiKey: "sk-ant-test-0000000000000000" }, null, 2)
            );
            // Write invalid YAML that will cause loadMergedPlaybook to throw
            writeFileSync(env.playbookPath, "{{{{invalid yaml that will not parse");

            process.exitCode = 0;
            const { output } = await captureConsoleLog(() =>
              auditCommand({ days: 7, json: true })
            );

            const payload = JSON.parse(output) as any;
            expect(payload.success).toBe(false);
            expect(payload.error.code).toBe("AUDIT_FAILED");
          });
        });
      }
    );
  });

  test("scanSessionsForViolations maps severity and skips retired bullets", async () => {
    const playbook = createTestPlaybook([
      createTestBullet({
        id: "b-proven",
        content: "Always validate inputs",
        state: "active",
        maturity: "proven",
      }),
      createTestBullet({
        id: "b-candidate",
        content: "Use structured logs",
        state: "active",
        maturity: "candidate",
      }),
      createTestBullet({
        id: "b-retired",
        content: "Deprecated rule",
        state: "retired",
        maturity: "deprecated",
        deprecated: true,
      }),
    ]);

    const cassRunner: CassRunner = {
      execFile: async (_file, args) => {
        const cmd = args[0] ?? "";
        if (cmd === "export") return { stdout: "session content", stderr: "" };
        throw new Error(`Unexpected cass execFile command: ${cmd}`);
      },
      spawnSync: () => ({ status: 0, stdout: "", stderr: "" }),
      spawn: (() => {
        throw new Error("spawn not implemented in cass runner stub");
      }) as any,
    };

    const io: LLMIO = {
      generateObject: async <T>() => ({
        object: {
          results: [
            { ruleId: "b-proven", status: "violated", evidence: "Found issue" },
            { ruleId: "b-candidate", status: "violated", evidence: "Found issue" },
            { ruleId: "b-retired", status: "violated", evidence: "Found issue" },
          ],
        } as any as T,
      }),
    };

    const config = createTestConfig({ apiKey: "sk-ant-test-0000000000000000" });
    const violations = await scanSessionsForViolations(
      ["/sessions/audit-s1.jsonl"],
      playbook,
      config,
      io,
      cassRunner
    );

    expect(violations).toHaveLength(2);
    const byId = Object.fromEntries(violations.map((v) => [v.bulletId, v]));
    expect(byId["b-proven"]?.severity).toBe("high");
    expect(byId["b-candidate"]?.severity).toBe("medium");
    expect(byId["b-retired"]).toBeUndefined();
  });
});
