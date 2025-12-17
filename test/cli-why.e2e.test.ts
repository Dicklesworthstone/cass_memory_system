/**
 * E2E Tests for CLI why command - Bullet provenance
 *
 * Tests the `cm why` command for showing the origin evidence for a playbook bullet.
 */
import { describe, it, expect } from "bun:test";
import { readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import yaml from "yaml";
import { whyCommand } from "../src/commands/why.js";
import { recordFeedback } from "../src/commands/mark.js";
import { withTempCassHome, type TestEnv } from "./helpers/temp.js";
import { createE2ELogger } from "./helpers/e2e-logger.js";
import { createTestConfig, createTestPlaybook, createBullet, createTestDiary, daysAgo } from "./helpers/factories.js";

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
    playbookPath: env.playbookPath,
    diaryDir: env.diaryDir,
    verbose: false,
    jsonOutput: false,
  });
  await writeFile(env.configPath, JSON.stringify(config, null, 2), "utf-8");
}

async function snapshotPlaybook(log: ReturnType<typeof createE2ELogger>, env: TestEnv, name: string): Promise<void> {
  const contents = await readFile(env.playbookPath, "utf-8").catch(() => "");
  log.snapshot(name, contents);
}

async function snapshotDiaryDir(log: ReturnType<typeof createE2ELogger>, env: TestEnv, name: string): Promise<void> {
  const files = await readdir(env.diaryDir).catch(() => []);
  log.snapshot(name, files.sort());
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

describe("E2E: CLI why command", () => {
  it.serial("shows evidence for bullet with known history", async () => {
    const log = createE2ELogger("cli-why: evidence + feedback history");
    log.setRepro("bun test test/cli-why.e2e.test.ts");

    await log.run(async () => {
      await withTempCassHome(async (env) => {
        await writeTestConfig(env);

        const bulletId = "b-old-why-evidence-123";
        const createdAt = daysAgo(45);

        const bullet = createBullet({
          id: bulletId,
          content: "Prefer deterministic, offline tests for CLI commands.",
          category: "testing",
          createdAt,
          updatedAt: createdAt,
          reasoning: 'We hit flaky CI due to "network calls" and "global state".',
          sourceSessions: ["/sessions/s1.jsonl", "/sessions/s2.jsonl"],
          helpfulCount: 0,
          harmfulCount: 0,
          feedbackEvents: [],
        });

        const playbook = createTestPlaybook([bullet]);
        log.step("Write playbook with bullet", { playbookPath: env.playbookPath, bulletId });
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        await snapshotPlaybook(log, env, "playbook.before");

        const diary1 = createTestDiary({
          sessionPath: "/sessions/s1.jsonl",
          timestamp: daysAgo(46),
          keyLearnings: ["Avoid network calls in CI tests."],
        });
        const diary2 = createTestDiary({
          sessionPath: "/sessions/s2.jsonl",
          timestamp: daysAgo(44),
          accomplishments: ["Refactored tests to be deterministic."],
        });
        await writeFile(path.join(env.diaryDir, `${diary1.id}.json`), JSON.stringify(diary1, null, 2), "utf-8");
        await writeFile(path.join(env.diaryDir, `${diary2.id}.json`), JSON.stringify(diary2, null, 2), "utf-8");
        await snapshotDiaryDir(log, env, "diary.files");

        log.step("Mark bullet as helpful", { bulletId });
        await withCwd(env.home, async () => recordFeedback(bulletId, { helpful: true }));
        await snapshotPlaybook(log, env, "playbook.afterMark");

        const capture = captureConsole();
        try {
          await withNoColor(async () => {
            await withCwd(env.home, async () => {
              log.step("Run command", { command: `cm why ${bulletId}` });
              await whyCommand(bulletId, {});
            });
          });
        } finally {
          capture.restore();
        }

        const stdout = capture.logs.join("\n");
        const stderr = capture.errors.join("\n");
        log.snapshot("stdout", stdout);
        log.snapshot("stderr", stderr);
        await snapshotPlaybook(log, env, "playbook.after");

        expect(stderr).toBe("");
        expect(stdout).toContain("WHY");
        expect(stdout).toContain(bulletId);
        expect(stdout).toContain("Sources (2)");
        expect(stdout).toContain("Evidence");
        expect(stdout).toContain("network calls");
        expect(stdout).toContain("Related diary entries");
        expect(stdout).toContain("Feedback history (1 helpful, 0 harmful)");
      });
    });
  });

  it.serial("handles bullet with no feedback history", async () => {
    const log = createE2ELogger("cli-why: no feedback history");
    log.setRepro("bun test test/cli-why.e2e.test.ts");

    await log.run(async () => {
      await withTempCassHome(async (env) => {
        await writeTestConfig(env);

        const bulletId = "b-recent-why-nofeedback-456";
        const bullet = createBullet({
          id: bulletId,
          content: "Keep CLI output stable for scripting.",
          category: "ux",
          createdAt: daysAgo(0),
          updatedAt: daysAgo(0),
          reasoning: undefined,
          sourceSessions: [],
          helpfulCount: 0,
          harmfulCount: 0,
          feedbackEvents: [],
        });

        const playbook = createTestPlaybook([bullet]);
        log.step("Write playbook with bullet", { playbookPath: env.playbookPath, bulletId });
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        await snapshotPlaybook(log, env, "playbook.before");
        await snapshotDiaryDir(log, env, "diary.files");

        const capture = captureConsole();
        try {
          await withNoColor(async () => {
            await withCwd(env.home, async () => {
              log.step("Run command", { command: `cm why ${bulletId}` });
              await whyCommand(bulletId, {});
            });
          });
        } finally {
          capture.restore();
        }

        const stdout = capture.logs.join("\n");
        const stderr = capture.errors.join("\n");
        log.snapshot("stdout", stdout);
        log.snapshot("stderr", stderr);
        await snapshotPlaybook(log, env, "playbook.after");

        expect(stderr).toBe("");
        expect(stdout).toContain("WHY");
        expect(stdout).toContain(bulletId);
        expect(stdout).toContain("(No original reasoning recorded)");
        expect(stdout).toContain("Sources (0)");
        expect(stdout).toContain("(No source sessions recorded)");
        expect(stdout).not.toContain("Feedback history");
      });
    });
  });

  it.serial("partial ID match finds correct bullet", async () => {
    const log = createE2ELogger("cli-why: partial id match");
    log.setRepro("bun test test/cli-why.e2e.test.ts");

    await log.run(async () => {
      await withTempCassHome(async (env) => {
        await writeTestConfig(env);

        const bulletId = "b-partial-abcdef123456";
        const bullet = createBullet({
          id: bulletId,
          content: "Use explicit, stable file paths in CLI output.",
          category: "ux",
          createdAt: daysAgo(5),
          updatedAt: daysAgo(5),
          feedbackEvents: [],
        });

        const playbook = createTestPlaybook([bullet]);
        log.step("Write playbook with bullet", { playbookPath: env.playbookPath, bulletId });
        await writeFile(env.playbookPath, yaml.stringify(playbook));
        await snapshotPlaybook(log, env, "playbook.before");
        await snapshotDiaryDir(log, env, "diary.files");

        const capture = captureConsole();
        try {
          await withNoColor(async () => {
            await withCwd(env.home, async () => {
              const partial = "b-partial";
              log.step("Run command", { command: `cm why ${partial}` });
              await whyCommand(partial, {});
            });
          });
        } finally {
          capture.restore();
        }

        const stdout = capture.logs.join("\n");
        log.snapshot("stdout", stdout);
        await snapshotPlaybook(log, env, "playbook.after");
        expect(stdout).toContain(bulletId);
      });
    });
  });

  it.serial("returns error for unknown bullet", async () => {
    const log = createE2ELogger("cli-why: unknown bullet");
    log.setRepro("bun test test/cli-why.e2e.test.ts");

    await log.run(async () => {
      await withTempCassHome(async (env) => {
        await writeTestConfig(env);

        const playbook = createTestPlaybook([]);
        log.step("Write empty playbook", { playbookPath: env.playbookPath });
        await writeFile(env.playbookPath, yaml.stringify(playbook));
        await snapshotPlaybook(log, env, "playbook.before");
        await snapshotDiaryDir(log, env, "diary.files");

        const originalExitCode = process.exitCode;
        process.exitCode = 0;

        const capture = captureConsole();
        try {
          await withNoColor(async () => {
            await withCwd(env.home, async () => {
              const missingId = "b-does-not-exist";
              log.step("Run command", { command: `cm why ${missingId} --json` });
              await whyCommand(missingId, { json: true });
            });
          });
        } finally {
          capture.restore();
          process.exitCode = originalExitCode;
        }

        const stdout = capture.logs.join("\n");
        log.snapshot("stdout", stdout);
        await snapshotPlaybook(log, env, "playbook.after");

        const payload = JSON.parse(stdout);
        expect(payload.success).toBe(false);
        expect(payload.command).toBe("why");
        expect(payload.error.code).toBe("BULLET_NOT_FOUND");
        expect(payload.error.details.bulletId).toBe("b-does-not-exist");
      });
    });
  });

  it.serial("JSON output has correct structure", async () => {
    const log = createE2ELogger("cli-why: json output shape");
    log.setRepro("bun test test/cli-why.e2e.test.ts");

    await log.run(async () => {
      await withTempCassHome(async (env) => {
        await writeTestConfig(env);

        const bulletId = "b-json-why-789";
        const bullet = createBullet({
          id: bulletId,
          content: "Prefer stable JSON envelopes for CLI output.",
          category: "ux",
          createdAt: daysAgo(12),
          updatedAt: daysAgo(12),
          reasoning: 'We need tooling that can reliably parse "success" and "data".',
          feedbackEvents: [],
        });

        const playbook = createTestPlaybook([bullet]);
        log.step("Write playbook with bullet", { playbookPath: env.playbookPath, bulletId });
        await writeFile(env.playbookPath, yaml.stringify(playbook));
        await snapshotPlaybook(log, env, "playbook.before");
        await snapshotDiaryDir(log, env, "diary.files");

        const capture = captureConsole();
        try {
          await withNoColor(async () => {
            await withCwd(env.home, async () => {
              log.step("Run command", { command: `cm why ${bulletId} --json` });
              await whyCommand(bulletId, { json: true });
            });
          });
        } finally {
          capture.restore();
        }

        const stdout = capture.logs.join("\n");
        log.snapshot("stdout", stdout);
        await snapshotPlaybook(log, env, "playbook.after");

        const payload = JSON.parse(stdout);
        expect(payload.success).toBe(true);
        expect(payload.command).toBe("why");
        expect(payload.data.bullet.id).toBe(bulletId);
        expect(typeof payload.data.bullet.daysAgo).toBe("number");
        expect(Array.isArray(payload.data.sourceSessions)).toBe(true);
        expect(Array.isArray(payload.data.evidence)).toBe(true);
        expect(Array.isArray(payload.data.diaryEntries)).toBe(true);
        expect(Array.isArray(payload.data.feedbackHistory)).toBe(true);
      });
    });
  });
});
