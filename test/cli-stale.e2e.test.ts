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

  it.serial("rejects invalid days parameter", async () => {
    const log = createE2ELogger("cli-stale: invalid days");
    log.setRepro("bun test test/cli-stale.e2e.test.ts");

    await log.run(async () => {
      await withTempCassHome(async (env) => {
        await writeTestConfig(env);

        const bullet = createBullet({
          id: "b-stale-valid",
          content: "Test bullet",
          category: "testing",
          maturity: "established",
          createdAt: daysAgo(100),
          updatedAt: daysAgo(100),
          feedbackEvents: [],
        });

        const playbook = createTestPlaybook([bullet]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        // Test with negative number
        const capture = captureConsole();
        try {
          await withNoColor(async () => {
            await withCwd(env.home, async () => {
              log.step("Run command with invalid days", { days: -5 });
              await staleCommand({ days: -5, json: true });
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

  it.serial("rejects invalid scope parameter", async () => {
    const log = createE2ELogger("cli-stale: invalid scope");
    log.setRepro("bun test test/cli-stale.e2e.test.ts");

    await log.run(async () => {
      await withTempCassHome(async (env) => {
        await writeTestConfig(env);

        const bullet = createBullet({
          id: "b-stale-valid",
          content: "Test bullet",
          category: "testing",
          maturity: "established",
          createdAt: daysAgo(100),
          updatedAt: daysAgo(100),
          feedbackEvents: [],
        });

        const playbook = createTestPlaybook([bullet]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        const capture = captureConsole();
        try {
          await withNoColor(async () => {
            await withCwd(env.home, async () => {
              log.step("Run command with invalid scope", { scope: "invalid" as any });
              await staleCommand({ scope: "invalid" as any, json: true });
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
        expect(payload.error.message).toContain("scope");
      });
    });
  });

  it.serial("human-readable output shows stale bullets with recommendations", async () => {
    const log = createE2ELogger("cli-stale: human readable output");
    log.setRepro("bun test test/cli-stale.e2e.test.ts");

    await log.run(async () => {
      await withTempCassHome(async (env) => {
        await writeTestConfig(env);

        // Create a stale bullet with negative score (for "consider forget" recommendation)
        const bulletNegativeScore = createBullet({
          id: "b-stale-negative",
          content: "Bullet with negative score",
          category: "testing",
          maturity: "established",
          createdAt: daysAgo(120),
          updatedAt: daysAgo(120),
          feedbackEvents: [
            createFeedbackEvent("harmful", { timestamp: daysAgo(100) }),
            createFeedbackEvent("harmful", { timestamp: daysAgo(100) }),
          ],
          harmfulCount: 2,
          helpfulCount: 0,
        });

        // Create a very stale candidate (>180 days)
        const bulletVeryStale = createBullet({
          id: "b-stale-verystale",
          content: "Very stale candidate bullet",
          category: "testing",
          maturity: "candidate",
          createdAt: daysAgo(200),
          updatedAt: daysAgo(200),
          feedbackEvents: [],
        });

        // Create a high-score stale bullet (score > 5)
        const bulletHighScore = createBullet({
          id: "b-stale-highscore",
          content: "High score stale bullet",
          category: "testing",
          maturity: "proven",
          createdAt: daysAgo(150),
          updatedAt: daysAgo(150),
          feedbackEvents: [
            createFeedbackEvent("helpful", { timestamp: daysAgo(95) }),
            createFeedbackEvent("helpful", { timestamp: daysAgo(95) }),
            createFeedbackEvent("helpful", { timestamp: daysAgo(95) }),
            createFeedbackEvent("helpful", { timestamp: daysAgo(95) }),
            createFeedbackEvent("helpful", { timestamp: daysAgo(95) }),
            createFeedbackEvent("helpful", { timestamp: daysAgo(95) }),
            createFeedbackEvent("helpful", { timestamp: daysAgo(95) }),
            createFeedbackEvent("helpful", { timestamp: daysAgo(95) }),
          ],
          helpfulCount: 8,
        });

        const playbook = createTestPlaybook([bulletNegativeScore, bulletVeryStale, bulletHighScore]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        const capture = captureConsole();
        try {
          await withNoColor(async () => {
            await withCwd(env.home, async () => {
              log.step("Run command", { command: "cm stale --days 90" });
              await staleCommand({ days: 90 }); // No --json for human output
            });
          });
        } finally {
          capture.restore();
        }

        const stdout = capture.logs.join("\n");
        log.snapshot("stdout", stdout);

        // Verify human-readable output contains expected elements
        expect(stdout).toContain("STALE");
        expect(stdout).toContain("Threshold: 90+ days");
        expect(stdout).toContain("b-stale-negative");
        expect(stdout).toContain("b-stale-verystale");
        expect(stdout).toContain("b-stale-highscore");
        expect(stdout).toContain("Next actions");
        // Should contain recommendation text
        expect(stdout).toMatch(/negative scores|consider|review/i);
      });
    });
  });

  it.serial("human-readable output shows empty result message", async () => {
    const log = createE2ELogger("cli-stale: human readable empty");
    log.setRepro("bun test test/cli-stale.e2e.test.ts");

    await log.run(async () => {
      await withTempCassHome(async (env) => {
        await writeTestConfig(env);

        // Create a bullet with recent feedback (won't be stale at 90 days threshold)
        const bulletRecent = createBullet({
          id: "b-stale-recent",
          content: "Recent feedback bullet",
          category: "testing",
          maturity: "established",
          createdAt: daysAgo(10),
          updatedAt: daysAgo(5),
          feedbackEvents: [createFeedbackEvent("helpful", { timestamp: daysAgo(5) })],
          helpfulCount: 1,
        });

        const playbook = createTestPlaybook([bulletRecent]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        const capture = captureConsole();
        try {
          await withNoColor(async () => {
            await withCwd(env.home, async () => {
              log.step("Run command", { command: "cm stale --days 90" });
              await staleCommand({ days: 90 }); // No --json for human output
            });
          });
        } finally {
          capture.restore();
        }

        const stdout = capture.logs.join("\n");
        log.snapshot("stdout", stdout);

        // Verify no stale bullets message
        expect(stdout).toContain("No stale bullets found");
        expect(stdout).toContain("All");
        expect(stdout).toContain("active bullets have recent feedback");
      });
    });
  });

  it.serial("filters by scope parameter", async () => {
    const log = createE2ELogger("cli-stale: scope filter");
    log.setRepro("bun test test/cli-stale.e2e.test.ts");

    await log.run(async () => {
      await withTempCassHome(async (env) => {
        await writeTestConfig(env);

        const bulletGlobal = createBullet({
          id: "b-stale-global",
          content: "Global scope bullet",
          category: "testing",
          maturity: "established",
          scope: "global",
          createdAt: daysAgo(100),
          updatedAt: daysAgo(100),
          feedbackEvents: [],
        });

        const bulletWorkspace = createBullet({
          id: "b-stale-workspace",
          content: "Workspace scope bullet",
          category: "testing",
          maturity: "established",
          scope: "workspace",
          createdAt: daysAgo(100),
          updatedAt: daysAgo(100),
          feedbackEvents: [],
        });

        const playbook = createTestPlaybook([bulletGlobal, bulletWorkspace]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        const capture = captureConsole();
        try {
          await withNoColor(async () => {
            await withCwd(env.home, async () => {
              log.step("Run command with scope=global", { scope: "global" });
              await staleCommand({ days: 90, scope: "global", json: true });
            });
          });
        } finally {
          capture.restore();
        }

        const stdout = capture.logs.join("\n");
        log.snapshot("stdout", stdout);
        const payload = JSON.parse(stdout);

        expect(payload.success).toBe(true);
        expect(payload.data.count).toBe(1);
        expect(payload.data.bullets[0].id).toBe("b-stale-global");
        expect(payload.data.filters.scope).toBe("global");
      });
    });
  });

  it.serial("covers high score recommendation case", async () => {
    const log = createE2ELogger("cli-stale: high score recommendation");
    log.setRepro("bun test test/cli-stale.e2e.test.ts");

    await log.run(async () => {
      await withTempCassHome(async (env) => {
        await writeTestConfig(env);

        // Create a bullet with score > 5 to trigger the "Good score despite being stale" case
        // Score = helpful - 4*harmful, with decay. We need many helpful events.
        const bulletHighScore = createBullet({
          id: "b-stale-high",
          content: "High score but stale",
          category: "testing",
          maturity: "proven",
          createdAt: daysAgo(100),
          updatedAt: daysAgo(100),
          feedbackEvents: [
            // Many recent-ish helpful events to get score > 5
            createFeedbackEvent("helpful", { timestamp: daysAgo(92) }),
            createFeedbackEvent("helpful", { timestamp: daysAgo(92) }),
            createFeedbackEvent("helpful", { timestamp: daysAgo(92) }),
            createFeedbackEvent("helpful", { timestamp: daysAgo(92) }),
            createFeedbackEvent("helpful", { timestamp: daysAgo(92) }),
            createFeedbackEvent("helpful", { timestamp: daysAgo(92) }),
            createFeedbackEvent("helpful", { timestamp: daysAgo(92) }),
          ],
          helpfulCount: 7,
        });

        const playbook = createTestPlaybook([bulletHighScore]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

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
        const payload = JSON.parse(stdout);

        expect(payload.success).toBe(true);
        expect(payload.data.count).toBe(1);
        const bullet = payload.data.bullets[0];
        expect(bullet.id).toBe("b-stale-high");
        // The recommendation for high score bullets should mention "Good score"
        expect(bullet.recommendation).toContain("Good score despite being stale");
      });
    });
  });
});
