/**
 * Unit tests for undo command
 *
 * Tests:
 * - Un-deprecate a deprecated bullet
 * - Undo last feedback event
 * - Hard delete a bullet
 * - Error handling for non-existent bullets
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "yaml";
import { undoCommand } from "../src/commands/undo.js";
import type { Playbook, PlaybookBullet } from "../src/types.js";
import {
  createTestBullet as factoryCreateBullet,
  createTestPlaybook as factoryCreatePlaybook,
} from "./helpers/factories.js";
import { withTempGitRepo } from "./helpers/git.js";
import { withTempCassHome } from "./helpers/temp.js";

/**
 * Capture console output during async function execution.
 */
function captureConsole() {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;

  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };

  return {
    logs,
    errors,
    restore: () => {
      console.log = originalLog;
      console.error = originalError;
    },
    getOutput: () => logs.join("\n"),
    getErrors: () => errors.join("\n"),
  };
}

// Test helper to create a bullet
function createTestBullet(overrides: Partial<PlaybookBullet> = {}): PlaybookBullet {
  return {
    id: overrides.id || "b-test123",
    content: "Test bullet content",
    category: "testing",
    kind: "workflow_rule",
    type: "rule",
    isNegative: false,
    scope: "global",
    source: "learned",
    tags: [],
    state: "active",
    maturity: "candidate",
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    sourceSessions: [],
    sourceAgents: [],
    helpfulCount: 0,
    harmfulCount: 0,
    feedbackEvents: [],
    deprecated: false,
    pinned: false,
    ...overrides,
    confidenceDecayHalfLifeDays: overrides.confidenceDecayHalfLifeDays ?? 90,
  };
}

// Test helper to create a playbook
function createTestPlaybook(bullets: PlaybookBullet[] = []): Playbook {
  return {
    schema_version: 2,
    name: "test-playbook",
    description: "Test playbook",
    metadata: {
      createdAt: "2025-01-01T00:00:00Z",
      totalReflections: 0,
      totalSessionsProcessed: 0,
    },
    deprecatedPatterns: [],
    bullets,
  };
}

