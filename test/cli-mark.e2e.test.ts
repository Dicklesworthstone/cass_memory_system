/**
 * E2E Tests for CLI mark command - Feedback recording
 *
 * Tests the `cm mark` command for recording user feedback on playbook bullets.
 * Uses isolated temp directories to avoid affecting the real system.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { stat, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import path from "node:path";
import yaml from "yaml";
import os from "node:os";

import { markCommand, recordFeedback } from "../src/commands/mark.js";
import { createEmptyPlaybook, savePlaybook, loadPlaybook, findBullet } from "../src/playbook.js";
import { createTestConfig, createTestBullet } from "./helpers/index.js";
import { Playbook } from "../src/types.js";

// --- Helper Functions ---

let tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dirPath = path.join(os.tmpdir(), `mark-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dirPath, { recursive: true });
  tempDirs.push(dirPath);
  return dirPath;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  tempDirs = [];
});

// Helper to capture console output
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
    }
  };
}

async function setupTestEnvironment() {
  const dir = await createTempDir();
  const home = path.join(dir, "home");
  const repo = path.join(dir, "repo");
  const cassMemoryDir = path.join(home, ".cass-memory");
  const repoCassDir = path.join(repo, ".cass");

  await mkdir(cassMemoryDir, { recursive: true });
  await mkdir(path.join(cassMemoryDir, "diary"), { recursive: true });
  await mkdir(repoCassDir, { recursive: true });

  // Create config
  const config = { schema_version: 1 };
  await writeFile(path.join(cassMemoryDir, "config.json"), JSON.stringify(config));

  return { dir, home, repo, cassMemoryDir, repoCassDir };
}

// --- Test Suites ---

describe("E2E: CLI mark command", () => {
  describe("Mark Positive Feedback", () => {
    it("records helpful feedback on a bullet", async () => {
      const { home, cassMemoryDir } = await setupTestEnvironment();
      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;

        // Create playbook with a test bullet
        const playbook = createEmptyPlaybook("test");
        const bullet = createTestBullet({
          id: "test-bullet-1",
          content: "Always validate user input",
          helpfulCount: 0,
          harmfulCount: 0
        });
        playbook.bullets = [bullet];
        await savePlaybook(playbook, path.join(cassMemoryDir, "playbook.yaml"));

        // Record helpful feedback
        const result = await recordFeedback("test-bullet-1", { helpful: true });

        expect(result.type).toBe("helpful");
        expect(typeof result.score).toBe("number");
        expect(typeof result.state).toBe("string");

        // Verify bullet was updated
        const updatedPlaybook = await loadPlaybook(path.join(cassMemoryDir, "playbook.yaml"));
        const updatedBullet = findBullet(updatedPlaybook, "test-bullet-1");

        expect(updatedBullet).toBeDefined();
        expect(updatedBullet?.helpfulCount).toBe(1);
        expect(updatedBullet?.feedbackEvents?.length).toBe(1);
        expect(updatedBullet?.feedbackEvents?.[0].type).toBe("helpful");
      } finally {
        process.env.HOME = originalHome;
      }
    });

    it("increases helpful count with each positive mark", async () => {
      const { home, cassMemoryDir } = await setupTestEnvironment();
      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;

        const playbook = createEmptyPlaybook("test");
        const bullet = createTestBullet({
          id: "multi-helpful",
          content: "Use descriptive variable names",
          helpfulCount: 2,
          harmfulCount: 0
        });
        playbook.bullets = [bullet];
        await savePlaybook(playbook, path.join(cassMemoryDir, "playbook.yaml"));

        // Record another helpful feedback
        await recordFeedback("multi-helpful", { helpful: true });

        const updated = await loadPlaybook(path.join(cassMemoryDir, "playbook.yaml"));
        const updatedBullet = findBullet(updated, "multi-helpful");

        expect(updatedBullet?.helpfulCount).toBe(3);
      } finally {
        process.env.HOME = originalHome;
      }
    });
  });

  describe("Mark Negative Feedback", () => {
    it("records harmful feedback on a bullet", async () => {
      const { home, cassMemoryDir } = await setupTestEnvironment();
      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;

        const playbook = createEmptyPlaybook("test");
        const bullet = createTestBullet({
          id: "harmful-test",
          content: "Always use any type for flexibility",
          helpfulCount: 0,
          harmfulCount: 0
        });
        playbook.bullets = [bullet];
        await savePlaybook(playbook, path.join(cassMemoryDir, "playbook.yaml"));

        const result = await recordFeedback("harmful-test", { harmful: true });

        expect(result.type).toBe("harmful");

        const updated = await loadPlaybook(path.join(cassMemoryDir, "playbook.yaml"));
        const updatedBullet = findBullet(updated, "harmful-test");

        expect(updatedBullet?.harmfulCount).toBe(1);
        expect(updatedBullet?.feedbackEvents?.[0].type).toBe("harmful");
      } finally {
        process.env.HOME = originalHome;
      }
    });

    it("records harmful feedback with reason", async () => {
      const { home, cassMemoryDir } = await setupTestEnvironment();
      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;

        const playbook = createEmptyPlaybook("test");
        const bullet = createTestBullet({
          id: "reason-test",
          content: "Use deprecated API for compatibility"
        });
        playbook.bullets = [bullet];
        await savePlaybook(playbook, path.join(cassMemoryDir, "playbook.yaml"));

        await recordFeedback("reason-test", {
          harmful: true,
          reason: "outdated"
        });

        const updated = await loadPlaybook(path.join(cassMemoryDir, "playbook.yaml"));
        const updatedBullet = findBullet(updated, "reason-test");

        expect(updatedBullet?.feedbackEvents?.[0].reason).toBe("outdated");
      } finally {
        process.env.HOME = originalHome;
      }
    });

    it("defaults harmful reason to 'other' for unknown reasons", async () => {
      const { home, cassMemoryDir } = await setupTestEnvironment();
      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;

        const playbook = createEmptyPlaybook("test");
        const bullet = createTestBullet({
          id: "unknown-reason",
          content: "Test bullet"
        });
        playbook.bullets = [bullet];
        await savePlaybook(playbook, path.join(cassMemoryDir, "playbook.yaml"));

        await recordFeedback("unknown-reason", {
          harmful: true,
          reason: "some-invalid-reason"
        });

        const updated = await loadPlaybook(path.join(cassMemoryDir, "playbook.yaml"));
        const updatedBullet = findBullet(updated, "unknown-reason");

        expect(updatedBullet?.feedbackEvents?.[0].reason).toBe("other");
      } finally {
        process.env.HOME = originalHome;
      }
    });
  });

  describe("Mark with Session Context", () => {
    it("records session path in feedback event", async () => {
      const { home, cassMemoryDir } = await setupTestEnvironment();
      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;

        const playbook = createEmptyPlaybook("test");
        const bullet = createTestBullet({
          id: "session-test",
          content: "Test session tracking"
        });
        playbook.bullets = [bullet];
        await savePlaybook(playbook, path.join(cassMemoryDir, "playbook.yaml"));

        const sessionPath = "/path/to/session/123.jsonl";
        await recordFeedback("session-test", {
          helpful: true,
          session: sessionPath
        });

        const updated = await loadPlaybook(path.join(cassMemoryDir, "playbook.yaml"));
        const updatedBullet = findBullet(updated, "session-test");

        expect(updatedBullet?.feedbackEvents?.[0].sessionPath).toBe(sessionPath);
      } finally {
        process.env.HOME = originalHome;
      }
    });
  });

  describe("Mark Non-existent Bullet", () => {
    it("throws error for non-existent bullet", async () => {
      const { home, cassMemoryDir } = await setupTestEnvironment();
      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;

        // Create empty playbook
        const playbook = createEmptyPlaybook("test");
        await savePlaybook(playbook, path.join(cassMemoryDir, "playbook.yaml"));

        // Try to mark non-existent bullet
        await expect(
          recordFeedback("non-existent-bullet", { helpful: true })
        ).rejects.toThrow();
      } finally {
        process.env.HOME = originalHome;
      }
    });

    it("error message includes bullet ID", async () => {
      const { home, cassMemoryDir } = await setupTestEnvironment();
      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;

        const playbook = createEmptyPlaybook("test");
        await savePlaybook(playbook, path.join(cassMemoryDir, "playbook.yaml"));

        try {
          await recordFeedback("missing-bullet-xyz", { helpful: true });
          expect(true).toBe(false); // Should not reach here
        } catch (err: any) {
          expect(err.message).toContain("missing-bullet-xyz");
        }
      } finally {
        process.env.HOME = originalHome;
      }
    });
  });

  describe("Validation", () => {
    it("requires either helpful or harmful flag", async () => {
      await expect(
        recordFeedback("any-bullet", {})
      ).rejects.toThrow("Must specify --helpful or --harmful");
    });

    it("accepts only one of helpful or harmful", async () => {
      const { home, cassMemoryDir } = await setupTestEnvironment();
      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;

        const playbook = createEmptyPlaybook("test");
        const bullet = createTestBullet({ id: "dual-flag" });
        playbook.bullets = [bullet];
        await savePlaybook(playbook, path.join(cassMemoryDir, "playbook.yaml"));

        // When both flags are set, helpful takes precedence (first check)
        const result = await recordFeedback("dual-flag", { helpful: true, harmful: true });
        expect(result.type).toBe("helpful");
      } finally {
        process.env.HOME = originalHome;
      }
    });
  });

  describe("CLI Output", () => {
    it("outputs JSON when --json flag is used", async () => {
      const { home, cassMemoryDir } = await setupTestEnvironment();
      const originalHome = process.env.HOME;
      const originalExit = process.exit;

      try {
        process.env.HOME = home;
        process.exit = (() => {}) as any; // Prevent exit

        const playbook = createEmptyPlaybook("test");
        const bullet = createTestBullet({ id: "json-output" });
        playbook.bullets = [bullet];
        await savePlaybook(playbook, path.join(cassMemoryDir, "playbook.yaml"));

        const capture = captureConsole();
        try {
          await markCommand("json-output", { helpful: true, json: true });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        expect(() => JSON.parse(output)).not.toThrow();

        const result = JSON.parse(output);
        expect(result.success).toBe(true);
        expect(result.bulletId).toBe("json-output");
        expect(result.type).toBe("helpful");
        expect(result).toHaveProperty("newState");
        expect(result).toHaveProperty("effectiveScore");
      } finally {
        process.env.HOME = originalHome;
        process.exit = originalExit;
      }
    });

    it("outputs human-readable message without --json", async () => {
      const { home, cassMemoryDir } = await setupTestEnvironment();
      const originalHome = process.env.HOME;
      const originalExit = process.exit;

      try {
        process.env.HOME = home;
        process.exit = (() => {}) as any;

        const playbook = createEmptyPlaybook("test");
        const bullet = createTestBullet({ id: "human-output" });
        playbook.bullets = [bullet];
        await savePlaybook(playbook, path.join(cassMemoryDir, "playbook.yaml"));

        const capture = captureConsole();
        try {
          await markCommand("human-output", { helpful: true });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        expect(output).toContain("human-output");
        expect(output).toContain("helpful");
        expect(output.toLowerCase()).toContain("state");
        expect(output.toLowerCase()).toContain("score");
      } finally {
        process.env.HOME = originalHome;
        process.exit = originalExit;
      }
    });
  });

  describe("Repo vs Global Playbook", () => {
    it("updates repo playbook when bullet exists there", async () => {
      const { home, repo, cassMemoryDir, repoCassDir } = await setupTestEnvironment();
      const originalHome = process.env.HOME;
      const originalCwd = process.cwd();

      try {
        process.env.HOME = home;
        process.chdir(repo);

        // Create empty global playbook
        const globalPlaybook = createEmptyPlaybook("global");
        await savePlaybook(globalPlaybook, path.join(cassMemoryDir, "playbook.yaml"));

        // Create repo playbook with a bullet
        const repoPlaybook = createEmptyPlaybook("repo");
        const bullet = createTestBullet({
          id: "repo-bullet",
          content: "Repo-specific rule"
        });
        repoPlaybook.bullets = [bullet];
        await savePlaybook(repoPlaybook, path.join(repoCassDir, "playbook.yaml"));

        // Mark the bullet
        await recordFeedback("repo-bullet", { helpful: true });

        // Verify repo playbook was updated
        const updatedRepo = await loadPlaybook(path.join(repoCassDir, "playbook.yaml"));
        const updatedBullet = findBullet(updatedRepo, "repo-bullet");
        expect(updatedBullet?.helpfulCount).toBe(1);

        // Verify global playbook unchanged
        const updatedGlobal = await loadPlaybook(path.join(cassMemoryDir, "playbook.yaml"));
        expect(updatedGlobal.bullets.length).toBe(0);
      } finally {
        process.env.HOME = originalHome;
        process.chdir(originalCwd);
      }
    });

    it("updates global playbook when bullet only exists there", async () => {
      const { home, repo, cassMemoryDir, repoCassDir } = await setupTestEnvironment();
      const originalHome = process.env.HOME;
      const originalCwd = process.cwd();

      try {
        process.env.HOME = home;
        process.chdir(repo);

        // Create global playbook with a bullet
        const globalPlaybook = createEmptyPlaybook("global");
        const bullet = createTestBullet({
          id: "global-bullet",
          content: "Global rule"
        });
        globalPlaybook.bullets = [bullet];
        await savePlaybook(globalPlaybook, path.join(cassMemoryDir, "playbook.yaml"));

        // Create empty repo playbook
        const repoPlaybook = createEmptyPlaybook("repo");
        await savePlaybook(repoPlaybook, path.join(repoCassDir, "playbook.yaml"));

        // Mark the bullet
        await recordFeedback("global-bullet", { helpful: true });

        // Verify global playbook was updated
        const updatedGlobal = await loadPlaybook(path.join(cassMemoryDir, "playbook.yaml"));
        const updatedBullet = findBullet(updatedGlobal, "global-bullet");
        expect(updatedBullet?.helpfulCount).toBe(1);
      } finally {
        process.env.HOME = originalHome;
        process.chdir(originalCwd);
      }
    });
  });

  describe("Feedback Persistence", () => {
    it("feedback survives playbook reload", async () => {
      const { home, cassMemoryDir } = await setupTestEnvironment();
      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;

        // Create playbook
        const playbook = createEmptyPlaybook("test");
        const bullet = createTestBullet({
          id: "persist-test",
          content: "Test persistence"
        });
        playbook.bullets = [bullet];
        await savePlaybook(playbook, path.join(cassMemoryDir, "playbook.yaml"));

        // Record feedback
        await recordFeedback("persist-test", { helpful: true });

        // Reload from disk
        const reloaded = await loadPlaybook(path.join(cassMemoryDir, "playbook.yaml"));
        const reloadedBullet = findBullet(reloaded, "persist-test");

        expect(reloadedBullet?.helpfulCount).toBe(1);
        expect(reloadedBullet?.feedbackEvents?.length).toBe(1);
      } finally {
        process.env.HOME = originalHome;
      }
    });

    it("multiple feedback events are preserved", async () => {
      const { home, cassMemoryDir } = await setupTestEnvironment();
      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;

        const playbook = createEmptyPlaybook("test");
        const bullet = createTestBullet({
          id: "multi-feedback",
          content: "Multiple feedback test"
        });
        playbook.bullets = [bullet];
        await savePlaybook(playbook, path.join(cassMemoryDir, "playbook.yaml"));

        // Record multiple feedbacks
        await recordFeedback("multi-feedback", { helpful: true });
        await recordFeedback("multi-feedback", { helpful: true, session: "/session/1" });
        await recordFeedback("multi-feedback", { harmful: true, reason: "outdated" });

        const updated = await loadPlaybook(path.join(cassMemoryDir, "playbook.yaml"));
        const updatedBullet = findBullet(updated, "multi-feedback");

        expect(updatedBullet?.feedbackEvents?.length).toBe(3);
        expect(updatedBullet?.helpfulCount).toBe(2);
        expect(updatedBullet?.harmfulCount).toBe(1);
      } finally {
        process.env.HOME = originalHome;
      }
    });
  });

  describe("Maturity State Updates", () => {
    it("updates maturity state after feedback", async () => {
      const { home, cassMemoryDir } = await setupTestEnvironment();
      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;

        const playbook = createEmptyPlaybook("test");
        const bullet = createTestBullet({
          id: "maturity-test",
          content: "Test maturity updates",
          maturity: "candidate"
        });
        playbook.bullets = [bullet];
        await savePlaybook(playbook, path.join(cassMemoryDir, "playbook.yaml"));

        const result = await recordFeedback("maturity-test", { helpful: true });

        // Should return the new state
        expect(typeof result.state).toBe("string");

        const updated = await loadPlaybook(path.join(cassMemoryDir, "playbook.yaml"));
        const updatedBullet = findBullet(updated, "maturity-test");

        // Maturity should be updated based on feedback
        expect(updatedBullet?.maturity).toBeDefined();
        expect(updatedBullet?.updatedAt).toBeDefined();
      } finally {
        process.env.HOME = originalHome;
      }
    });
  });

  describe("Timestamp Recording", () => {
    it("records timestamp in feedback event", async () => {
      const { home, cassMemoryDir } = await setupTestEnvironment();
      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;

        const playbook = createEmptyPlaybook("test");
        const bullet = createTestBullet({ id: "timestamp-test" });
        playbook.bullets = [bullet];
        await savePlaybook(playbook, path.join(cassMemoryDir, "playbook.yaml"));

        const beforeMark = new Date().toISOString();
        await recordFeedback("timestamp-test", { helpful: true });
        const afterMark = new Date().toISOString();

        const updated = await loadPlaybook(path.join(cassMemoryDir, "playbook.yaml"));
        const updatedBullet = findBullet(updated, "timestamp-test");

        const eventTimestamp = updatedBullet?.feedbackEvents?.[0].timestamp;
        expect(eventTimestamp).toBeDefined();

        // Timestamp should be between before and after
        expect(eventTimestamp! >= beforeMark).toBe(true);
        expect(eventTimestamp! <= afterMark).toBe(true);
      } finally {
        process.env.HOME = originalHome;
      }
    });

    it("updates bullet updatedAt timestamp", async () => {
      const { home, cassMemoryDir } = await setupTestEnvironment();
      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;

        const playbook = createEmptyPlaybook("test");
        const bullet = createTestBullet({
          id: "updated-at-test",
          updatedAt: "2020-01-01T00:00:00Z"
        });
        playbook.bullets = [bullet];
        await savePlaybook(playbook, path.join(cassMemoryDir, "playbook.yaml"));

        await recordFeedback("updated-at-test", { helpful: true });

        const updated = await loadPlaybook(path.join(cassMemoryDir, "playbook.yaml"));
        const updatedBullet = findBullet(updated, "updated-at-test");

        // updatedAt should be newer than original
        expect(updatedBullet?.updatedAt! > "2020-01-01T00:00:00Z").toBe(true);
      } finally {
        process.env.HOME = originalHome;
      }
    });
  });
});
