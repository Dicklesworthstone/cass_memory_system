/**
 * E2E Tests for CLI top command - Most effective bullets
 */
import { describe, it, expect } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import yaml from "yaml";
import { topCommand } from "../src/commands/top.js";
import { withTempCassHome, type TestEnv } from "./helpers/temp.js";
import { createE2ELogger } from "./helpers/e2e-logger.js";
import { createTestConfig, createTestPlaybook, createBullet, createFeedbackEvent } from "./helpers/factories.js";

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
    verbose: false,
    jsonOutput: false,
  });
  await writeFile(env.configPath, JSON.stringify(config, null, 2), "utf-8");
}

async function snapshotFile(log: ReturnType<typeof createE2ELogger>, name: string, filePath: string): Promise<void> {
  const contents = await readFile(filePath, "utf-8").catch(() => "");
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

describe("E2E: CLI top command", () => {
  it.serial("handles empty playbook case", async () => {
    const log = createE2ELogger("cli-top: empty playbook");
    log.setRepro("bun test test/cli-top.e2e.test.ts");

    await log.run(async () => {
      await withTempCassHome(async (env) => {
        await writeTestConfig(env);
        const playbook = createTestPlaybook([]);

        log.step("Write empty playbook", { playbookPath: env.playbookPath });
        await writeFile(env.playbookPath, yaml.stringify(playbook));
        await snapshotFile(log, "config.json", env.configPath);
        await snapshotFile(log, "playbook.before", env.playbookPath);

        const capture = captureConsole();
        try {
          await withNoColor(async () => {
            await withCwd(env.home, async () => {
              log.step("Run command", { command: "cm top --json" });
              await topCommand(10, { json: true });
            });
          });
        } finally {
          capture.restore();
        }

        const stdout = capture.logs.join("\n");
        log.snapshot("stdout", stdout);
        log.snapshot("stderr", capture.errors.join("\n"));
        await snapshotFile(log, "playbook.after", env.playbookPath);

        const payload = JSON.parse(stdout);
        expect(payload.success).toBe(true);
        expect(payload.command).toBe("top");
        expect(payload.data.count).toBe(0);
        expect(payload.data.bullets).toEqual([]);
      });
    });
  });

  it.serial("returns highest-scored bullets and respects --limit", async () => {
    const log = createE2ELogger("cli-top: ranking + limit");
    log.setRepro("bun test test/cli-top.e2e.test.ts");

    await log.run(async () => {
      await withTempCassHome(async (env) => {
        await writeTestConfig(env);

        const nowTs = new Date().toISOString();
        const helpful = (n: number) =>
          Array.from({ length: n }, () => createFeedbackEvent("helpful", { timestamp: nowTs }));

        const bulletHigh = createBullet({
          id: "b-top-high",
          content: "High scoring bullet",
          category: "testing",
          scope: "global",
          maturity: "established",
          feedbackEvents: helpful(6),
          helpfulCount: 6,
          harmfulCount: 0,
        });
        const bulletMid = createBullet({
          id: "b-top-mid",
          content: "Medium scoring bullet",
          category: "testing",
          scope: "workspace",
          maturity: "established",
          feedbackEvents: helpful(2),
          helpfulCount: 2,
          harmfulCount: 0,
        });
        const bulletLow = createBullet({
          id: "b-top-low",
          content: "Low scoring bullet",
          category: "security",
          scope: "global",
          maturity: "established",
          feedbackEvents: [createFeedbackEvent("harmful", { timestamp: nowTs })],
          helpfulCount: 0,
          harmfulCount: 1,
        });

        const playbook = createTestPlaybook([bulletLow, bulletMid, bulletHigh]);
        log.step("Write playbook", { playbookPath: env.playbookPath, bulletIds: [bulletHigh.id, bulletMid.id, bulletLow.id] });
        await writeFile(env.playbookPath, yaml.stringify(playbook));
        await snapshotFile(log, "config.json", env.configPath);
        await snapshotFile(log, "playbook.before", env.playbookPath);

        const capture = captureConsole();
        try {
          await withNoColor(async () => {
            await withCwd(env.home, async () => {
              log.step("Run command", { command: "cm top --limit 2 --json" });
              await topCommand(2, { json: true });
            });
          });
        } finally {
          capture.restore();
        }

        const stdout = capture.logs.join("\n");
        log.snapshot("stdout", stdout);
        log.snapshot("stderr", capture.errors.join("\n"));
        await snapshotFile(log, "playbook.after", env.playbookPath);
        const payload = JSON.parse(stdout);

        expect(payload.success).toBe(true);
        expect(payload.command).toBe("top");
        expect(payload.data.count).toBe(2);
        expect(payload.data.bullets.length).toBe(2);
        expect(payload.data.bullets[0].id).toBe("b-top-high");
        expect(payload.data.bullets[0].rank).toBe(1);
        expect(payload.data.bullets[1].id).toBe("b-top-mid");
        expect(payload.data.bullets[1].rank).toBe(2);
      });
    });
  });

  it.serial("applies scope filtering correctly", async () => {
    const log = createE2ELogger("cli-top: scope filter");
    log.setRepro("bun test test/cli-top.e2e.test.ts");

    await log.run(async () => {
      await withTempCassHome(async (env) => {
        await writeTestConfig(env);

        const nowTs = new Date().toISOString();
        const bulletGlobal = createBullet({
          id: "b-top-global",
          content: "Global bullet",
          category: "testing",
          scope: "global",
          maturity: "established",
          feedbackEvents: [createFeedbackEvent("helpful", { timestamp: nowTs })],
          helpfulCount: 1,
        });
        const bulletWorkspace = createBullet({
          id: "b-top-workspace",
          content: "Workspace bullet",
          category: "testing",
          scope: "workspace",
          maturity: "established",
          feedbackEvents: [createFeedbackEvent("helpful", { timestamp: nowTs })],
          helpfulCount: 1,
        });

        const playbook = createTestPlaybook([bulletGlobal, bulletWorkspace]);
        log.step("Write playbook", { playbookPath: env.playbookPath, bulletIds: [bulletGlobal.id, bulletWorkspace.id] });
        await writeFile(env.playbookPath, yaml.stringify(playbook));
        await snapshotFile(log, "config.json", env.configPath);
        await snapshotFile(log, "playbook.before", env.playbookPath);

        const capture = captureConsole();
        try {
          await withNoColor(async () => {
            await withCwd(env.home, async () => {
              log.step("Run command", { command: "cm top --scope workspace --json" });
              await topCommand(10, { scope: "workspace", json: true });
            });
          });
        } finally {
          capture.restore();
        }

        const stdout = capture.logs.join("\n");
        log.snapshot("stdout", stdout);
        log.snapshot("stderr", capture.errors.join("\n"));
        await snapshotFile(log, "playbook.after", env.playbookPath);
        const payload = JSON.parse(stdout);

        expect(payload.success).toBe(true);
        expect(payload.data.filters.scope).toBe("workspace");
        expect(payload.data.bullets.map((b: any) => b.id)).toEqual(["b-top-workspace"]);
      });
    });
  });
});
