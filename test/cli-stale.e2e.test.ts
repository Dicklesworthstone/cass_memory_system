/**
 * E2E Tests for CLI stale command - Staleness detection
 */
import { describe, it, expect } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import yaml from "yaml";
import { staleCommand } from "../src/commands/stale.js";
import { calculateDecayedValue } from "../src/scoring.js";
import { withTempCassHome, type TestEnv } from "./helpers/temp.js";
import { createE2ELogger } from "./helpers/e2e-logger.js";
import { createTestConfig, createTestPlaybook, createBullet, createFeedbackEvent, daysAgo } from "./helpers/factories.js";

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

describe("E2E: CLI stale command", () => {
  it.serial("handles empty result case", async () => {
    const log = createE2ELogger("cli-stale: empty result");
    log.setRepro("bun test test/cli-stale.e2e.test.ts");

    await log.run(async () => {
      await withTempCassHome(async (env) => {
        await writeTestConfig(env);

        const nowTs = new Date().toISOString();
        const bullet = createBullet({
          id: "b-stale-fresh",
          content: "Fresh bullet",
          category: "testing",
          maturity: "established",
          createdAt: daysAgo(1),
          updatedAt: daysAgo(1),
          feedbackEvents: [createFeedbackEvent("helpful", { timestamp: nowTs })],
          helpfulCount: 1,
        });

        const playbook = createTestPlaybook([bullet]);
        log.step("Write playbook", { playbookPath: env.playbookPath, bulletIds: [bullet.id] });
        await writeFile(env.playbookPath, yaml.stringify(playbook));
        await snapshotFile(log, "config.json", env.configPath);
        await snapshotFile(log, "playbook.before", env.playbookPath);

        const capture = captureConsole();
        try {
          await withNoColor(async () => {
            await withCwd(env.home, async () => {
              log.step("Run command", { command: "cm stale --days 90 --json" });
              await staleCommand({ days: 90, json: true });
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
        expect(payload.command).toBe("stale");
        expect(payload.data.count).toBe(0);
        expect(payload.data.bullets).toEqual([]);
      });
    });
  });

  it.serial("identifies stale bullets and respects threshold", async () => {
    const log = createE2ELogger("cli-stale: threshold + detection");
    log.setRepro("bun test test/cli-stale.e2e.test.ts");

    await log.run(async () => {
      await withTempCassHome(async (env) => {
        await writeTestConfig(env);

        const bulletNoFeedback = createBullet({
          id: "b-stale-nofeedback",
          content: "No feedback for a long time",
          category: "testing",
          maturity: "established",
          createdAt: daysAgo(200),
          updatedAt: daysAgo(200),
          feedbackEvents: [],
        });

        const bulletOldFeedback = createBullet({
          id: "b-stale-oldfeedback",
          content: "Last feedback was long ago",
          category: "testing",
          maturity: "established",
          createdAt: daysAgo(220),
          updatedAt: daysAgo(220),
          feedbackEvents: [createFeedbackEvent("helpful", { timestamp: daysAgo(120) })],
          helpfulCount: 1,
        });

        const bulletRecentFeedback = createBullet({
          id: "b-stale-recentfeedback",
          content: "Recent feedback exists",
          category: "testing",
          maturity: "established",
          createdAt: daysAgo(220),
          updatedAt: daysAgo(220),
          feedbackEvents: [createFeedbackEvent("helpful", { timestamp: daysAgo(5) })],
          helpfulCount: 1,
        });

        const playbook = createTestPlaybook([bulletNoFeedback, bulletOldFeedback, bulletRecentFeedback]);
        log.step("Write playbook", {
          playbookPath: env.playbookPath,
          bulletIds: [bulletNoFeedback.id, bulletOldFeedback.id, bulletRecentFeedback.id],
        });
        await writeFile(env.playbookPath, yaml.stringify(playbook));
        await snapshotFile(log, "config.json", env.configPath);
        await snapshotFile(log, "playbook.before", env.playbookPath);

        const capture = captureConsole();
        try {
          await withNoColor(async () => {
            await withCwd(env.home, async () => {
              log.step("Run command", { command: "cm stale --days 90 --json" });
              await staleCommand({ days: 90, json: true });
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
        expect(payload.command).toBe("stale");
        expect(payload.data.threshold).toBe(90);
        expect(payload.data.count).toBe(2);

        const ids = payload.data.bullets.map((b: any) => b.id);
        expect(ids).toContain("b-stale-nofeedback");
        expect(ids).toContain("b-stale-oldfeedback");
        expect(ids).not.toContain("b-stale-recentfeedback");

        const noFeedback = payload.data.bullets.find((b: any) => b.id === "b-stale-nofeedback");
        expect(noFeedback.lastFeedback.timestamp).toBe(null);
        expect(noFeedback.daysSinceLastFeedback).toBeGreaterThanOrEqual(90);
      });
    });
  });

  it.serial("decay calculation is reflected in scores", async () => {
    const log = createE2ELogger("cli-stale: score decay");
    log.setRepro("bun test test/cli-stale.e2e.test.ts");

    await log.run(async () => {
      await withTempCassHome(async (env) => {
        await writeTestConfig(env);

        const oldTs = daysAgo(180);
        const nowTs = new Date().toISOString();
        const eventOld = createFeedbackEvent("helpful", { timestamp: oldTs });
        const eventNow = createFeedbackEvent("helpful", { timestamp: nowTs });

        const bulletOld = createBullet({
          id: "b-stale-decay-old",
          content: "Old feedback should decay",
          category: "testing",
          maturity: "established",
          createdAt: daysAgo(200),
          updatedAt: daysAgo(200),
          feedbackEvents: [eventOld],
          helpfulCount: 1,
        });
        const bulletNow = createBullet({
          id: "b-stale-decay-now",
          content: "Recent feedback should be near full value",
          category: "testing",
          maturity: "established",
          createdAt: daysAgo(1),
          updatedAt: daysAgo(1),
          feedbackEvents: [eventNow],
          helpfulCount: 1,
        });

        const playbook = createTestPlaybook([bulletOld, bulletNow]);
        log.step("Write playbook", { playbookPath: env.playbookPath, bulletIds: [bulletOld.id, bulletNow.id] });
        await writeFile(env.playbookPath, yaml.stringify(playbook));
        await snapshotFile(log, "config.json", env.configPath);
        await snapshotFile(log, "playbook.before", env.playbookPath);

        const capture = captureConsole();
        try {
          await withNoColor(async () => {
            await withCwd(env.home, async () => {
              log.step("Run command", { command: "cm stale --days 0 --json" });
              await staleCommand({ days: 0, json: true });
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
        const bullets = payload.data.bullets;

        const foundOld = bullets.find((b: any) => b.id === "b-stale-decay-old");
        const foundNow = bullets.find((b: any) => b.id === "b-stale-decay-now");
        expect(foundOld).toBeDefined();
        expect(foundNow).toBeDefined();

        expect(foundNow.score).toBeGreaterThan(foundOld.score);

        const now = new Date();
        const expectedOld = calculateDecayedValue(eventOld, now, 90);
        const expectedNow = calculateDecayedValue(eventNow, now, 90);

        // stale command rounds to 2 decimals
        expect(foundOld.score).toBeCloseTo(Number(expectedOld.toFixed(2)), 1);
        expect(foundNow.score).toBeCloseTo(Number(expectedNow.toFixed(2)), 1);
      });
    });
  });
});
