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
});
