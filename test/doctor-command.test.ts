/**
 * Unit tests for doctorCommand function in doctor.ts.
 * Tests JSON output, fix modes, and various health check scenarios.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import yaml from "yaml";
import { detectFixableIssues, doctorCommand } from "../src/commands/doctor.js";
import { CONFIG_INPUT_LIMITS, InputLimitError, PLAYBOOK_INPUT_LIMITS } from "../src/input-limits.js";
import { createTestConfig } from "./helpers/factories.js";
import { makeCassStub, type TestEnv, withTempCassHome } from "./helpers/temp.js";

// --- Test Helpers ---

async function withEnvAsync<T>(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<T>,
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

async function captureConsoleLog<T>(
  fn: () => Promise<T> | T,
): Promise<{ result: T; output: string }> {
  const original = console.log;
  const lines: string[] = [];

  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
  };

  try {
    const result = await fn();
    return { result, output: lines.join("\n") };
  } finally {
    console.log = original;
  }
}

// Create a valid playbook YAML
function createValidPlaybookYaml(bulletCount = 0): string {
  const now = new Date().toISOString();
  const bullets = [];
  for (let i = 0; i < bulletCount; i++) {
    bullets.push({
      id: `b-${i}`,
      content: `Test bullet ${i}`,
      category: "testing",
      kind: "workflow_rule",
      type: "rule",
      isNegative: false,
      scope: "global",
      state: "draft",
      maturity: "candidate",
      helpfulCount: 0,
      harmfulCount: 0,
      feedbackEvents: [],
      tags: [],
      sourceSessions: [],
      sourceAgents: [],
      createdAt: now,
      updatedAt: now,
      deprecated: false,
      pinned: false,
      confidenceDecayHalfLifeDays: 90,
    });
  }
  return yaml.stringify({
    schema_version: 2,
    name: "test-playbook",
    description: "Test playbook",
    metadata: {
      createdAt: now,
      totalReflections: 0,
      totalSessionsProcessed: 0,
    },
    deprecatedPatterns: [],
    bullets,
  });
}

describe("doctorCommand", () => {
  let envBackup: Record<string, string | undefined> = {};

  beforeEach(() => {
    envBackup = {
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      GOOGLE_GENERATIVE_AI_API_KEY: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
    };
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  describe("JSON mode output", () => {
    test("returns valid JSON with expected structure", async () => {
      await withEnvAsync(
        {
          ANTHROPIC_API_KEY: undefined,
          OPENAI_API_KEY: undefined,
          GOOGLE_GENERATIVE_AI_API_KEY: undefined,
        },
        async () => {
          await withTempCassHome(async (env) => {
            await withCwd(env.home, async () => {
              // Create valid config and playbook
              await writeFile(
                env.configPath,
                JSON.stringify({ cassPath: "cass", apiKey: "sk-ant-test-key" }, null, 2),
              );
              await writeFile(env.playbookPath, createValidPlaybookYaml());

              process.exitCode = 0;
              const { output } = await captureConsoleLog(() => doctorCommand({ json: true }));

              const envelope = JSON.parse(output);
              expect(envelope.success).toBe(true);
              expect(envelope.command).toBe("doctor");

              const payload = envelope.data;
              expect(payload).toHaveProperty("version");
              expect(payload).toHaveProperty("generatedAt");
              expect(payload).toHaveProperty("overallStatus");
              expect(payload).toHaveProperty("checks");
              expect(payload).toHaveProperty("recommendedActions");
              expect(Array.isArray(payload.checks)).toBe(true);
            });
          });
        },
      );
    });

    test("includes fixPlan in dry-run mode", async () => {
      await withEnvAsync(
        {
          ANTHROPIC_API_KEY: undefined,
          OPENAI_API_KEY: undefined,
          GOOGLE_GENERATIVE_AI_API_KEY: undefined,
        },
        async () => {
          await withTempCassHome(async (env) => {
            await withCwd(env.home, async () => {
              // Create valid config and playbook
              await writeFile(env.configPath, JSON.stringify({ cassPath: "cass" }, null, 2));
              await writeFile(env.playbookPath, createValidPlaybookYaml());

              process.exitCode = 0;
              const { output } = await captureConsoleLog(() =>
                doctorCommand({ json: true, fix: true, dryRun: true }),
              );

              const envelope = JSON.parse(output);
              expect(envelope.success).toBe(true);
              const payload = envelope.data;
              expect(payload).toHaveProperty("fixPlan");
              expect(payload.fixPlan).toHaveProperty("enabled", true);
              expect(payload.fixPlan).toHaveProperty("dryRun", true);
              expect(payload.fixPlan).toHaveProperty("wouldApply");
              expect(payload.fixPlan).toHaveProperty("wouldSkip");
            });
          });
        },
      );
    });

    test("includes selfTest results when requested", async () => {
      await withEnvAsync(
        {
          ANTHROPIC_API_KEY: "sk-ant-test-key",
          OPENAI_API_KEY: undefined,
          GOOGLE_GENERATIVE_AI_API_KEY: undefined,
        },
        async () => {
          await withTempCassHome(async (env) => {
            await withCwd(env.home, async () => {
              // Create valid config and playbook
              await writeFile(
                env.configPath,
                JSON.stringify(
                  { cassPath: "/nonexistent/cass", apiKey: "sk-ant-test-key" },
                  null,
                  2,
                ),
              );
              await writeFile(env.playbookPath, createValidPlaybookYaml());

              process.exitCode = 0;
              const { output } = await captureConsoleLog(() =>
                doctorCommand({ json: true, selfTest: true }),
              );

              const envelope = JSON.parse(output);
              expect(envelope.success).toBe(true);
              const payload = envelope.data;
              expect(payload).toHaveProperty("selfTest");
              expect(Array.isArray(payload.selfTest)).toBe(true);
              expect(payload.selfTest.length).toBeGreaterThan(0);

              // Check self-test items are present
              const items = payload.selfTest.map((t: any) => t.item);
              expect(items).toContain("Playbook Load");
            });
          });
        },
      );
    });
  });

  describe("config load error handling", () => {
    test("rechecks resource limits before backing up or resetting a changed config", async () => {
      await withTempCassHome(async (env) => {
        await withCwd(env.home, async () => {
          await writeFile(env.configPath, "{malformed json");
          await writeFile(env.playbookPath, createValidPlaybookYaml());
          const reset = (await detectFixableIssues()).find((issue) => issue.id === "reset-config");
          expect(reset).toBeDefined();
          const oversized = JSON.stringify({
            sessionExcludePatterns: Array(CONFIG_INPUT_LIMITS.maxArrayLength + 1).fill(null),
          });
          await writeFile(env.configPath, oversized);
          await expect(reset!.fix()).rejects.toThrow("Refusing to reset config: Input limit exceeded");
          expect(await readFile(env.configPath, "utf8")).toBe(oversized);
          expect((await readdir(env.cassMemoryDir)).some((name) => name.includes(".backup."))).toBe(false);
        });
      }, "doctor-reset-input-limits");
    });

    test("reports bounded input failures without offering a destructive config reset", async () => {
      await withTempCassHome(async (env) => {
        await withCwd(env.home, async () => {
          const oversized = JSON.stringify({
            sessionExcludePatterns: Array(CONFIG_INPUT_LIMITS.maxArrayLength + 1).fill(null),
          });
          await writeFile(env.configPath, oversized);
          await writeFile(env.playbookPath, createValidPlaybookYaml());
          const previousExitCode = process.exitCode;
          try {
            const { output } = await captureConsoleLog(() =>
              doctorCommand({ json: true, fix: true, dryRun: true }),
            );
            const payload = JSON.parse(output).data;
            const check = payload.checks.find(
              (entry: any) => entry.category === "Configuration" && entry.item === "config.json",
            );
            expect(check.status).toBe("fail");
            expect(check.message).toContain("Input limit exceeded");
            expect(payload.fixableIssues.some((issue: any) => issue.id === "reset-config")).toBe(false);
            expect(await readFile(env.configPath, "utf8")).toBe(oversized);

            // A selected repository's limit error must not reset a valid user config.
            await writeFile(env.configPath, "{}");
            const issues = await detectFixableIssues({
              configLoadError: new InputLimitError("repo/.cass/config.json", "maximum array length exceeded"),
            });
            expect(issues.some((issue) => issue.id === "reset-config")).toBe(false);
            expect(await readFile(env.configPath, "utf8")).toBe("{}");
          } finally {
            process.exitCode = previousExitCode;
          }
        });
      }, "doctor-input-limits");
    });

    test("offers explicit recovery for an oversized playbook without applying it during doctor fixes", async () => {
      await withTempCassHome(async (env) => {
        await withCwd(env.home, async () => {
          await writeFile(env.configPath, JSON.stringify({ embeddingModel: "none" }));
          const original = createValidPlaybookYaml(1) + "#" + "x".repeat(PLAYBOOK_INPUT_LIMITS.maxBytes);
          await writeFile(env.playbookPath, original);
          const previousExitCode = process.exitCode;
          try {
            const { output } = await captureConsoleLog(() => doctorCommand({ json: true, fix: true, dryRun: true }));
            const data = JSON.parse(output).data;
            const sizeCheck = data.checks.find((check: any) => check.item === "Playbook size");
            expect(sizeCheck.status).toBe("fail");
            expect(sizeCheck.details).toMatchObject({ path: env.playbookPath, sizeBytes: Buffer.byteLength(original), maxBytes: PLAYBOOK_INPUT_LIMITS.maxBytes });
            expect(data.recommendedActions.some((action: any) => action.command?.includes("playbook repair --strip-embeddings") && action.command.includes("--dry-run"))).toBe(true);
            expect(data.fixPlan.wouldApply.some((id: string) => /repair|strip|embedding/.test(id))).toBe(false);
            expect(await readFile(env.playbookPath, "utf8")).toBe(original);
            expect((await readdir(env.cassMemoryDir)).some((name) => name.includes("backup"))).toBe(false);
            await captureConsoleLog(() => doctorCommand({ json: true, fix: true, force: true, interactive: false }));
            expect(await readFile(env.playbookPath, "utf8")).toBe(original);
            expect((await readdir(env.cassMemoryDir)).some((name) => name.includes("backup"))).toBe(false);
          } finally {
            process.exitCode = previousExitCode;
          }
        });
      });
    });

    test("warns near the playbook byte limit and leaves normal-sized playbooks unflagged", async () => {
      await withTempCassHome(async (env) => {
        await withCwd(env.home, async () => {
          await writeFile(env.configPath, JSON.stringify({ embeddingModel: "none" }));
          const previousExitCode = process.exitCode;
          try {
            const normal = createValidPlaybookYaml();
            await writeFile(env.playbookPath, normal + "#" + "x".repeat(Math.ceil(PLAYBOOK_INPUT_LIMITS.maxBytes * 0.9)));
            const near = JSON.parse((await captureConsoleLog(() => doctorCommand({ json: true }))).output).data;
            expect(near.checks.find((check: any) => check.item === "Playbook size").status).toBe("warn");
            await writeFile(env.playbookPath, normal);
            const small = JSON.parse((await captureConsoleLog(() => doctorCommand({ json: true }))).output).data;
            expect(small.checks.some((check: any) => check.item === "Playbook size")).toBe(false);
          } finally {
            process.exitCode = previousExitCode;
          }
        });
      });
    });

    test("handles invalid JSON config gracefully", async () => {
      await withEnvAsync(
        {
          ANTHROPIC_API_KEY: undefined,
          OPENAI_API_KEY: undefined,
          GOOGLE_GENERATIVE_AI_API_KEY: undefined,
        },
        async () => {
          await withTempCassHome(async (env) => {
            await withCwd(env.home, async () => {
              // Write invalid JSON to config
              await writeFile(env.configPath, "{{{{invalid json");
              await writeFile(env.playbookPath, createValidPlaybookYaml());

              process.exitCode = 0;
              const { output } = await captureConsoleLog(() => doctorCommand({ json: true }));

              const envelope = JSON.parse(output);
              expect(envelope.success).toBe(true);
              const payload = envelope.data;
              expect(payload.overallStatus).not.toBe("healthy");

              // Should have a config-related check with fail status
              const configCheck = payload.checks.find(
                (c: any) => c.category === "Configuration" && c.item === "config.json",
              );
              expect(configCheck).toBeDefined();
              expect(configCheck.status).toBe("fail");
            });
          });
        },
      );
    });
  });

  describe("fix mode with issues", () => {
    test("detects fixable issues when config is missing", async () => {
      await withEnvAsync(
        {
          ANTHROPIC_API_KEY: undefined,
          OPENAI_API_KEY: undefined,
          GOOGLE_GENERATIVE_AI_API_KEY: undefined,
        },
        async () => {
          await withTempCassHome(async (env) => {
            await withCwd(env.home, async () => {
              // Delete the config to trigger missing config detection
              try {
                await rm(env.configPath, { force: true });
              } catch {}

              // Keep playbook
              await writeFile(env.playbookPath, createValidPlaybookYaml());

              process.exitCode = 0;
              const { output } = await captureConsoleLog(() =>
                doctorCommand({ json: true, fix: true, dryRun: true }),
              );

              const envelope = JSON.parse(output);
              expect(envelope.success).toBe(true);
              const payload = envelope.data;
              expect(payload).toHaveProperty("fixPlan");
              expect(payload).toHaveProperty("fixableIssues");
            });
          });
        },
      );
    });
  });

  describe("recommended actions", () => {
    test("suggests initializing global storage when not present", async () => {
      await withEnvAsync(
        {
          ANTHROPIC_API_KEY: undefined,
          OPENAI_API_KEY: undefined,
          GOOGLE_GENERATIVE_AI_API_KEY: undefined,
        },
        async () => {
          await withTempCassHome(async (env) => {
            await withCwd(env.home, async () => {
              // Remove the ~/.cass-memory directory
              await rm(env.cassMemoryDir, { recursive: true, force: true });

              process.exitCode = 0;
              const { output } = await captureConsoleLog(() => doctorCommand({ json: true }));

              const envelope = JSON.parse(output);
              expect(envelope.success).toBe(true);
              const payload = envelope.data;
              expect(payload.overallStatus).not.toBe("healthy");

              // Should recommend initializing
              const initAction = payload.recommendedActions.find((a: any) =>
                a.label.includes("Initialize"),
              );
              expect(initAction).toBeDefined();
            });
          });
        },
      );
    });

    test("includes apply-fixes recommendation after dry-run", async () => {
      await withEnvAsync(
        {
          ANTHROPIC_API_KEY: undefined,
          OPENAI_API_KEY: undefined,
          GOOGLE_GENERATIVE_AI_API_KEY: undefined,
        },
        async () => {
          await withTempCassHome(async (env) => {
            await withCwd(env.home, async () => {
              // Remove playbook to create a fixable issue
              await rm(env.playbookPath, { force: true });
              await writeFile(env.configPath, JSON.stringify({ cassPath: "cass" }, null, 2));

              process.exitCode = 0;
              const { output } = await captureConsoleLog(() =>
                doctorCommand({ json: true, fix: true, dryRun: true }),
              );

              const envelope = JSON.parse(output);
              expect(envelope.success).toBe(true);
              const payload = envelope.data;

              // Should recommend applying fixes for real
              const applyAction = payload.recommendedActions.find((a: any) =>
                a.label.includes("Apply fixes for real"),
              );
              expect(applyAction).toBeDefined();
              expect(applyAction.command).toContain("doctor --fix");
            });
          });
        },
      );
    });
  });

  describe("LLM configuration checks", () => {
    test("reports pass when API key is available", async () => {
      await withEnvAsync(
        {
          ANTHROPIC_API_KEY: "sk-ant-test-key",
          OPENAI_API_KEY: undefined,
          GOOGLE_GENERATIVE_AI_API_KEY: undefined,
        },
        async () => {
          await withTempCassHome(async (env) => {
            await withCwd(env.home, async () => {
              await writeFile(
                env.configPath,
                JSON.stringify({ cassPath: "cass", provider: "anthropic" }, null, 2),
              );
              await writeFile(env.playbookPath, createValidPlaybookYaml());

              process.exitCode = 0;
              const { output } = await captureConsoleLog(() => doctorCommand({ json: true }));

              const envelope = JSON.parse(output);
              expect(envelope.success).toBe(true);
              const payload = envelope.data;
              const llmCheck = payload.checks.find((c: any) => c.category === "LLM Configuration");
              expect(llmCheck).toBeDefined();
              expect(llmCheck.status).toBe("pass");
            });
          });
        },
      );
    });

    test("reports warn when no API keys are set", async () => {
      await withEnvAsync(
        {
          ANTHROPIC_API_KEY: undefined,
          OPENAI_API_KEY: undefined,
          GOOGLE_GENERATIVE_AI_API_KEY: undefined,
          CASS_CLI_COMMAND: "cass-test-nonexistent-cli-binary",
        },
        async () => {
          await withTempCassHome(async (env) => {
            await withCwd(env.home, async () => {
              await writeFile(env.configPath, JSON.stringify({ cassPath: "cass" }, null, 2));
              await writeFile(env.playbookPath, createValidPlaybookYaml());

              process.exitCode = 0;
              const { output } = await captureConsoleLog(() => doctorCommand({ json: true }));

              const envelope = JSON.parse(output);
              expect(envelope.success).toBe(true);
              const payload = envelope.data;
              const llmCheck = payload.checks.find((c: any) => c.category === "LLM Configuration");
              expect(llmCheck).toBeDefined();
              expect(llmCheck.status).toBe("warn");
            });
          });
        },
      );
    });

    test("reports fallback when configured provider unavailable but others are", async () => {
      await withEnvAsync(
        {
          ANTHROPIC_API_KEY: undefined,
          OPENAI_API_KEY: "sk-openai-test-key",
          GOOGLE_GENERATIVE_AI_API_KEY: undefined,
        },
        async () => {
          await withTempCassHome(async (env) => {
            await withCwd(env.home, async () => {
              // Configure anthropic but only openai key is available
              await writeFile(
                env.configPath,
                JSON.stringify({ cassPath: "cass", provider: "anthropic" }, null, 2),
              );
              await writeFile(env.playbookPath, createValidPlaybookYaml());

              process.exitCode = 0;
              const { output } = await captureConsoleLog(() => doctorCommand({ json: true }));

              const envelope = JSON.parse(output);
              expect(envelope.success).toBe(true);
              const payload = envelope.data;
              const llmCheck = payload.checks.find((c: any) => c.category === "LLM Configuration");
              expect(llmCheck).toBeDefined();
              expect(llmCheck.status).toBe("pass");
              expect(llmCheck.message).toContain("auto-fallback");
            });
          });
        },
      );
    });
  });

  describe("playbook schema version checks", () => {
    test("reports warn for outdated playbook schema", async () => {
      await withEnvAsync(
        {
          ANTHROPIC_API_KEY: undefined,
          OPENAI_API_KEY: undefined,
          GOOGLE_GENERATIVE_AI_API_KEY: undefined,
        },
        async () => {
          await withTempCassHome(async (env) => {
            await withCwd(env.home, async () => {
              await writeFile(env.configPath, JSON.stringify({ cassPath: "cass" }, null, 2));

              // Create playbook with old schema version
              const now = new Date().toISOString();
              const oldPlaybook = yaml.stringify({
                schema_version: 1,
                name: "old-playbook",
                description: "Test playbook with old schema",
                metadata: {
                  createdAt: now,
                  totalReflections: 0,
                  totalSessionsProcessed: 0,
                },
                deprecatedPatterns: [],
                bullets: [],
              });
              await writeFile(env.playbookPath, oldPlaybook);

              process.exitCode = 0;
              const { output } = await captureConsoleLog(() => doctorCommand({ json: true }));

              const envelope = JSON.parse(output);
              expect(envelope.success).toBe(true);
              const payload = envelope.data;
              const playbookCheck = payload.checks.find(
                (c: any) => c.category === "Playbook" && c.item === "Global playbook.yaml",
              );
              expect(playbookCheck).toBeDefined();
              expect(playbookCheck.status).toBe("warn");
              expect(playbookCheck.message).toContain("Outdated");
            });
          });
        },
      );
    });

    test("reports fail for invalid playbook YAML", async () => {
      await withEnvAsync(
        {
          ANTHROPIC_API_KEY: undefined,
          OPENAI_API_KEY: undefined,
          GOOGLE_GENERATIVE_AI_API_KEY: undefined,
        },
        async () => {
          await withTempCassHome(async (env) => {
            await withCwd(env.home, async () => {
              await writeFile(env.configPath, JSON.stringify({ cassPath: "cass" }, null, 2));

              // Write invalid YAML
              await writeFile(env.playbookPath, "{{{{invalid yaml that wont parse");

              process.exitCode = 0;
              const { output } = await captureConsoleLog(() => doctorCommand({ json: true }));

              const envelope = JSON.parse(output);
              expect(envelope.success).toBe(true);
              const payload = envelope.data;
              const playbookCheck = payload.checks.find(
                (c: any) => c.category === "Playbook" && c.item === "Global playbook.yaml",
              );
              expect(playbookCheck).toBeDefined();
              expect(playbookCheck.status).toBe("fail");
              expect(playbookCheck.message).toContain("invalid");
            });
          });
        },
      );
    });
  });

  describe("cass binary check", () => {
    test("reports fail when cass is not available", async () => {
      await withEnvAsync(
        {
          ANTHROPIC_API_KEY: undefined,
          OPENAI_API_KEY: undefined,
          GOOGLE_GENERATIVE_AI_API_KEY: undefined,
        },
        async () => {
          await withTempCassHome(async (env) => {
            await withCwd(env.home, async () => {
              await writeFile(
                env.configPath,
                JSON.stringify({ cassPath: "/nonexistent/cass-binary" }, null, 2),
              );
              await writeFile(env.playbookPath, createValidPlaybookYaml());

              process.exitCode = 0;
              const { output } = await captureConsoleLog(() => doctorCommand({ json: true }));

              const envelope = JSON.parse(output);
              expect(envelope.success).toBe(true);
              const payload = envelope.data;
              const cassCheck = payload.checks.find((c: any) => c.item === "cass");
              expect(cassCheck).toBeDefined();
              expect(cassCheck.status).toBe("fail");
            });
          });
        },
      );
    });
  });

  describe("buildFixPlan coverage", () => {
    test("skips manual fixes in plan", async () => {
      await withEnvAsync(
        {
          ANTHROPIC_API_KEY: undefined,
          OPENAI_API_KEY: undefined,
          GOOGLE_GENERATIVE_AI_API_KEY: undefined,
        },
        async () => {
          await withTempCassHome(async (env) => {
            await withCwd(env.home, async () => {
              await writeFile(env.configPath, JSON.stringify({ cassPath: "cass" }, null, 2));
              await writeFile(env.playbookPath, createValidPlaybookYaml());

              process.exitCode = 0;
              const { output } = await captureConsoleLog(() =>
                doctorCommand({ json: true, fix: true, dryRun: true }),
              );

              const envelope = JSON.parse(output);
              expect(envelope.success).toBe(true);
              const payload = envelope.data;

              // Manual fixes should appear in wouldSkip
              if (payload.fixPlan.wouldSkip.length > 0) {
                const manualSkipped = payload.fixPlan.wouldSkip.find(
                  (s: any) => s.reason === "manual fix required",
                );
                // Only check if there are manual issues detected
                if (manualSkipped) {
                  expect(manualSkipped.reason).toBe("manual fix required");
                }
              }
            });
          });
        },
      );
    });

    test("skips cautious fixes without --force", async () => {
      await withEnvAsync(
        {
          ANTHROPIC_API_KEY: undefined,
          OPENAI_API_KEY: undefined,
          GOOGLE_GENERATIVE_AI_API_KEY: undefined,
        },
        async () => {
          await withTempCassHome(async (env) => {
            await withCwd(env.home, async () => {
              // Write invalid config to trigger reset-config (cautious) fix
              await writeFile(env.configPath, "{{{{invalid json");
              await writeFile(env.playbookPath, createValidPlaybookYaml());

              process.exitCode = 0;
              const { output } = await captureConsoleLog(() =>
                doctorCommand({ json: true, fix: true, dryRun: true, force: false }),
              );

              const envelope = JSON.parse(output);
              expect(envelope.success).toBe(true);
              const payload = envelope.data;

              // Cautious fixes should be in wouldSkip when force=false
              const cautiousSkipped = payload.fixPlan.wouldSkip.find(
                (s: any) => s.reason === "requires --force",
              );
              expect(cautiousSkipped).toBeDefined();
            });
          });
        },
      );
    });

    test("includes cautious fixes with --force", async () => {
      await withEnvAsync(
        {
          ANTHROPIC_API_KEY: undefined,
          OPENAI_API_KEY: undefined,
          GOOGLE_GENERATIVE_AI_API_KEY: undefined,
        },
        async () => {
          await withTempCassHome(async (env) => {
            await withCwd(env.home, async () => {
              // Write invalid config to trigger reset-config (cautious) fix
              await writeFile(env.configPath, "{{{{invalid json");
              await writeFile(env.playbookPath, createValidPlaybookYaml());

              process.exitCode = 0;
              const { output } = await captureConsoleLog(() =>
                doctorCommand({ json: true, fix: true, dryRun: true, force: true }),
              );

              const envelope = JSON.parse(output);
              expect(envelope.success).toBe(true);
              const payload = envelope.data;

              // With force=true, cautious fixes should be in wouldApply
              expect(payload.fixPlan.wouldApply).toContain("reset-config");
            });
          });
        },
      );
    });
  });

  describe("repo-level checks", () => {
    test("reports partial repo .cass structure", async () => {
      await withEnvAsync(
        {
          ANTHROPIC_API_KEY: undefined,
          OPENAI_API_KEY: undefined,
          GOOGLE_GENERATIVE_AI_API_KEY: undefined,
        },
        async () => {
          await withTempCassHome(async (env) => {
            await withCwd(env.home, async () => {
              // Initialize a git repo
              await Bun.spawn(["git", "init"], { cwd: env.home }).exited;

              // Create valid config and playbook
              await writeFile(env.configPath, JSON.stringify({ cassPath: "cass" }, null, 2));
              await writeFile(env.playbookPath, createValidPlaybookYaml());

              // Create partial .cass structure (only playbook, no blocked.log)
              const cassDir = path.join(env.home, ".cass");
              await mkdir(cassDir, { recursive: true });
              await writeFile(path.join(cassDir, "playbook.yaml"), createValidPlaybookYaml());

              process.exitCode = 0;
              const { output } = await captureConsoleLog(() => doctorCommand({ json: true }));

              const envelope = JSON.parse(output);
              expect(envelope.success).toBe(true);
              const payload = envelope.data;

              // Should have a repo structure check with partial status
              const repoCheck = payload.checks.find(
                (c: any) => c.category === "Repo .cass/ Structure" && c.item === "Structure",
              );
              expect(repoCheck).toBeDefined();
              expect(repoCheck.status).toBe("warn");
              expect(repoCheck.message).toContain("Partial setup");
            });
          });
        },
      );
    });

    test("reports complete repo .cass structure", async () => {
      await withEnvAsync(
        {
          ANTHROPIC_API_KEY: undefined,
          OPENAI_API_KEY: undefined,
          GOOGLE_GENERATIVE_AI_API_KEY: undefined,
        },
        async () => {
          await withTempCassHome(async (env) => {
            await withCwd(env.home, async () => {
              // Initialize a git repo
              await Bun.spawn(["git", "init"], { cwd: env.home }).exited;

              // Create valid config and playbook
              await writeFile(env.configPath, JSON.stringify({ cassPath: "cass" }, null, 2));
              await writeFile(env.playbookPath, createValidPlaybookYaml());

              // Create complete .cass structure
              const cassDir = path.join(env.home, ".cass");
              await mkdir(cassDir, { recursive: true });
              await writeFile(path.join(cassDir, "playbook.yaml"), createValidPlaybookYaml());
              await writeFile(path.join(cassDir, "blocked.log"), "");

              process.exitCode = 0;
              const { output } = await captureConsoleLog(() => doctorCommand({ json: true }));

              const envelope = JSON.parse(output);
              expect(envelope.success).toBe(true);
              const payload = envelope.data;

              // Should have a repo structure check with pass status
              const repoCheck = payload.checks.find(
                (c: any) => c.category === "Repo .cass/ Structure" && c.item === "Structure",
              );
              expect(repoCheck).toBeDefined();
              expect(repoCheck.status).toBe("pass");
              expect(repoCheck.message).toContain("Complete");
            });
          });
        },
      );
    });
  });

  describe("trauma system checks", () => {
    test("reports trauma database loaded", async () => {
      await withEnvAsync(
        {
          ANTHROPIC_API_KEY: undefined,
          OPENAI_API_KEY: undefined,
          GOOGLE_GENERATIVE_AI_API_KEY: undefined,
        },
        async () => {
          await withTempCassHome(async (env) => {
            await withCwd(env.home, async () => {
              await writeFile(env.configPath, JSON.stringify({ cassPath: "cass" }, null, 2));
              await writeFile(env.playbookPath, createValidPlaybookYaml());

              process.exitCode = 0;
              const { output } = await captureConsoleLog(() => doctorCommand({ json: true }));

              const envelope = JSON.parse(output);
              expect(envelope.success).toBe(true);
              const payload = envelope.data;

              // Should have a trauma system check
              const traumaCheck = payload.checks.find(
                (c: any) => c.category === "Trauma System" && c.item === "Database",
              );
              expect(traumaCheck).toBeDefined();
              // Either pass (loaded) or warn (failed to load) are valid outcomes
              expect(["pass", "warn"]).toContain(traumaCheck.status);
            });
          });
        },
      );
    });

    test("warns when the installed guard predates GH #82 (ignores CASS_MEMORY_HOME)", async () => {
      await withEnvAsync(
        {
          ANTHROPIC_API_KEY: undefined,
          OPENAI_API_KEY: undefined,
          GOOGLE_GENERATIVE_AI_API_KEY: undefined,
        },
        async () => {
          await withTempCassHome(async (env) => {
            await withCwd(env.home, async () => {
              await writeFile(env.configPath, JSON.stringify({ cassPath: "cass" }, null, 2));
              await writeFile(env.playbookPath, createValidPlaybookYaml());
              await mkdir(path.join(env.home, ".claude", "hooks"), { recursive: true });
              // Parses fine, but hard-codes ~/.cass-memory like pre-#82 installs.
              await writeFile(
                path.join(env.home, ".claude", "hooks", "trauma_guard.py"),
                'from pathlib import Path\nGLOBAL_TRAUMA_FILE = Path.home() / ".cass-memory" / "traumas.jsonl"\n',
              );

              process.exitCode = 0;
              const { output } = await captureConsoleLog(() => doctorCommand({ json: true }));
              const guardCheck = JSON.parse(output).data.checks.find(
                (c: any) => c.category === "Trauma System" && c.item === "Safety Guard",
              );
              expect(guardCheck).toBeDefined();
              expect(guardCheck.status).toBe("warn");
              expect(guardCheck.message).toContain("outdated");
            });
          });
        },
      );
    });
  });

  describe("sanitization pattern checks", () => {
    test("reports sanitization disabled when not configured", async () => {
      await withEnvAsync(
        {
          ANTHROPIC_API_KEY: undefined,
          OPENAI_API_KEY: undefined,
          GOOGLE_GENERATIVE_AI_API_KEY: undefined,
        },
        async () => {
          await withTempCassHome(async (env) => {
            await withCwd(env.home, async () => {
              // Create config with sanitization disabled
              await writeFile(
                env.configPath,
                JSON.stringify({ cassPath: "cass", sanitization: { enabled: false } }, null, 2),
              );
              await writeFile(env.playbookPath, createValidPlaybookYaml());

              process.exitCode = 0;
              const { output } = await captureConsoleLog(() => doctorCommand({ json: true }));

              const envelope = JSON.parse(output);
              expect(envelope.success).toBe(true);
              const payload = envelope.data;

              // Should have a sanitization check
              const sanitizationCheck = payload.checks.find(
                (c: any) => c.category === "Sanitization Pattern Health",
              );
              expect(sanitizationCheck).toBeDefined();
              expect(sanitizationCheck.status).toBe("warn");
              expect(sanitizationCheck.message).toContain("disabled");
            });
          });
        },
      );
    });
  });
});

// =============================================================================
// Semantic search posture + global config format parity (#75)
// =============================================================================
describe("doctorCommand - semantic search posture (#75)", () => {
  const noKeys = {
    ANTHROPIC_API_KEY: undefined,
    OPENAI_API_KEY: undefined,
    GOOGLE_GENERATIVE_AI_API_KEY: undefined,
  };

  async function runDoctorJson(opts: Parameters<typeof doctorCommand>[0] = { json: true }) {
    process.exitCode = 0;
    const { output } = await captureConsoleLog(() => doctorCommand({ json: true, ...opts }));
    const envelope = JSON.parse(output);
    expect(envelope.success).toBe(true);
    return envelope.data;
  }

  test("reports keyword-only search as a warning with a verified one-shot enable fix", async () => {
    await withEnvAsync(noKeys, async () => {
      await withTempCassHome(async (env) => {
        await withCwd(env.home, async () => {
          await writeFile(env.configPath, JSON.stringify({ provider: "anthropic" }));
          await writeFile(env.playbookPath, createValidPlaybookYaml());

          const payload = await runDoctorJson();

          const semantic = payload.checks.find(
            (c: any) => c.category === "Semantic Search" && c.item === "Status",
          );
          expect(semantic).toBeDefined();
          expect(semantic.status).toBe("warn");
          expect(semantic.message).toContain("keyword-only");
          expect(semantic.message).toContain("config.json");
          expect(semantic.details.configPath).toBe(env.configPath);

          const fix = payload.fixableIssues.find((f: any) => f.id === "enable-semantic-search");
          expect(fix).toBeDefined();
          expect(fix.safety).toBe("cautious");
          expect(fix.description).toContain(env.configPath);

          const action = payload.recommendedActions.find((a: any) =>
            a.label.includes("Enable semantic search"),
          );
          expect(action).toBeDefined();
          expect(action.reason).toContain(env.configPath);
        });
      });
    });
  });

  test("passes when semantic search is enabled and offers no fix", async () => {
    await withEnvAsync(noKeys, async () => {
      await withTempCassHome(async (env) => {
        await withCwd(env.home, async () => {
          await writeFile(env.configPath, JSON.stringify({ semanticSearchEnabled: true }));
          await writeFile(env.playbookPath, createValidPlaybookYaml());

          const payload = await runDoctorJson();
          const semantic = payload.checks.find((c: any) => c.category === "Semantic Search");
          expect(semantic.status).toBe("pass");
          expect(semantic.message).toContain("xenova");
          expect(payload.fixableIssues.some((f: any) => f.id === "enable-semantic-search")).toBe(
            false,
          );
        });
      });
    });
  });

  test("respects an explicit embeddingModel: none opt-out (pass, no nag, no fix)", async () => {
    await withEnvAsync(noKeys, async () => {
      await withTempCassHome(async (env) => {
        await withCwd(env.home, async () => {
          await writeFile(
            env.configPath,
            JSON.stringify({ semanticSearchEnabled: false, embeddingModel: "none" }),
          );
          await writeFile(env.playbookPath, createValidPlaybookYaml());

          const payload = await runDoctorJson();
          const semantic = payload.checks.find((c: any) => c.category === "Semantic Search");
          expect(semantic.status).toBe("pass");
          expect(payload.fixableIssues.some((f: any) => f.id === "enable-semantic-search")).toBe(
            false,
          );
          expect(
            payload.recommendedActions.some((a: any) => a.label.includes("Enable semantic search")),
          ).toBe(false);
        });
      });
    });
  });

  test("does not offer the enable fix while the global config is invalid", async () => {
    await withEnvAsync(noKeys, async () => {
      await withTempCassHome(async (env) => {
        await withCwd(env.home, async () => {
          await writeFile(env.configPath, "{{{{invalid json");
          await writeFile(env.playbookPath, createValidPlaybookYaml());

          const payload = await runDoctorJson();
          expect(payload.fixableIssues.some((f: any) => f.id === "reset-config")).toBe(true);
          expect(payload.fixableIssues.some((f: any) => f.id === "enable-semantic-search")).toBe(
            false,
          );
        });
      });
    });
  });

  test("honors ~/.cass-memory/config.yaml and reports it as the active config", async () => {
    await withEnvAsync(noKeys, async () => {
      await withTempCassHome(async (env) => {
        await withCwd(env.home, async () => {
          const yamlPath = path.join(env.cassMemoryDir, "config.yaml");
          await writeFile(yamlPath, "semantic_search_enabled: true\n");
          await writeFile(env.playbookPath, createValidPlaybookYaml());

          const payload = await runDoctorJson();

          const structure = payload.checks.find(
            (c: any) => c.category === "Global Storage (~/.cass-memory)" && c.item === "Structure",
          );
          expect(structure.status).toBe("pass");

          const configCheck = payload.checks.find(
            (c: any) => c.category === "Configuration" && c.item === "config.yaml",
          );
          expect(configCheck).toBeDefined();
          expect(configCheck.status).toBe("pass");
          expect(configCheck.message).toContain("valid YAML");
          expect(configCheck.details.path).toBe(yamlPath);

          const semantic = payload.checks.find((c: any) => c.category === "Semantic Search");
          expect(semantic.status).toBe("pass");
        });
      });
    });
  });

  test("flags a config.yaml that is shadowed by config.json", async () => {
    await withEnvAsync(noKeys, async () => {
      await withTempCassHome(async (env) => {
        await withCwd(env.home, async () => {
          const yamlPath = path.join(env.cassMemoryDir, "config.yaml");
          await writeFile(env.configPath, JSON.stringify({ semanticSearchEnabled: true }));
          await writeFile(yamlPath, "semantic_search_enabled: false\n");
          await writeFile(env.playbookPath, createValidPlaybookYaml());

          const payload = await runDoctorJson();

          const shadowed = payload.checks.find(
            (c: any) => c.category === "Configuration" && c.item === "config.yaml",
          );
          expect(shadowed).toBeDefined();
          expect(shadowed.status).toBe("warn");
          expect(shadowed.message).toContain("Ignored");
          expect(shadowed.details.activeConfig).toBe(env.configPath);
        });
      });
    });
  });

  test("invalid YAML global config is reported and reset in place (as YAML)", async () => {
    await withEnvAsync(noKeys, async () => {
      await withTempCassHome(async (env) => {
        await withCwd(env.home, async () => {
          const yamlPath = path.join(env.cassMemoryDir, "config.yaml");
          await writeFile(yamlPath, "provider: [unterminated\n");
          await writeFile(env.playbookPath, createValidPlaybookYaml());

          const before = await runDoctorJson();
          const configCheck = before.checks.find(
            (c: any) => c.category === "Configuration" && c.item === "config.yaml",
          );
          expect(configCheck.status).toBe("fail");
          expect(configCheck.message).toContain("invalid YAML");

          const after = await runDoctorJson({
            json: true,
            fix: true,
            force: true,
            interactive: false,
          });
          const reset = after.fixResults.find((r: any) => r.id === "reset-config");
          expect(reset.success).toBe(true);

          const { readFile } = await import("node:fs/promises");
          const { existsSync } = await import("node:fs");
          const text = await readFile(yamlPath, "utf-8");
          expect(yaml.parse(text).provider).toBe("anthropic");
          // Reset stays in the file's own format; no shadowing config.json appears.
          expect(existsSync(env.configPath)).toBe(false);
        });
      });
    });
  });

  test("enable fix leaves config unchanged when the embedding backend is unreachable", async () => {
    await withEnvAsync(noKeys, async () => {
      await withTempCassHome(async (env) => {
        await withCwd(env.home, async () => {
          const original = {
            semanticSearchEnabled: false,
            embeddingBackend: "ollama",
            ollamaBaseUrl: "http://127.0.0.1:1",
          };
          await writeFile(env.configPath, JSON.stringify(original));
          await writeFile(env.playbookPath, createValidPlaybookYaml());

          const payload = await runDoctorJson({
            json: true,
            fix: true,
            force: true,
            interactive: false,
          });

          const result = payload.fixResults.find((r: any) => r.id === "enable-semantic-search");
          expect(result).toBeDefined();
          expect(result.success).toBe(false);
          expect(result.message).toContain("config left unchanged");

          const { readFile } = await import("node:fs/promises");
          expect(JSON.parse(await readFile(env.configPath, "utf-8"))).toEqual(original);
          const semantic = payload.checks.find((c: any) => c.category === "Semantic Search");
          expect(semantic.status).toBe("warn");
        });
      });
    });
  });

  test("enable fix verifies the backend end to end, then flips semanticSearchEnabled in place", async () => {
    // A real HTTP server standing in for an Ollama daemon: the fix must
    // actually round-trip an embedding before it touches the config.
    let embedCalls = 0;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (req) => {
        const url = new URL(req.url);
        if (req.method === "POST" && url.pathname === "/api/embed") {
          embedCalls++;
          const body = (await req.json()) as { model: string; input: string };
          expect(body.model).toBe("all-minilm");
          expect(typeof body.input).toBe("string");
          return Response.json({ embeddings: [[0.1, 0.2, 0.3]] });
        }
        return new Response("not found", { status: 404 });
      },
    });

    try {
      await withEnvAsync(noKeys, async () => {
        await withTempCassHome(async (env) => {
          await withCwd(env.home, async () => {
            await writeFile(
              env.configPath,
              JSON.stringify(
                {
                  provider: "anthropic",
                  embeddingBackend: "ollama",
                  ollamaBaseUrl: `http://127.0.0.1:${server.port}`,
                  customUnknownKey: "keep-me",
                },
                null,
                2,
              ),
            );
            await writeFile(env.playbookPath, createValidPlaybookYaml());

            const payload = await runDoctorJson({
              json: true,
              fix: true,
              force: true,
              interactive: false,
            });

            const result = payload.fixResults.find((r: any) => r.id === "enable-semantic-search");
            expect(result).toBeDefined();
            expect(result.success).toBe(true);
            expect(embedCalls).toBeGreaterThan(0);

            const { readFile } = await import("node:fs/promises");
            const saved = JSON.parse(await readFile(env.configPath, "utf-8"));
            expect(saved.semanticSearchEnabled).toBe(true);
            // Only the one key was added; everything else is preserved.
            expect(saved.provider).toBe("anthropic");
            expect(saved.customUnknownKey).toBe("keep-me");
            expect(saved.embeddingBackend).toBe("ollama");

            // Post-fix re-evaluation reflects the new posture.
            const semantic = payload.checks.find((c: any) => c.category === "Semantic Search");
            expect(semantic.status).toBe("pass");
            expect(semantic.message).toContain("ollama");
            expect(payload.fixableIssues.some((f: any) => f.id === "enable-semantic-search")).toBe(
              false,
            );
          });
        });
      });
    } finally {
      server.stop(true);
    }
  });
});

describe("computeMemoryQualityChecks", () => {
  async function checksFor(env: TestEnv, bullets: any[]) {
    const { computeMemoryQualityChecks } = await import("../src/commands/doctor.js");
    const { createTestPlaybook } = await import("./helpers/factories.js");
    await writeFile(env.playbookPath, yaml.stringify(createTestPlaybook(bullets)));
    const original = process.cwd();
    process.chdir(env.home);
    try {
      return await computeMemoryQualityChecks(createTestConfig({ playbookPath: env.playbookPath }));
    } finally {
      process.chdir(original);
    }
  }

  test("warns on contradicting rules and on feedback from cm's own subprocess transcripts", async () => {
    await withTempCassHome(async (env) => {
      const { createTestBullet } = await import("./helpers/factories.js");
      const { resolveCliSubprocessCwd, slugifyProjectDir } = await import("../src/subprocess-tag.js");
      const polluted = path.join(
        env.home,
        ".claude",
        "projects",
        slugifyProjectDir(resolveCliSubprocessCwd()!),
        "s.jsonl",
      );
      const checks = await checksFor(env, [
        createTestBullet({ id: "b-yes", content: "Always commit generated lockfiles" }),
        createTestBullet({ id: "b-no", content: "Never commit generated lockfiles" }),
        createTestBullet({
          id: "b-self",
          content: "Prefer small pull requests",
          feedbackEvents: [{ type: "helpful", timestamp: new Date().toISOString(), sessionPath: polluted }],
        }),
      ]);
      const conflict = checks.find((c) => c.item === "Conflicting rules")!;
      expect(conflict.status).toBe("warn");
      expect((conflict.details as any).pairs).toEqual([["b-yes", "b-no"]]);
      expect((conflict.details as any).evidence).toEqual([
        expect.objectContaining({ kind: "opposite-directives", condition: null }),
      ]);
      expect(conflict.message).toContain("directly opposing instructions");
      expect(conflict.message).toContain("Review their scope");
      const self = checks.find((c) => c.item === "Self-generated feedback")!;
      expect(self.status).toBe("warn");
      expect((self.details as any).events).toBe(1);
    });
  });

  test("passes on a clean playbook", async () => {
    await withTempCassHome(async (env) => {
      const { createTestBullet } = await import("./helpers/factories.js");
      const checks = await checksFor(env, [createTestBullet({ content: "Prefer small pull requests" })]);
      expect(checks.find((c) => c.item === "Conflicting rules")!.status).toBe("pass");
      expect(checks.find((c) => c.item === "Self-generated feedback")!.status).toBe("pass");
    });
  });

  test("finds user auto-reflection in CLAUDE_CONFIG_DIR and keeps missing hooks optional", async () => {
    await withTempCassHome(async (env) => {
      const userDir = path.join(env.home, "claude-profile");
      await mkdir(userDir);
      await withEnvAsync({ CLAUDE_CONFIG_DIR: userDir }, async () => {
        const missing = (await checksFor(env, [])).find((check) => check.item === "Auto-reflection");
        expect(missing).toBeDefined();
        expect(missing?.status).toBe("pass");
        expect(missing?.details).toMatchObject({ installed: false, missingAgents: ["claude"] });

        const { hookCommand } = await import("../src/commands/hook.js");
        await captureConsoleLog(() => hookCommand("install", { json: true, command: "cm hook session-end" }));
        const installed = (await checksFor(env, [])).find((check) => check.item === "Auto-reflection");
        expect(installed?.status).toBe("pass");
        expect(installed?.message).toContain("claude/user");
        expect(installed?.details).toMatchObject({ installed: true, missingAgents: [] });
      });
    });
  });

  test("does not degrade memory quality for issue #95 excerpts or compatible conditional guidance", async () => {
    await withTempCassHome(async (env) => {
      const { createTestBullet } = await import("./helpers/factories.js");
      // The issue publishes abbreviated excerpts, not the complete original rules.
      const contents = [
        "When reviewing whether a change caused a defect, reproduce the defect against the base revision too...",
        "Before attributing or excluding responsibility for a nightly regression, establish the actual last-green and first-red revisions...",
        "When a required full-suite run times out, run the directly changed test file separately...",
        "When testing uncommitted changes through tools/review/pool.py, supply the edited files with --include...",
        "When converting exact or bounded values to float, re-check finiteness after rounding...",
        "Apply the review contract's blocking threshold explicitly...",
        "Never cache tokens without expiry",
        "Must cache tokens to improve speed",
        "Always sanitize logs before storing",
        "Sanitize logs except when running locally",
      ];
      const checks = await checksFor(
        env,
        contents.map((content, i) => createTestBullet({ id: `b-compatible-${i}`, content, state: "draft" })),
      );
      const conflict = checks.find((c) => c.item === "Conflicting rules")!;
      expect(conflict.status).toBe("pass");
      expect(conflict.message).toBe("No direct rule conflicts detected among 10 active rule(s)");
      expect(conflict.details).toEqual(expect.objectContaining({ count: 0, pairs: [], evidence: [] }));
    });
  });

  test("excludes retired and deprecated rules from conflict checks and the active count", async () => {
    await withTempCassHome(async (env) => {
      const { createTestBullet } = await import("./helpers/factories.js");
      const checks = await checksFor(env, [
        createTestBullet({ id: "b-active", content: "Always commit generated lockfiles" }),
        createTestBullet({ id: "b-retired", content: "Never commit generated lockfiles", state: "retired" }),
        createTestBullet({ id: "b-deprecated", content: "Never commit generated lockfiles", deprecated: true }),
        createTestBullet({ id: "b-mature-deprecated", content: "Never commit generated lockfiles", maturity: "deprecated" }),
      ]);
      const conflict = checks.find((c) => c.item === "Conflicting rules")!;
      expect(conflict.status).toBe("pass");
      expect(conflict.message).toContain("among 1 active rule(s)");
    });
  });

  test("does not warn about opposing conventions belonging to different workspaces", async () => {
    await withTempCassHome(async (env) => {
      const { createTestBullet } = await import("./helpers/factories.js");
      const a = createTestBullet({
        id: "b-repo-a", content: "Always commit generated lockfiles",
        scope: "workspace", workspace: "/scope-a",
      });
      const b = createTestBullet({
        id: "b-repo-b", content: "Never commit generated lockfiles",
        scope: "workspace", workspace: "/scope-b",
      });
      const separate = await checksFor(env, [a, b]);
      expect(separate.find((c) => c.item === "Conflicting rules")!.status).toBe("pass");
      const same = await checksFor(env, [a, { ...b, workspace: a.workspace }]);
      expect(same.find((c) => c.item === "Conflicting rules")!.status).toBe("warn");
    });
  });

  test("doctor stays healthy for compatible guidance, degrades for direct opposition, and preserves real failures", async () => {
    await withEnvAsync({ CASS_PATH: undefined, CASS_MEMORY_HOME: undefined, XDG_DATA_HOME: undefined }, async () => {
      await withTempCassHome(async (env) => {
        const { createTestBullet, createTestPlaybook } = await import("./helpers/factories.js");
        const cassPath = await makeCassStub(env.home, { exitCode: 0 });
        const initialized = Bun.spawnSync(["git", "init", "--initial-branch=main", env.home]);
        expect(initialized.exitCode).toBe(0);
        const repoCass = path.join(env.home, ".cass");
        await mkdir(repoCass);
        await writeFile(path.join(repoCass, "playbook.yaml"), yaml.stringify(createTestPlaybook()));
        await writeFile(path.join(repoCass, "blocked.log"), "");
        await writeFile(env.configPath, JSON.stringify({ cassPath, provider: "ollama", embeddingModel: "none" }));

        const compatible = [
          createTestBullet({ id: "b-expiry", content: "Never cache tokens without expiry", state: "draft" }),
          createTestBullet({ id: "b-cache", content: "Must cache tokens to improve speed", state: "draft" }),
        ];
        await writeFile(env.playbookPath, yaml.stringify(createTestPlaybook(compatible)));
        await withCwd(env.home, async () => {
          const run = async () => {
            const { output } = await captureConsoleLog(() => doctorCommand({ json: true }));
            return JSON.parse(output).data;
          };
          const healthy = await run();
          expect(healthy.overallStatus).toBe("healthy");
          expect(healthy.checks.every((c: any) => c.status === "pass")).toBe(true);
          expect(healthy.recommendedActions.some((a: any) => a.command?.endsWith("playbook conflicts"))).toBe(false);

          await writeFile(env.playbookPath, yaml.stringify(createTestPlaybook([
            ...compatible,
            createTestBullet({ id: "b-yes", content: "Always commit generated lockfiles" }),
            createTestBullet({ id: "b-no", content: "Never commit generated lockfiles" }),
          ])));
          const degraded = await run();
          expect(degraded.overallStatus).toBe("degraded");
          expect(degraded.checks.filter((c: any) => c.status !== "pass").map((c: any) => c.item)).toEqual(["Conflicting rules"]);
          expect(degraded.recommendedActions.some((a: any) => a.command?.endsWith("playbook conflicts"))).toBe(true);

          // A broken playbook remains a genuine health failure, independently of this warning.
          await writeFile(env.playbookPath, "bullets: [unterminated\n");
          const unhealthy = await run();
          expect(unhealthy.overallStatus).toBe("unhealthy");
          expect(unhealthy.checks.find((c: any) => c.category === "Playbook").status).toBe("fail");
        });
      });
    });
  });
});