describe("undo command - Unit Tests", () => {
  let testDir: string;
  let playbookPath: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "cass-undo-test-"));
    const cassMemoryDir = join(testDir, ".cass-memory");
    mkdirSync(cassMemoryDir, { recursive: true });
    playbookPath = join(cassMemoryDir, "playbook.yaml");

    // Create config
    const configPath = join(cassMemoryDir, "config.yaml");
    writeFileSync(
      configPath,
      yaml.stringify({
        playbookPath,
        diaryDir: join(cassMemoryDir, "diaries"),
        defaultLookbackDays: 30,
        llmProvider: "none",
      }),
    );
  });

  afterEach(() => {
    if (testDir) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("undeprecateBullet logic", () => {
    test("should restore deprecated bullet to active state", () => {
      const bullet = createTestBullet({
        deprecated: true,
        deprecatedAt: "2025-06-01T00:00:00Z",
        deprecationReason: "Test deprecation",
        state: "retired",
        maturity: "deprecated",
      });

      // Simulate undeprecation
      bullet.deprecated = false;
      bullet.deprecatedAt = undefined;
      bullet.deprecationReason = undefined;
      bullet.state = "active";
      bullet.maturity = "candidate";

      expect(bullet.deprecated).toBe(false);
      expect(bullet.deprecatedAt).toBeUndefined();
      expect(bullet.deprecationReason).toBeUndefined();
      expect(bullet.state).toBe("active");
      expect(bullet.maturity).toBe("candidate");
    });

    test("should preserve non-deprecated maturity if not deprecated", () => {
      const bullet = createTestBullet({
        deprecated: true,
        deprecatedAt: "2025-06-01T00:00:00Z",
        state: "retired",
        maturity: "established", // Was established before deprecation
      });

      // Simulate undeprecation - maturity should go to candidate if it was "deprecated"
      bullet.deprecated = false;
      bullet.deprecatedAt = undefined;
      bullet.state = "active";
      // If maturity was "deprecated", restore to "candidate"
      if (bullet.maturity === "deprecated") {
        bullet.maturity = "candidate";
      }

      // Since maturity was "established" (not "deprecated"), it should stay
      expect(bullet.maturity).toBe("established");
    });
  });

  describe("undoLastFeedback logic", () => {
    test("should remove last helpful feedback and decrement count", () => {
      const bullet = createTestBullet({
        helpfulCount: 3,
        harmfulCount: 1,
        feedbackEvents: [
          { type: "helpful", timestamp: "2025-01-01T00:00:00Z" },
          { type: "harmful", timestamp: "2025-01-02T00:00:00Z" },
          { type: "helpful", timestamp: "2025-01-03T00:00:00Z" },
        ],
      });

      // Simulate undo last feedback
      const lastEvent = bullet.feedbackEvents!.pop();
      if (lastEvent?.type === "helpful") {
        bullet.helpfulCount = Math.max(0, bullet.helpfulCount - 1);
      }

      expect(bullet.helpfulCount).toBe(2);
      expect(bullet.harmfulCount).toBe(1);
      expect(bullet.feedbackEvents).toHaveLength(2);
    });

    test("should remove last harmful feedback and decrement count", () => {
      const bullet = createTestBullet({
        helpfulCount: 2,
        harmfulCount: 2,
        feedbackEvents: [
          { type: "helpful", timestamp: "2025-01-01T00:00:00Z" },
          { type: "harmful", timestamp: "2025-01-02T00:00:00Z" },
        ],
      });

      // Simulate undo last feedback
      const lastEvent = bullet.feedbackEvents!.pop();
      if (lastEvent?.type === "harmful") {
        bullet.harmfulCount = Math.max(0, bullet.harmfulCount - 1);
      }

      expect(bullet.helpfulCount).toBe(2);
      expect(bullet.harmfulCount).toBe(1);
      expect(bullet.feedbackEvents).toHaveLength(1);
    });

    test("should not go below 0 when undoing feedback", () => {
      const bullet = createTestBullet({
        helpfulCount: 0, // Already at 0
        harmfulCount: 0,
        feedbackEvents: [{ type: "helpful", timestamp: "2025-01-01T00:00:00Z" }],
      });

      // Simulate undo
      const lastEvent = bullet.feedbackEvents!.pop();
      if (lastEvent?.type === "helpful") {
        bullet.helpfulCount = Math.max(0, bullet.helpfulCount - 1);
      }

      expect(bullet.helpfulCount).toBe(0); // Should not be negative
    });

    test("should handle empty feedback events", () => {
      const bullet = createTestBullet({
        feedbackEvents: [],
      });

      const lastEvent = bullet.feedbackEvents!.length > 0 ? bullet.feedbackEvents!.pop() : null;

      expect(lastEvent).toBeNull();
      expect(bullet.feedbackEvents).toHaveLength(0);
    });
  });

  describe("hard delete logic", () => {
    test("should remove bullet from playbook", () => {
      const bullet1 = createTestBullet({ id: "b-keep" });
      const bullet2 = createTestBullet({ id: "b-delete" });
      const playbook = createTestPlaybook([bullet1, bullet2]);

      // Simulate hard delete
      const index = playbook.bullets.findIndex((b) => b.id === "b-delete");
      playbook.bullets.splice(index, 1);

      expect(playbook.bullets).toHaveLength(1);
      expect(playbook.bullets[0].id).toBe("b-keep");
    });
  });

  describe("playbook file operations", () => {
    test("should save playbook with undeprecated bullet", () => {
      const bullet = createTestBullet({
        id: "b-test",
        deprecated: true,
        deprecatedAt: "2025-06-01T00:00:00Z",
        deprecationReason: "Test reason",
        state: "retired",
        maturity: "deprecated",
      });
      const playbook = createTestPlaybook([bullet]);

      // Save original
      writeFileSync(playbookPath, yaml.stringify(playbook));

      // Read and modify
      const loaded = yaml.parse(readFileSync(playbookPath, "utf-8"));
      const loadedBullet = loaded.bullets[0];

      // Undeprecate
      loadedBullet.deprecated = false;
      loadedBullet.deprecatedAt = undefined;
      loadedBullet.deprecationReason = undefined;
      loadedBullet.state = "active";
      loadedBullet.maturity = "candidate";

      // Save again
      writeFileSync(playbookPath, yaml.stringify(loaded));

      // Verify
      const final = yaml.parse(readFileSync(playbookPath, "utf-8"));
      expect(final.bullets[0].deprecated).toBe(false);
      expect(final.bullets[0].state).toBe("active");
      expect(final.bullets[0].maturity).toBe("candidate");
    });

    test("should save playbook with updated feedback counts", () => {
      const bullet = createTestBullet({
        id: "b-test",
        helpfulCount: 5,
        harmfulCount: 2,
        feedbackEvents: [
          { type: "helpful", timestamp: "2025-01-01T00:00:00Z" },
          { type: "helpful", timestamp: "2025-01-02T00:00:00Z" },
        ],
      });
      const playbook = createTestPlaybook([bullet]);

      // Save original
      writeFileSync(playbookPath, yaml.stringify(playbook));

      // Read and modify
      const loaded = yaml.parse(readFileSync(playbookPath, "utf-8"));
      const loadedBullet = loaded.bullets[0];

      // Undo last feedback
      loadedBullet.feedbackEvents.pop();
      loadedBullet.helpfulCount = 4;

      // Save again
      writeFileSync(playbookPath, yaml.stringify(loaded));

      // Verify
      const final = yaml.parse(readFileSync(playbookPath, "utf-8"));
      expect(final.bullets[0].helpfulCount).toBe(4);
      expect(final.bullets[0].feedbackEvents).toHaveLength(1);
    });

    test("should save playbook without deleted bullet", () => {
      const bullet1 = createTestBullet({ id: "b-keep", content: "Keep this" });
      const bullet2 = createTestBullet({ id: "b-delete", content: "Delete this" });
      const playbook = createTestPlaybook([bullet1, bullet2]);

      // Save original
      writeFileSync(playbookPath, yaml.stringify(playbook));

      // Read and modify
      const loaded = yaml.parse(readFileSync(playbookPath, "utf-8"));
      const index = loaded.bullets.findIndex((b: any) => b.id === "b-delete");
      loaded.bullets.splice(index, 1);

      // Save again
      writeFileSync(playbookPath, yaml.stringify(loaded));

      // Verify
      const final = yaml.parse(readFileSync(playbookPath, "utf-8"));
      expect(final.bullets).toHaveLength(1);
      expect(final.bullets[0].id).toBe("b-keep");
    });
  });

  describe("dry-run logic", () => {
    test("should compute correct preview for un-deprecate action", () => {
      const bullet = createTestBullet({
        id: "b-dry-test",
        content: "Test bullet for dry run",
        deprecated: true,
        deprecatedAt: "2025-06-01T00:00:00Z",
        deprecationReason: "Test deprecation",
        state: "retired",
        maturity: "deprecated",
      });

      // Simulate dry-run preview computation
      const plan = {
        dryRun: true,
        action: "un-deprecate",
        bulletId: bullet.id,
        before: {
          deprecated: bullet.deprecated,
          state: bullet.state,
          maturity: bullet.maturity,
        },
        wouldChange: "Bullet would be restored to active state",
      };

      expect(plan.dryRun).toBe(true);
      expect(plan.action).toBe("un-deprecate");
      expect(plan.before.deprecated).toBe(true);
      expect(plan.before.state).toBe("retired");
      expect(plan.wouldChange).toContain("restored");

      // Verify bullet was NOT modified
      expect(bullet.deprecated).toBe(true);
      expect(bullet.state).toBe("retired");
    });

    test("should compute correct preview for undo-feedback action", () => {
      const bullet = createTestBullet({
        id: "b-feedback-dry",
        helpfulCount: 5,
        harmfulCount: 2,
        feedbackEvents: [
          { type: "helpful", timestamp: "2025-01-01T00:00:00Z" },
          { type: "harmful", timestamp: "2025-01-02T00:00:00Z" },
        ],
      });

      const lastEvent =
        bullet.feedbackEvents!.length > 0
          ? bullet.feedbackEvents![bullet.feedbackEvents!.length - 1]
          : null;

      // Simulate dry-run preview
      const plan = {
        dryRun: true,
        action: "undo-feedback",
        bulletId: bullet.id,
        before: {
          helpfulCount: bullet.helpfulCount,
          harmfulCount: bullet.harmfulCount,
          lastFeedback: lastEvent,
        },
        wouldChange: lastEvent
          ? `Would remove last ${lastEvent.type} feedback`
          : "No feedback to undo",
      };

      expect(plan.dryRun).toBe(true);
      expect(plan.action).toBe("undo-feedback");
      expect(plan.before.lastFeedback).toEqual({
        type: "harmful",
        timestamp: "2025-01-02T00:00:00Z",
      });
      expect(plan.wouldChange).toContain("harmful");

      // Verify bullet was NOT modified
      expect(bullet.feedbackEvents).toHaveLength(2);
      expect(bullet.harmfulCount).toBe(2);
    });

    test("should compute correct preview for hard-delete action", () => {
      const bullet = createTestBullet({
        id: "b-delete-dry",
        content: "Bullet to preview deletion",
      });

      // Simulate dry-run preview
      const plan = {
        dryRun: true,
        action: "hard-delete",
        bulletId: bullet.id,
        preview: bullet.content.slice(0, 100),
        wouldChange: "Bullet would be permanently removed from playbook",
      };

      expect(plan.dryRun).toBe(true);
      expect(plan.action).toBe("hard-delete");
      expect(plan.preview).toBe("Bullet to preview deletion");
      expect(plan.wouldChange).toContain("permanently removed");
    });
  });
});

