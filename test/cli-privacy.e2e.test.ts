/**
 * E2E Tests for CLI privacy command - Cross-agent settings
 */
import { describe, it, expect } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { privacyCommand } from "../src/commands/privacy.js";
import { loadConfig } from "../src/config.js";
import { withTempCassHome, type TestEnv } from "./helpers/temp.js";
import { createE2ELogger } from "./helpers/e2e-logger.js";
import { createTestConfig } from "./helpers/factories.js";

function captureConsole() {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;

  console.log = (...args: any[]) => {
    logs.push(args.map(String).join(" "));
  };
  console.error = (...args: any[]) => {
    errors.push(args.map(String).join(" "));
  };

  return {
    logs,
    errors,
    restore: () => {
      console.log = originalLog;
      console.error = originalError;
    },
  };
}

async function writeTestConfig(env: TestEnv): Promise<void> {
  const config = createTestConfig({
    cassPath: "__cass_not_installed__",
    playbookPath: env.playbookPath,
    diaryDir: env.diaryDir,
    crossAgent: {
      enabled: false,
      consentGiven: false,
      consentDate: null,
      agents: [],
      auditLog: true,
    },
    verbose: false,
    jsonOutput: false,
  });
  await writeFile(env.configPath, JSON.stringify(config, null, 2), "utf-8");
}

async function snapshotConfig(log: ReturnType<typeof createE2ELogger>, env: TestEnv, name: string): Promise<void> {
  const contents = await readFile(env.configPath, "utf-8").catch(() => "");
  log.snapshot(name, contents);
}

async function withNoColor<T>(fn: () => Promise<T>): Promise<T> {
  const originalNoColor = process.env.NO_COLOR;
  const originalForceColor = process.env.FORCE_COLOR;
  process.env.NO_COLOR = "1";
  process.env.FORCE_COLOR = "0";
  try {
    return await fn();
  } finally {
    process.env.NO_COLOR = originalNoColor;
    process.env.FORCE_COLOR = originalForceColor;
  }
}

async function withCwd<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
  const originalCwd = process.cwd();
  process.chdir(cwd);
  try {
    return await fn();
  } finally {
    process.chdir(originalCwd);
  }
}

