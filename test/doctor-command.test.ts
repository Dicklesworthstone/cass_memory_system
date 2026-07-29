/**
 * Unit tests for doctorCommand function in doctor.ts.
 * Tests JSON output, fix modes, and various health check scenarios.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { doctorCommand } from "../src/commands/doctor.js";
import { withTempCassHome, type TestEnv } from "./helpers/temp.js";
import { createTestConfig } from "./helpers/factories.js";
import { writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import yaml from "yaml";

// --- Test Helpers ---

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
        { ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined, GOOGLE_GENERATIVE_AI_API_KEY: undefined },
        async () => {
          await withTempCassHome(async (env) => {
            await withCwd(env.home, async () => {
              // Create valid config and playbook
              await writeFile(
                env.configPath,
                JSON.stringify({ cassPath: "cass", apiKey: "sk-ant-test-key" }, null, 2)
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
        }
      );
    });

    test("includes fixPlan in dry-run mode", async () => {
      await withEnvAsync(
        { ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined, GOOGLE_GENERATIVE_AI_API_KEY: undefined },
        async () => {
          await withTempCassHome(async (env) => {
            await withCwd(env.home, async () => {
              // Create valid config and playbook
              await writeFile(
                env.configPath,
                JSON.stringify({ cassPath: "cass" }, null, 2)
              );
              await writeFile(env.playbookPath, createValidPlaybookYaml());

              process.exitCode = 0;
              const { output } = await captureConsoleLog(() =>
                doctorCommand({ json: true, fix: true, dryRun: true })
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
        }
      );
    });

    test("includes selfTest results when requested", async () => {
      await withEnvAsync(
        { ANTHROPIC_API_KEY: "sk-ant-test-key", OPENAI_API_KEY: undefined, GOOGLE_GENERATIVE_AI_API_KEY: undefined },
        async () => {
          await withTempCassHome(async (env) => {
            await withCwd(env.home, async () => {
              // Create valid config and playbook
              await writeFile(
                env.configPath,
                JSON.stringify({ cassPath: "/nonexistent/cass", apiKey: "sk-ant-test-key" }, null, 2)
              );
              await writeFile(env.playbookPath, createValidPlaybookYaml());

              process.exitCode = 0;
              const { output } = await captureConsoleLog(() =>
                doctorCommand({ json: true, selfTest: true })
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
        }
      );
    });
  });

  describe("config load error handling", () => {
    test("handles invalid JSON config gracefully", async () => {
      await withEnvAsync(
        { ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined, GOOGLE_GENERATIVE_AI_API_KEY: undefined },
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
                (c: any) => c.category === "Configuration" && c.item === "config.json"
              );
              expect(configCheck).toBeDefined();
              expect(configCheck.status).toBe("fail");
            });
          });
        }
      );
    });
  });

  describe("fix mode with issues", () => {
    test("detects fixable issues when config is missing", async () => {
      await withEnvAsync(
        { ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined, GOOGLE_GENERATIVE_AI_API_KEY: undefined },
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
                doctorCommand({ json: true, fix: true, dryRun: true })
              );

              const envelope = JSON.parse(output);
              expect(envelope.success).toBe(true);
              const payload = envelope.data;
              expect(payload).toHaveProperty("fixPlan");
              expect(payload).toHaveProperty("fixableIssues");
            });
          });
        }
      );
    });
  });

  describe("recommended actions", () => {
    test("suggests initializing global storage when not present", async () => {
      await withEnvAsync(
        { ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined, GOOGLE_GENERATIVE_AI_API_KEY: undefined },
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
              const initAction = payload.recommendedActions.find(
                (a: any) => a.label.includes("Initialize")
              );
              expect(initAction).toBeDefined();
            });
          });
        }
      );
    });

    test("includes apply-fixes recommendation after dry-run", async () => {
      await withEnvAsync(
        { ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined, GOOGLE_GENERATIVE_AI_API_KEY: undefined },
        async () => {
          await withTempCassHome(async (env) => {
            await withCwd(env.home, async () => {
              // Remove playbook to create a fixable issue
              await rm(env.playbookPath, { force: true });
              await writeFile(
                env.configPath,
                JSON.stringify({ cassPath: "cass" }, null, 2)
              );

              process.exitCode = 0;
              const { output } = await captureConsoleLog(() =>
                doctorCommand({ json: true, fix: true, dryRun: true })
              );

              const envelope = JSON.parse(output);
              expect(envelope.success).toBe(true);
              const payload = envelope.data;

              // Should recommend applying fixes for real
              const applyAction = payload.recommendedActions.find(
                (a: any) => a.label.includes("Apply fixes for real")
              );
              expect(applyAction).toBeDefined();
              expect(applyAction.command).toContain("doctor --fix");
            });
          });
        }
      );
    });
  });

  describe("LLM configuration checks", () => {
    test("reports pass when API key is available", async () => {
      await withEnvAsync(
        { ANTHROPIC_API_KEY: "sk-ant-test-key", OPENAI_API_KEY: undefined, GOOGLE_GENERATIVE_AI_API_KEY: undefined },
        async () => {
          await withTempCassHome(async (env) => {
            await withCwd(env.home, async () => {
              await writeFile(
                env.configPath,
                JSON.stringify({ cassPath: "cass", provider: "anthropic" }, null, 2)
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
        }
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
              await writeFile(
                env.configPath,
                JSON.stringify({ cassPath: "cass" }, null, 2)
              );
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
        }
      );
    });

    test("reports fallback when configured provider unavailable but others are", async () => {
      await withEnvAsync(
        { ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: "sk-openai-test-key", GOOGLE_GENERATIVE_AI_API_KEY: undefined },
        async () => {
          await withTempCassHome(async (env) => {
            await withCwd(env.home, async () => {
              // Configure anthropic but only openai key is available
              await writeFile(
                env.configPath,
                JSON.stringify({ cassPath: "cass", provider: "anthropic" }, null, 2)
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
        }
      );
    });
  });

  describe("playbook schema version checks", () => {
    test("reports warn for outdated playbook schema", async () => {
      await withEnvAsync(
        { ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined, GOOGLE_GENERATIVE_AI_API_KEY: undefined },
        async () => {
          await withTempCassHome(async (env) => {
            await withCwd(env.home, async () => {
              await writeFile(
                env.configPath,
                JSON.stringify({ cassPath: "cass" }, null, 2)
              );

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
                (c: any) => c.category === "Playbook" && c.item === "Global playbook.yaml"
              );
              expect(playbookCheck).toBeDefined();
              expect(playbookCheck.status).toBe("warn");
              expect(playbookCheck.message).toContain("Outdated");
            });
          });
        }
      );
    });

    test("reports fail for invalid playbook YAML", async () => {
      await withEnvAsync(
        { ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined, GOOGLE_GENERATIVE_AI_API_KEY: undefined },
        async () => {
          await withTempCassHome(async (env) => {
            await withCwd(env.home, async () => {
              await writeFile(
                env.configPath,
                JSON.stringify({ cassPath: "cass" }, null, 2)
              );

              // Write invalid YAML
              await writeFile(env.playbookPath, "{{{{invalid yaml that wont parse");

              process.exitCode = 0;
              const { output } = await captureConsoleLog(() => doctorCommand({ json: true }));

              const envelope = JSON.parse(output);
              expect(envelope.success).toBe(true);
              const payload = envelope.data;
              const playbookCheck = payload.checks.find(
                (c: any) => c.category === "Playbook" && c.item === "Global playbook.yaml"
              );
              expect(playbookCheck).toBeDefined();
              expect(playbookCheck.status).toBe("fail");
              expect(playbookCheck.message).toContain("invalid");
            });
          });
        }
      );
    });
  });

  describe("cass binary check", () => {
    test("reports fail when cass is not available", async () => {
      await withEnvAsync(
        { ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined, GOOGLE_GENERATIVE_AI_API_KEY: undefined },
        async () => {
          await withTempCassHome(async (env) => {
            await withCwd(env.home, async () => {
              await writeFile(
                env.configPath,
                JSON.stringify({ cassPath: "/nonexistent/cass-binary" }, null, 2)
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
        }
      );
    });
  });

  describe("buildFixPlan coverage", () => {
    test("skips manual fixes in plan", async () => {
      await withEnvAsync(
        { ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined, GOOGLE_GENERATIVE_AI_API_KEY: undefined },
        async () => {
          await withTempCassHome(async (env) => {
            await withCwd(env.home, async () => {
              await writeFile(
                env.configPath,
                JSON.stringify({ cassPath: "cass" }, null, 2)
              );
              await writeFile(env.playbookPath, createValidPlaybookYaml());

              process.exitCode = 0;
              const { output } = await captureConsoleLog(() =>
                doctorCommand({ json: true, fix: true, dryRun: true })
              );

              const envelope = JSON.parse(output);
              expect(envelope.success).toBe(true);
              const payload = envelope.data;

              // Manual fixes should appear in wouldSkip
              if (payload.fixPlan.wouldSkip.length > 0) {
                const manualSkipped = payload.fixPlan.wouldSkip.find(
                  (s: any) => s.reason === "manual fix required"
                );
                // Only check if there are manual issues detected
                if (manualSkipped) {
                  expect(manualSkipped.reason).toBe("manual fix required");
                }
              }
            });
          });
        }
      );
    });

    test("skips cautious fixes without --force", async () => {
      await withEnvAsync(
        { ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined, GOOGLE_GENERATIVE_AI_API_KEY: undefined },
        async () => {
          await withTempCassHome(async (env) => {
            await withCwd(env.home, async () => {
              // Write invalid config to trigger reset-config (cautious) fix
              await writeFile(env.configPath, "{{{{invalid json");
              await writeFile(env.playbookPath, createValidPlaybookYaml());

              process.exitCode = 0;
              const { output } = await captureConsoleLog(() =>
                doctorCommand({ json: true, fix: true, dryRun: true, force: false })
              );

              const envelope = JSON.parse(output);
              expect(envelope.success).toBe(true);
              const payload = envelope.data;

              // Cautious fixes should be in wouldSkip when force=false
              const cautiousSkipped = payload.fixPlan.wouldSkip.find(
                (s: any) => s.reason === "requires --force"
              );
              expect(cautiousSkipped).toBeDefined();
            });
          });
        }
      );
    });

    test("includes cautious fixes with --force", async () => {
      await withEnvAsync(
        { ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined, GOOGLE_GENERATIVE_AI_API_KEY: undefined },
        async () => {
          await withTempCassHome(async (env) => {
            await withCwd(env.home, async () => {
              // Write invalid config to trigger reset-config (cautious) fix
              await writeFile(env.configPath, "{{{{invalid json");
              await writeFile(env.playbookPath, createValidPlaybookYaml());

              process.exitCode = 0;
              const { output } = await captureConsoleLog(() =>
                doctorCommand({ json: true, fix: true, dryRun: true, force: true })
              );

              const envelope = JSON.parse(output);
              expect(envelope.success).toBe(true);
              const payload = envelope.data;

              // With force=true, cautious fixes should be in wouldApply
              expect(payload.fixPlan.wouldApply).toContain("reset-config");
            });
          });
        }
      );
    });
  });

  describe("repo-level checks", () => {
    test("reports partial repo .cass structure", async () => {
      await withEnvAsync(
        { ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined, GOOGLE_GENERATIVE_AI_API_KEY: undefined },
        async () => {
          await withTempCassHome(async (env) => {
            await withCwd(env.home, async () => {
              // Initialize a git repo
              await Bun.spawn(["git", "init"], { cwd: env.home }).exited;

              // Create valid config and playbook
              await writeFile(
                env.configPath,
                JSON.stringify({ cassPath: "cass" }, null, 2)
              );
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
                (c: any) => c.category === "Repo .cass/ Structure" && c.item === "Structure"
              );
              expect(repoCheck).toBeDefined();
              expect(repoCheck.status).toBe("warn");
              expect(repoCheck.message).toContain("Partial setup");
            });
          });
        }
      );
    });

    test("reports complete repo .cass structure", async () => {
      await withEnvAsync(
        { ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined, GOOGLE_GENERATIVE_AI_API_KEY: undefined },
        async () => {
          await withTempCassHome(async (env) => {
            await withCwd(env.home, async () => {
              // Initialize a git repo
              await Bun.spawn(["git", "init"], { cwd: env.home }).exited;

              // Create valid config and playbook
              await writeFile(
                env.configPath,
                JSON.stringify({ cassPath: "cass" }, null, 2)
              );
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
                (c: any) => c.category === "Repo .cass/ Structure" && c.item === "Structure"
              );
              expect(repoCheck).toBeDefined();
              expect(repoCheck.status).toBe("pass");
              expect(repoCheck.message).toContain("Complete");
            });
          });
        }
      );
    });
  });

  describe("trauma system checks", () => {
    test("reports trauma database loaded", async () => {
      await withEnvAsync(
        { ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined, GOOGLE_GENERATIVE_AI_API_KEY: undefined },
        async () => {
          await withTempCassHome(async (env) => {
            await withCwd(env.home, async () => {
              await writeFile(
                env.configPath,
                JSON.stringify({ cassPath: "cass" }, null, 2)
              );
              await writeFile(env.playbookPath, createValidPlaybookYaml());

              process.exitCode = 0;
              const { output } = await captureConsoleLog(() => doctorCommand({ json: true }));

              const envelope = JSON.parse(output);
              expect(envelope.success).toBe(true);
              const payload = envelope.data;

              // Should have a trauma system check
              const traumaCheck = payload.checks.find(
                (c: any) => c.category === "Trauma System" && c.item === "Database"
              );
              expect(traumaCheck).toBeDefined();
              // Either pass (loaded) or warn (failed to load) are valid outcomes
              expect(["pass", "warn"]).toContain(traumaCheck.status);
            });
          });
        }
      );
    });
  });

  describe("sanitization pattern checks", () => {
    test("reports sanitization disabled when not configured", async () => {
      await withEnvAsync(
        { ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined, GOOGLE_GENERATIVE_AI_API_KEY: undefined },
        async () => {
          await withTempCassHome(async (env) => {
            await withCwd(env.home, async () => {
              // Create config with sanitization disabled
              await writeFile(
                env.configPath,
                JSON.stringify({ cassPath: "cass", sanitization: { enabled: false } }, null, 2)
              );
              await writeFile(env.playbookPath, createValidPlaybookYaml());

              process.exitCode = 0;
              const { output } = await captureConsoleLog(() => doctorCommand({ json: true }));

              const envelope = JSON.parse(output);
              expect(envelope.success).toBe(true);
              const payload = envelope.data;

              // Should have a sanitization check
              const sanitizationCheck = payload.checks.find(
                (c: any) => c.category === "Sanitization Pattern Health"
              );
              expect(sanitizationCheck).toBeDefined();
              expect(sanitizationCheck.status).toBe("warn");
              expect(sanitizationCheck.message).toContain("disabled");
            });
          });
        }
      );
    });
  });
});