describe("undoCommand integration", () => {
  async function writePlaybook(path: string, playbook: Playbook) {
    writeFileSync(path, yaml.stringify(playbook));
  }

  test("returns error when bullet not found (JSON mode)", async () => {
    await withTempCassHome(async (env) => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        try {
          // Create empty playbook
          await writePlaybook(env.playbookPath, factoryCreatePlaybook([]));

          const capture = captureConsole();
          try {
            await undoCommand("b-nonexistent", { json: true });
            const output = capture.getOutput();
            expect(output).toContain("error");
            expect(output).toContain("not found");
          } finally {
            capture.restore();
          }
        } finally {
          process.chdir(originalCwd);
        }
      });
    });
  });

  test("un-deprecates a deprecated bullet (JSON mode)", async () => {
    await withTempCassHome(async (env) => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        try {
          const bullet = factoryCreateBullet({
            id: "b-deprecated-test",
            content: "Test deprecated bullet",
            deprecated: true,
            deprecatedAt: "2025-01-01T00:00:00Z",
            deprecationReason: "Test reason",
            state: "retired",
            maturity: "deprecated",
          });
          await writePlaybook(env.playbookPath, factoryCreatePlaybook([bullet]));

          const capture = captureConsole();
          try {
            await undoCommand("b-deprecated-test", { json: true });
            const output = capture.getOutput();
            expect(output).toContain("success");
            expect(output).toContain("un-deprecate");
          } finally {
            capture.restore();
          }

          // Verify the playbook was updated
          const updated = yaml.parse(readFileSync(env.playbookPath, "utf-8"));
          expect(updated.bullets[0].deprecated).toBe(false);
          expect(updated.bullets[0].state).toBe("active");
        } finally {
          process.chdir(originalCwd);
        }
      });
    });
  });

  test("returns error when trying to un-deprecate non-deprecated bullet", async () => {
    await withTempCassHome(async (env) => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        try {
          const bullet = factoryCreateBullet({
            id: "b-active-test",
            content: "Active bullet",
            deprecated: false,
            state: "active",
          });
          await writePlaybook(env.playbookPath, factoryCreatePlaybook([bullet]));

          const capture = captureConsole();
          try {
            await undoCommand("b-active-test", { json: true });
            const output = capture.getOutput();
            expect(output).toContain("error");
            expect(output).toContain("not deprecated");
          } finally {
            capture.restore();
          }
        } finally {
          process.chdir(originalCwd);
        }
      });
    });
  });

  test("undoes last feedback event (JSON mode)", async () => {
    await withTempCassHome(async (env) => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        try {
          const bullet = factoryCreateBullet({
            id: "b-feedback-test",
            content: "Bullet with feedback",
            helpfulCount: 3,
            harmfulCount: 1,
            feedbackEvents: [
              { type: "helpful", timestamp: "2025-01-01T00:00:00Z", sessionPath: "/tmp/s1" },
              { type: "harmful", timestamp: "2025-01-02T00:00:00Z", sessionPath: "/tmp/s2" },
            ],
          });
          await writePlaybook(env.playbookPath, factoryCreatePlaybook([bullet]));

          const capture = captureConsole();
          try {
            await undoCommand("b-feedback-test", { feedback: true, json: true });
            const output = capture.getOutput();
            expect(output).toContain("success");
            expect(output).toContain("undo-feedback");
          } finally {
            capture.restore();
          }

          // Verify the playbook was updated
          const updated = yaml.parse(readFileSync(env.playbookPath, "utf-8"));
          expect(updated.bullets[0].harmfulCount).toBe(0);
          expect(updated.bullets[0].feedbackEvents).toHaveLength(1);
        } finally {
          process.chdir(originalCwd);
        }
      });
    });
  });

  test("returns error when no feedback to undo", async () => {
    await withTempCassHome(async (env) => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        try {
          const bullet = factoryCreateBullet({
            id: "b-no-feedback",
            content: "Bullet without feedback",
            feedbackEvents: [],
          });
          await writePlaybook(env.playbookPath, factoryCreatePlaybook([bullet]));

          const capture = captureConsole();
          try {
            await undoCommand("b-no-feedback", { feedback: true, json: true });
            const output = capture.getOutput();
            expect(output).toContain("error");
            expect(output).toContain("No feedback");
          } finally {
            capture.restore();
          }
        } finally {
          process.chdir(originalCwd);
        }
      });
    });
  });

  test("hard deletes a bullet with --yes flag (JSON mode)", async () => {
    await withTempCassHome(async (env) => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        try {
          const bullet1 = factoryCreateBullet({
            id: "b-keep",
            content: "Keep this bullet",
          });
          const bullet2 = factoryCreateBullet({
            id: "b-delete",
            content: "Delete this bullet",
          });
          await writePlaybook(env.playbookPath, factoryCreatePlaybook([bullet1, bullet2]));

          const capture = captureConsole();
          try {
            await undoCommand("b-delete", { hard: true, yes: true, json: true });
            const output = capture.getOutput();
            expect(output).toContain("success");
            expect(output).toContain("hard-delete");
          } finally {
            capture.restore();
          }

          // Verify the playbook was updated
          const updated = yaml.parse(readFileSync(env.playbookPath, "utf-8"));
          expect(updated.bullets).toHaveLength(1);
          expect(updated.bullets[0].id).toBe("b-keep");
        } finally {
          process.chdir(originalCwd);
        }
      });
    });
  });

  test("hard delete requires confirmation without --yes", async () => {
    await withTempCassHome(async (env) => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        try {
          const bullet = factoryCreateBullet({
            id: "b-confirm-delete",
            content: "Bullet requiring confirmation",
          });
          await writePlaybook(env.playbookPath, factoryCreatePlaybook([bullet]));

          const capture = captureConsole();
          try {
            await undoCommand("b-confirm-delete", { hard: true, json: true });
            const output = capture.getOutput();
            expect(output).toContain("error");
            expect(output).toContain("Confirmation required");
          } finally {
            capture.restore();
          }

          // Bullet should still exist
          const updated = yaml.parse(readFileSync(env.playbookPath, "utf-8"));
          expect(updated.bullets).toHaveLength(1);
        } finally {
          process.chdir(originalCwd);
        }
      });
    });
  });

  test("dry-run shows plan without making changes (JSON mode)", async () => {
    await withTempCassHome(async (env) => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        try {
          const bullet = factoryCreateBullet({
            id: "b-dryrun-test",
            content: "Bullet for dry run test",
            deprecated: true,
            state: "retired",
            maturity: "deprecated",
          });
          await writePlaybook(env.playbookPath, factoryCreatePlaybook([bullet]));

          const capture = captureConsole();
          try {
            await undoCommand("b-dryrun-test", { dryRun: true, json: true });
            const output = capture.getOutput();
            expect(output).toContain("success");
            expect(output).toContain("dryRun");
            expect(output).toContain("un-deprecate");
          } finally {
            capture.restore();
          }

          // Verify the playbook was NOT changed
          const unchanged = yaml.parse(readFileSync(env.playbookPath, "utf-8"));
          expect(unchanged.bullets[0].deprecated).toBe(true);
          expect(unchanged.bullets[0].state).toBe("retired");
        } finally {
          process.chdir(originalCwd);
        }
      });
    });
  });

  test("dry-run for feedback undo shows last event", async () => {
    await withTempCassHome(async (env) => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        try {
          const bullet = factoryCreateBullet({
            id: "b-feedback-dryrun",
            content: "Bullet for feedback dry run",
            helpfulCount: 2,
            feedbackEvents: [
              { type: "helpful", timestamp: "2025-01-01T00:00:00Z", sessionPath: "/tmp/s1" },
            ],
          });
          await writePlaybook(env.playbookPath, factoryCreatePlaybook([bullet]));

          const capture = captureConsole();
          try {
            await undoCommand("b-feedback-dryrun", { feedback: true, dryRun: true, json: true });
            const output = capture.getOutput();
            expect(output).toContain("success");
            expect(output).toContain("undo-feedback");
            expect(output).toContain("helpful");
          } finally {
            capture.restore();
          }

          // Verify the playbook was NOT changed
          const unchanged = yaml.parse(readFileSync(env.playbookPath, "utf-8"));
          expect(unchanged.bullets[0].feedbackEvents).toHaveLength(1);
        } finally {
          process.chdir(originalCwd);
        }
      });
    });
  });

  test("dry-run for hard delete shows preview", async () => {
    await withTempCassHome(async (env) => {
      await withTempGitRepo(async (repoDir) => {
        const originalCwd = process.cwd();
        process.chdir(repoDir);

        try {
          const bullet = factoryCreateBullet({
            id: "b-hard-dryrun",
            content: "Bullet for hard delete dry run",
          });
          await writePlaybook(env.playbookPath, factoryCreatePlaybook([bullet]));

          const capture = captureConsole();
          try {
            await undoCommand("b-hard-dryrun", { hard: true, dryRun: true, json: true });
            const output = capture.getOutput();
            expect(output).toContain("success");
            expect(output).toContain("hard-delete");
            expect(output).toContain("permanently removed");
          } finally {
            capture.restore();
          }

          // Verify the playbook was NOT changed
          const unchanged = yaml.parse(readFileSync(env.playbookPath, "utf-8"));
          expect(unchanged.bullets).toHaveLength(1);
        } finally {
          process.chdir(originalCwd);
        }
      });
    });
  });
});