describe("E2E: CLI privacy command", () => {
  it.serial("shows current settings", async () => {
    const log = createE2ELogger("cli-privacy: status");
    log.setRepro("bun test test/cli-privacy.e2e.test.ts");

    await log.run(async () => {
      await withTempCassHome(async (env) => {
        await writeTestConfig(env);
        await snapshotConfig(log, env, "config.before");

        const capture = captureConsole();
        try {
          await withNoColor(async () => {
            await withCwd(env.home, async () => {
              log.step("Run command", { command: "cm privacy status --json --days 7" });
              await privacyCommand("status", [], { json: true, days: 7 });
            });
          });
        } finally {
          capture.restore();
        }

        const stdout = capture.logs.join("\n");
        log.snapshot("stdout", stdout);
        const payload = JSON.parse(stdout);
        await snapshotConfig(log, env, "config.after");

        expect(payload.success).toBe(true);
        expect(payload.command).toBe("privacy:status");
        expect(payload.data.crossAgent.enabled).toBe(false);
        expect(payload.data.cass.available).toBe(false);
        expect(payload.data.cass.timelineDays).toBe(7);
      });
    });
  });

  it.serial("changes persist and affect loadConfig()", async () => {
    const log = createE2ELogger("cli-privacy: enable/allow/deny/disable");
    log.setRepro("bun test test/cli-privacy.e2e.test.ts");

    await log.run(async () => {
      await withTempCassHome(async (env) => {
        await writeTestConfig(env);

        const runJson = async (action: Parameters<typeof privacyCommand>[0], args: string[] = []) => {
          const capture = captureConsole();
          try {
            await withNoColor(async () => {
              await withCwd(env.home, async () => {
                log.step("Run command", { command: `cm privacy ${action} ${args.join(" ")} --json` });
                await privacyCommand(action, args, { json: true, days: 7 });
              });
            });
          } finally {
            capture.restore();
          }
          const stdout = capture.logs.join("\n");
          log.snapshot(`stdout.${action}`, stdout);
          return JSON.parse(stdout);
        };

        await snapshotConfig(log, env, "config.before");

        const enabled = await runJson("enable", ["claude"]);
        expect(enabled.success).toBe(true);
        expect(enabled.command).toBe("privacy:enable");
        expect(enabled.data.crossAgent.enabled).toBe(true);
        expect(enabled.data.crossAgent.consentGiven).toBe(true);
        expect(enabled.data.crossAgent.agents).toContain("claude");
        await snapshotConfig(log, env, "config.afterEnable");

        const allowed = await runJson("allow", ["cursor"]);
        expect(allowed.success).toBe(true);
        expect(allowed.command).toBe("privacy:allow");
        expect(allowed.data.crossAgent.agents).toEqual(expect.arrayContaining(["claude", "cursor"]));
        await snapshotConfig(log, env, "config.afterAllow");

        const denied = await runJson("deny", ["claude"]);
        expect(denied.success).toBe(true);
        expect(denied.command).toBe("privacy:deny");
        expect(denied.data.crossAgent.agents).not.toContain("claude");
        await snapshotConfig(log, env, "config.afterDeny");

        const loaded = await withCwd(env.home, async () => loadConfig());
        expect(loaded.crossAgent.enabled).toBe(true);
        expect(loaded.crossAgent.agents).toContain("cursor");

        const disabled = await runJson("disable");
        expect(disabled.success).toBe(true);
        expect(disabled.command).toBe("privacy:disable");
        expect(disabled.data.crossAgent.enabled).toBe(false);
        await snapshotConfig(log, env, "config.afterDisable");

        const loadedAfter = await withCwd(env.home, async () => loadConfig());
        expect(loadedAfter.crossAgent.enabled).toBe(false);
      });
    });
  });

  it.serial("rejects invalid days parameter", async () => {
    const log = createE2ELogger("cli-privacy: invalid days");
    log.setRepro("bun test test/cli-privacy.e2e.test.ts");

    await log.run(async () => {
      await withTempCassHome(async (env) => {
        await writeTestConfig(env);

        const capture = captureConsole();
        try {
          await withNoColor(async () => {
            await withCwd(env.home, async () => {
              log.step("Run command with invalid days", { days: -5 });
              await privacyCommand("status", [], { json: true, days: -5 });
            });
          });
        } finally {
          capture.restore();
        }

        const stdout = capture.logs.join("\n");
        log.snapshot("stdout", stdout);
        const payload = JSON.parse(stdout);

        expect(payload.success).toBe(false);
        expect(payload.error.code).toBe("INVALID_INPUT");
        expect(payload.error.message).toContain("days");
      });
    });
  });

  it.serial("allow without agent reports error", async () => {
    const log = createE2ELogger("cli-privacy: allow no agent");
    log.setRepro("bun test test/cli-privacy.e2e.test.ts");

    await log.run(async () => {
      await withTempCassHome(async (env) => {
        await writeTestConfig(env);

        const capture = captureConsole();
        try {
          await withNoColor(async () => {
            await withCwd(env.home, async () => {
              log.step("Run allow without agent");
              await privacyCommand("allow", [], { json: true });
            });
          });
        } finally {
          capture.restore();
        }

        const stdout = capture.logs.join("\n");
        log.snapshot("stdout", stdout);
        const payload = JSON.parse(stdout);

        expect(payload.success).toBe(false);
        expect(payload.error.code).toBe("MISSING_REQUIRED");
        expect(payload.error.message).toContain("requires");
      });
    });
  });

  it.serial("deny without agent reports error", async () => {
    const log = createE2ELogger("cli-privacy: deny no agent");
    log.setRepro("bun test test/cli-privacy.e2e.test.ts");

    await log.run(async () => {
      await withTempCassHome(async (env) => {
        await writeTestConfig(env);

        const capture = captureConsole();
        try {
          await withNoColor(async () => {
            await withCwd(env.home, async () => {
              log.step("Run deny without agent");
              await privacyCommand("deny", [], { json: true });
            });
          });
        } finally {
          capture.restore();
        }

        const stdout = capture.logs.join("\n");
        log.snapshot("stdout", stdout);
        const payload = JSON.parse(stdout);

        expect(payload.success).toBe(false);
        expect(payload.error.code).toBe("MISSING_REQUIRED");
        expect(payload.error.message).toContain("requires");
      });
    });
  });

  it.serial("human-readable status output", async () => {
    const log = createE2ELogger("cli-privacy: human status");
    log.setRepro("bun test test/cli-privacy.e2e.test.ts");

    await log.run(async () => {
      await withTempCassHome(async (env) => {
        await writeTestConfig(env);

        const capture = captureConsole();
        try {
          await withNoColor(async () => {
            await withCwd(env.home, async () => {
              log.step("Run status without --json");
              await privacyCommand("status", [], { days: 7 });
            });
          });
        } finally {
          capture.restore();
        }

        const stdout = capture.logs.join("\n");
        log.snapshot("stdout", stdout);

        // Verify human-readable output elements
        expect(stdout).toContain("Privacy Status");
        expect(stdout).toContain("Cross-agent enrichment:");
        expect(stdout).toContain("Consent given:");
        expect(stdout).toContain("Allowlist:");
        expect(stdout).toContain("privacy enable");
        expect(stdout).toContain("privacy disable");
      });
    });
  });

  it.serial("human-readable enable output", async () => {
    const log = createE2ELogger("cli-privacy: human enable");
    log.setRepro("bun test test/cli-privacy.e2e.test.ts");

    await log.run(async () => {
      await withTempCassHome(async (env) => {
        await writeTestConfig(env);

        const capture = captureConsole();
        try {
          await withNoColor(async () => {
            await withCwd(env.home, async () => {
              log.step("Run enable without --json");
              await privacyCommand("enable", ["claude", "cursor"], {});
            });
          });
        } finally {
          capture.restore();
        }

        const stdout = capture.logs.join("\n");
        log.snapshot("stdout", stdout);

        expect(stdout).toContain("Cross-agent enrichment enabled");
        expect(stdout).toContain("Allowlist:");
      });
    });
  });

  it.serial("human-readable disable output", async () => {
    const log = createE2ELogger("cli-privacy: human disable");
    log.setRepro("bun test test/cli-privacy.e2e.test.ts");

    await log.run(async () => {
      await withTempCassHome(async (env) => {
        await writeTestConfig(env);

        // First enable
        const capture1 = captureConsole();
        try {
          await withNoColor(async () => {
            await withCwd(env.home, async () => {
              await privacyCommand("enable", ["claude"], { json: true });
            });
          });
        } finally {
          capture1.restore();
        }

        // Then disable with human output
        const capture2 = captureConsole();
        try {
          await withNoColor(async () => {
            await withCwd(env.home, async () => {
              log.step("Run disable without --json");
              await privacyCommand("disable", [], {});
            });
          });
        } finally {
          capture2.restore();
        }

        const stdout = capture2.logs.join("\n");
        log.snapshot("stdout", stdout);

        expect(stdout).toContain("Cross-agent enrichment disabled");
      });
    });
  });

  it.serial("human-readable allow output", async () => {
    const log = createE2ELogger("cli-privacy: human allow");
    log.setRepro("bun test test/cli-privacy.e2e.test.ts");

    await log.run(async () => {
      await withTempCassHome(async (env) => {
        await writeTestConfig(env);

        const capture = captureConsole();
        try {
          await withNoColor(async () => {
            await withCwd(env.home, async () => {
              log.step("Run allow without --json");
              await privacyCommand("allow", ["gemini"], {});
            });
          });
        } finally {
          capture.restore();
        }

        const stdout = capture.logs.join("\n");
        log.snapshot("stdout", stdout);

        expect(stdout).toContain("Allowed agent");
        expect(stdout).toContain("gemini");
        expect(stdout).toContain("Allowlist:");
      });
    });
  });

  it.serial("human-readable deny output", async () => {
    const log = createE2ELogger("cli-privacy: human deny");
    log.setRepro("bun test test/cli-privacy.e2e.test.ts");

    await log.run(async () => {
      await withTempCassHome(async (env) => {
        await writeTestConfig(env);

        // First add an agent
        const capture1 = captureConsole();
        try {
          await withNoColor(async () => {
            await withCwd(env.home, async () => {
              await privacyCommand("allow", ["cursor"], { json: true });
            });
          });
        } finally {
          capture1.restore();
        }

        // Then deny with human output
        const capture2 = captureConsole();
        try {
          await withNoColor(async () => {
            await withCwd(env.home, async () => {
              log.step("Run deny without --json");
              await privacyCommand("deny", ["cursor"], {});
            });
          });
        } finally {
          capture2.restore();
        }

        const stdout = capture2.logs.join("\n");
        log.snapshot("stdout", stdout);

        expect(stdout).toContain("Removed agent");
        expect(stdout).toContain("cursor");
        expect(stdout).toContain("Allowlist:");
      });
    });
  });

  it.serial("handles deprecated llm config migration", async () => {
    const log = createE2ELogger("cli-privacy: llm migration");
    log.setRepro("bun test test/cli-privacy.e2e.test.ts");

    await log.run(async () => {
      await withTempCassHome(async (env) => {
        // Write a config with deprecated llm block
        const deprecatedConfig = {
          schema_version: 1,
          llm: {
            provider: "openai",
            model: "gpt-4"
          },
          cassPath: "__cass_not_installed__",
          playbookPath: env.playbookPath,
          diaryDir: env.diaryDir,
          crossAgent: {
            enabled: false,
            consentGiven: false,
            consentDate: null,
            agents: [],
            auditLog: true,
          },
        };
        await writeFile(env.configPath, JSON.stringify(deprecatedConfig, null, 2), "utf-8");
        log.snapshot("config.before", JSON.stringify(deprecatedConfig, null, 2));

        const capture = captureConsole();
        try {
          await withNoColor(async () => {
            await withCwd(env.home, async () => {
              log.step("Run status with deprecated config");
              await privacyCommand("status", [], { json: true, days: 7 });
            });
          });
        } finally {
          capture.restore();
        }

        const stdout = capture.logs.join("\n");
        log.snapshot("stdout", stdout);
        const payload = JSON.parse(stdout);

        // Should still work despite deprecated config format
        expect(payload.success).toBe(true);
        expect(payload.command).toBe("privacy:status");
      });
    });
  });
});
