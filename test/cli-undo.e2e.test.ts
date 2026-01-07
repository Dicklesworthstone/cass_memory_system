/**
 * E2E Tests for CLI undo command - Revert bad curation decisions
 *
 * Tests the `cm undo` command which:
 * - Un-deprecates a deprecated bullet (default action)
 * - Undoes the last feedback event on a bullet (--feedback)
 * - Hard deletes a bullet permanently (--hard)
 * - Supports dry-run mode (--dry-run)
 */
import { describe, it, expect } from "bun:test";
import { undoCommand } from "../src/commands/undo.js";
import { withTempCassHome } from "./helpers/temp.js";
import { createTestBullet, createTestPlaybook } from "./helpers/factories.js";
import { savePlaybook, loadPlaybook, findBullet } from "../src/playbook.js";
import { createE2ELogger } from "./helpers/e2e-logger.js";
import { FeedbackEvent } from "../src/types.js";

// Helper to capture console output
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
    }
  };
}

describe("E2E: CLI undo command", () => {
  describe("un-deprecate action (default)", () => {
    it("restores a deprecated bullet to active state", async () => {
      const log = createE2ELogger("undo: un-deprecate bullet");
      log.setRepro("bun test test/cli-undo.e2e.test.ts");

      await log.run(async () => {
        await withTempCassHome(async (env) => {
          const originalCwd = process.cwd();
          process.chdir(env.home);

          try {
            // Create a deprecated bullet
            const bullet = createTestBullet({
              id: "deprecated-bullet",
              content: "This bullet was deprecated",
              deprecated: true,
              deprecatedAt: "2025-01-01T00:00:00Z",
              deprecationReason: "Testing deprecation",
              state: "retired",
              maturity: "deprecated"
            });
            const playbook = createTestPlaybook([bullet]);
            await savePlaybook(playbook, env.playbookPath);

            log.step("Created playbook with deprecated bullet", { bulletId: bullet.id });

            const capture = captureConsole();
            try {
              await undoCommand("deprecated-bullet", {});
            } finally {
              capture.restore();
            }

            log.snapshot("output", { logs: capture.logs, errors: capture.errors });

            // Verify output
            const allOutput = capture.logs.join("\n");
            expect(allOutput).toContain("UN-DEPRECATE");
            expect(allOutput).toContain("deprecated-bullet");
            expect(allOutput).toContain("Restored");

            // Verify bullet is no longer deprecated
            const updatedPlaybook = await loadPlaybook(env.playbookPath);
            const restoredBullet = findBullet(updatedPlaybook, "deprecated-bullet");
            log.snapshot("restored bullet", restoredBullet);

            expect(restoredBullet).toBeDefined();
            expect(restoredBullet!.deprecated).toBe(false);
            expect(restoredBullet!.state).toBe("active");
            expect(restoredBullet!.maturity).toBe("candidate");
          } finally {
            process.chdir(originalCwd);
          }
        }, "undo-un-deprecate");
      });
    });

    it("returns error when bullet is not deprecated", async () => {
      const log = createE2ELogger("undo: not deprecated error");
      log.setRepro("bun test test/cli-undo.e2e.test.ts");

      await log.run(async () => {
        await withTempCassHome(async (env) => {
          const originalCwd = process.cwd();
          process.chdir(env.home);

          try {
            // Create an active (not deprecated) bullet
            const bullet = createTestBullet({
              id: "active-bullet",
              content: "This bullet is active",
              deprecated: false,
              state: "active"
            });
            const playbook = createTestPlaybook([bullet]);
            await savePlaybook(playbook, env.playbookPath);

            const capture = captureConsole();
            try {
              await undoCommand("active-bullet", {});
            } finally {
              capture.restore();
            }

            log.snapshot("output", { logs: capture.logs, errors: capture.errors });

            // Should report error - bullet not deprecated
            const allOutput = [...capture.logs, ...capture.errors].join("\n");
            expect(allOutput).toContain("not deprecated");
          } finally {
            process.chdir(originalCwd);
          }
        }, "undo-not-deprecated-error");
      });
    });
  });

  describe("undo-feedback action (--feedback)", () => {
    it("removes the last feedback event from a bullet", async () => {
      const log = createE2ELogger("undo: undo-feedback");
      log.setRepro("bun test test/cli-undo.e2e.test.ts");

      await log.run(async () => {
        await withTempCassHome(async (env) => {
          const originalCwd = process.cwd();
          process.chdir(env.home);

          try {
            // Create a bullet with feedback events
            const feedbackEvents: FeedbackEvent[] = [
              { type: "helpful", timestamp: "2025-01-01T10:00:00Z" },
              { type: "harmful", timestamp: "2025-01-02T10:00:00Z", reason: "caused_bug" }
            ];
            const bullet = createTestBullet({
              id: "feedback-bullet",
              content: "Bullet with feedback",
              feedbackEvents,
              helpfulCount: 1,
              harmfulCount: 1
            });
            const playbook = createTestPlaybook([bullet]);
            await savePlaybook(playbook, env.playbookPath);

            log.step("Created bullet with feedback", { feedbackCount: feedbackEvents.length });

            const capture = captureConsole();
            try {
              await undoCommand("feedback-bullet", { feedback: true });
            } finally {
              capture.restore();
            }

            log.snapshot("output", { logs: capture.logs, errors: capture.errors });

            // Verify output
            const allOutput = capture.logs.join("\n");
            expect(allOutput).toContain("UNDO FEEDBACK");
            expect(allOutput).toContain("harmful");

            // Verify feedback was removed
            const updatedPlaybook = await loadPlaybook(env.playbookPath);
            const updatedBullet = findBullet(updatedPlaybook, "feedback-bullet");
            log.snapshot("updated bullet", updatedBullet);

            expect(updatedBullet).toBeDefined();
            expect(updatedBullet!.feedbackEvents).toHaveLength(1);
            expect(updatedBullet!.harmfulCount).toBe(0);
            expect(updatedBullet!.helpfulCount).toBe(1);
          } finally {
            process.chdir(originalCwd);
          }
        }, "undo-feedback");
      });
    });

    it("returns error when no feedback events exist", async () => {
      const log = createE2ELogger("undo: no feedback error");
      log.setRepro("bun test test/cli-undo.e2e.test.ts");

      await log.run(async () => {
        await withTempCassHome(async (env) => {
          const originalCwd = process.cwd();
          process.chdir(env.home);

          try {
            // Create a bullet with no feedback
            const bullet = createTestBullet({
              id: "no-feedback-bullet",
              content: "Bullet without feedback",
              feedbackEvents: [],
              helpfulCount: 0,
              harmfulCount: 0
            });
            const playbook = createTestPlaybook([bullet]);
            await savePlaybook(playbook, env.playbookPath);

            const capture = captureConsole();
            try {
              await undoCommand("no-feedback-bullet", { feedback: true });
            } finally {
              capture.restore();
            }

            log.snapshot("output", { logs: capture.logs, errors: capture.errors });

            // Should report error - no feedback to undo
            const allOutput = [...capture.logs, ...capture.errors].join("\n");
            expect(allOutput).toContain("No feedback");
          } finally {
            process.chdir(originalCwd);
          }
        }, "undo-no-feedback-error");
      });
    });
  });

  describe("hard-delete action (--hard)", () => {
    it("permanently deletes a bullet with --yes confirmation", async () => {
      const log = createE2ELogger("undo: hard-delete");
      log.setRepro("bun test test/cli-undo.e2e.test.ts");

      await log.run(async () => {
        await withTempCassHome(async (env) => {
          const originalCwd = process.cwd();
          process.chdir(env.home);

          try {
            // Create a bullet to delete
            const bullet = createTestBullet({
              id: "delete-bullet",
              content: "This bullet will be deleted"
            });
            const playbook = createTestPlaybook([bullet]);
            await savePlaybook(playbook, env.playbookPath);

            log.step("Created bullet to delete", { bulletId: bullet.id });

            const capture = captureConsole();
            try {
              await undoCommand("delete-bullet", { hard: true, yes: true });
            } finally {
              capture.restore();
            }

            log.snapshot("output", { logs: capture.logs, errors: capture.errors });

            // Verify output
            const allOutput = capture.logs.join("\n");
            expect(allOutput).toContain("HARD DELETE");
            expect(allOutput).toContain("permanently deleted");

            // Verify bullet is gone
            const updatedPlaybook = await loadPlaybook(env.playbookPath);
            const deletedBullet = findBullet(updatedPlaybook, "delete-bullet");
            log.snapshot("deleted bullet lookup", { found: !!deletedBullet });

            expect(deletedBullet).toBeUndefined();
          } finally {
            process.chdir(originalCwd);
          }
        }, "undo-hard-delete");
      });
    });

    it("requires confirmation without --yes flag", async () => {
      const log = createE2ELogger("undo: hard-delete needs confirmation");
      log.setRepro("bun test test/cli-undo.e2e.test.ts");

      await log.run(async () => {
        await withTempCassHome(async (env) => {
          const originalCwd = process.cwd();
          process.chdir(env.home);

          try {
            // Create a bullet
            const bullet = createTestBullet({
              id: "confirm-delete-bullet",
              content: "This needs confirmation"
            });
            const playbook = createTestPlaybook([bullet]);
            await savePlaybook(playbook, env.playbookPath);

            const capture = captureConsole();
            try {
              // Note: without --yes, this should fail in non-interactive mode
              await undoCommand("confirm-delete-bullet", { hard: true, json: true });
            } finally {
              capture.restore();
            }

            log.snapshot("output", { logs: capture.logs, errors: capture.errors });

            // Should require confirmation
            const allOutput = [...capture.logs, ...capture.errors].join("\n");
            expect(allOutput).toContain("Confirmation required");

            // Bullet should still exist
            const updatedPlaybook = await loadPlaybook(env.playbookPath);
            const stillExists = findBullet(updatedPlaybook, "confirm-delete-bullet");
            expect(stillExists).toBeDefined();
          } finally {
            process.chdir(originalCwd);
          }
        }, "undo-hard-delete-confirmation");
      });
    });
  });

  describe("dry-run mode (--dry-run)", () => {
    it("shows what un-deprecate would do without making changes", async () => {
      const log = createE2ELogger("undo: dry-run un-deprecate");
      log.setRepro("bun test test/cli-undo.e2e.test.ts");

      await log.run(async () => {
        await withTempCassHome(async (env) => {
          const originalCwd = process.cwd();
          process.chdir(env.home);

          try {
            // Create a deprecated bullet
            const bullet = createTestBullet({
              id: "dry-run-bullet",
              content: "This is a dry run test",
              deprecated: true,
              deprecatedAt: "2025-01-01T00:00:00Z",
              deprecationReason: "Test reason",
              state: "retired",
              maturity: "deprecated"
            });
            const playbook = createTestPlaybook([bullet]);
            await savePlaybook(playbook, env.playbookPath);

            const capture = captureConsole();
            try {
              await undoCommand("dry-run-bullet", { dryRun: true });
            } finally {
              capture.restore();
            }

            log.snapshot("output", { logs: capture.logs, errors: capture.errors });

            // Verify dry-run output
            const allOutput = capture.logs.join("\n");
            expect(allOutput).toContain("DRY RUN");
            expect(allOutput).toContain("un-deprecate");
            expect(allOutput).toContain("Would:");

            // Verify bullet is still deprecated (no changes made)
            const updatedPlaybook = await loadPlaybook(env.playbookPath);
            const unchangedBullet = findBullet(updatedPlaybook, "dry-run-bullet");
            expect(unchangedBullet!.deprecated).toBe(true);
          } finally {
            process.chdir(originalCwd);
          }
        }, "undo-dry-run-un-deprecate");
      });
    });

    it("shows what undo-feedback would do without making changes", async () => {
      const log = createE2ELogger("undo: dry-run feedback");
      log.setRepro("bun test test/cli-undo.e2e.test.ts");

      await log.run(async () => {
        await withTempCassHome(async (env) => {
          const originalCwd = process.cwd();
          process.chdir(env.home);

          try {
            // Create a bullet with feedback
            const feedbackEvents: FeedbackEvent[] = [
              { type: "helpful", timestamp: "2025-01-01T10:00:00Z" }
            ];
            const bullet = createTestBullet({
              id: "dry-run-feedback-bullet",
              content: "Dry run feedback test",
              feedbackEvents,
              helpfulCount: 1
            });
            const playbook = createTestPlaybook([bullet]);
            await savePlaybook(playbook, env.playbookPath);

            const capture = captureConsole();
            try {
              await undoCommand("dry-run-feedback-bullet", { feedback: true, dryRun: true });
            } finally {
              capture.restore();
            }

            log.snapshot("output", { logs: capture.logs, errors: capture.errors });

            // Verify dry-run output
            const allOutput = capture.logs.join("\n");
            expect(allOutput).toContain("DRY RUN");
            expect(allOutput.toUpperCase()).toContain("UNDO-FEEDBACK");

            // Verify feedback is still there (no changes made)
            const updatedPlaybook = await loadPlaybook(env.playbookPath);
            const unchangedBullet = findBullet(updatedPlaybook, "dry-run-feedback-bullet");
            expect(unchangedBullet!.feedbackEvents).toHaveLength(1);
          } finally {
            process.chdir(originalCwd);
          }
        }, "undo-dry-run-feedback");
      });
    });

    it("shows what hard-delete would do without making changes", async () => {
      const log = createE2ELogger("undo: dry-run hard-delete");
      log.setRepro("bun test test/cli-undo.e2e.test.ts");

      await log.run(async () => {
        await withTempCassHome(async (env) => {
          const originalCwd = process.cwd();
          process.chdir(env.home);

          try {
            // Create a bullet
            const bullet = createTestBullet({
              id: "dry-run-delete-bullet",
              content: "Dry run delete test"
            });
            const playbook = createTestPlaybook([bullet]);
            await savePlaybook(playbook, env.playbookPath);

            const capture = captureConsole();
            try {
              await undoCommand("dry-run-delete-bullet", { hard: true, dryRun: true });
            } finally {
              capture.restore();
            }

            log.snapshot("output", { logs: capture.logs, errors: capture.errors });

            // Verify dry-run output
            const allOutput = capture.logs.join("\n");
            expect(allOutput).toContain("DRY RUN");
            expect(allOutput).toContain("hard-delete");
            expect(allOutput).toContain("permanently removed");

            // Verify bullet still exists (no changes made)
            const updatedPlaybook = await loadPlaybook(env.playbookPath);
            const stillExists = findBullet(updatedPlaybook, "dry-run-delete-bullet");
            expect(stillExists).toBeDefined();
          } finally {
            process.chdir(originalCwd);
          }
        }, "undo-dry-run-hard-delete");
      });
    });
  });

  describe("JSON output mode", () => {
    it("outputs valid JSON for un-deprecate success", async () => {
      const log = createE2ELogger("undo: JSON un-deprecate");
      log.setRepro("bun test test/cli-undo.e2e.test.ts");

      await log.run(async () => {
        await withTempCassHome(async (env) => {
          const originalCwd = process.cwd();
          process.chdir(env.home);

          try {
            // Create a deprecated bullet
            const bullet = createTestBullet({
              id: "json-undeprecate-bullet",
              deprecated: true,
              deprecatedAt: "2025-01-01T00:00:00Z",
              deprecationReason: "Test",
              state: "retired",
              maturity: "deprecated"
            });
            const playbook = createTestPlaybook([bullet]);
            await savePlaybook(playbook, env.playbookPath);

            const capture = captureConsole();
            try {
              await undoCommand("json-undeprecate-bullet", { json: true });
            } finally {
              capture.restore();
            }

            log.snapshot("output", { logs: capture.logs, errors: capture.errors });

            // Find and parse JSON output
            const jsonOutput = capture.logs.find(l => l.startsWith("{"));
            expect(jsonOutput).toBeDefined();

            const parsed = JSON.parse(jsonOutput!);
            log.snapshot("parsed JSON", parsed);

            expect(parsed.success).toBe(true);
            expect(parsed.command).toBe("undo");
            expect(parsed.data.action).toBe("un-deprecate");
            expect(parsed.data.bulletId).toBe("json-undeprecate-bullet");
            expect(parsed.data.after.deprecated).toBe(false);
          } finally {
            process.chdir(originalCwd);
          }
        }, "undo-json-un-deprecate");
      });
    });

    it("outputs valid JSON for undo-feedback success", async () => {
      const log = createE2ELogger("undo: JSON undo-feedback");
      log.setRepro("bun test test/cli-undo.e2e.test.ts");

      await log.run(async () => {
        await withTempCassHome(async (env) => {
          const originalCwd = process.cwd();
          process.chdir(env.home);

          try {
            // Create a bullet with feedback
            const feedbackEvents: FeedbackEvent[] = [
              { type: "helpful", timestamp: "2025-01-01T10:00:00Z" }
            ];
            const bullet = createTestBullet({
              id: "json-feedback-bullet",
              feedbackEvents,
              helpfulCount: 1
            });
            const playbook = createTestPlaybook([bullet]);
            await savePlaybook(playbook, env.playbookPath);

            const capture = captureConsole();
            try {
              await undoCommand("json-feedback-bullet", { feedback: true, json: true });
            } finally {
              capture.restore();
            }

            log.snapshot("output", { logs: capture.logs, errors: capture.errors });

            // Find and parse JSON output
            const jsonOutput = capture.logs.find(l => l.startsWith("{"));
            expect(jsonOutput).toBeDefined();

            const parsed = JSON.parse(jsonOutput!);
            log.snapshot("parsed JSON", parsed);

            expect(parsed.success).toBe(true);
            expect(parsed.command).toBe("undo");
            expect(parsed.data.action).toBe("undo-feedback");
            expect(parsed.data.after.helpfulCount).toBe(0);
          } finally {
            process.chdir(originalCwd);
          }
        }, "undo-json-feedback");
      });
    });

    it("outputs valid JSON for hard-delete success", async () => {
      const log = createE2ELogger("undo: JSON hard-delete");
      log.setRepro("bun test test/cli-undo.e2e.test.ts");

      await log.run(async () => {
        await withTempCassHome(async (env) => {
          const originalCwd = process.cwd();
          process.chdir(env.home);

          try {
            // Create a bullet
            const bullet = createTestBullet({
              id: "json-delete-bullet"
            });
            const playbook = createTestPlaybook([bullet]);
            await savePlaybook(playbook, env.playbookPath);

            const capture = captureConsole();
            try {
              await undoCommand("json-delete-bullet", { hard: true, yes: true, json: true });
            } finally {
              capture.restore();
            }

            log.snapshot("output", { logs: capture.logs, errors: capture.errors });

            // Find and parse JSON output
            const jsonOutput = capture.logs.find(l => l.startsWith("{"));
            expect(jsonOutput).toBeDefined();

            const parsed = JSON.parse(jsonOutput!);
            log.snapshot("parsed JSON", parsed);

            expect(parsed.success).toBe(true);
            expect(parsed.command).toBe("undo");
            expect(parsed.data.action).toBe("hard-delete");
            expect(parsed.data.after.deleted).toBe(true);
          } finally {
            process.chdir(originalCwd);
          }
        }, "undo-json-hard-delete");
      });
    });

    it("outputs valid JSON on error", async () => {
      const log = createE2ELogger("undo: JSON error");
      log.setRepro("bun test test/cli-undo.e2e.test.ts");

      await log.run(async () => {
        await withTempCassHome(async (env) => {
          const originalCwd = process.cwd();
          process.chdir(env.home);

          try {
            // Create empty playbook
            const playbook = createTestPlaybook([]);
            await savePlaybook(playbook, env.playbookPath);

            const capture = captureConsole();
            try {
              await undoCommand("nonexistent-bullet", { json: true });
            } finally {
              capture.restore();
            }

            log.snapshot("output", { logs: capture.logs, errors: capture.errors });

            // Find and parse JSON error output
            const allOutput = [...capture.logs, ...capture.errors].join("\n");
            const jsonMatch = allOutput.match(/\{[^]*\}/);
            expect(jsonMatch).toBeDefined();

            const parsed = JSON.parse(jsonMatch![0]);
            log.snapshot("parsed JSON error", parsed);

            expect(parsed.success).toBe(false);
            expect(parsed.error).toBeDefined();
            expect(parsed.error.code).toBe("BULLET_NOT_FOUND");
          } finally {
            process.chdir(originalCwd);
          }
        }, "undo-json-error");
      });
    });

    it("outputs valid JSON for dry-run", async () => {
      const log = createE2ELogger("undo: JSON dry-run");
      log.setRepro("bun test test/cli-undo.e2e.test.ts");

      await log.run(async () => {
        await withTempCassHome(async (env) => {
          const originalCwd = process.cwd();
          process.chdir(env.home);

          try {
            // Create a deprecated bullet
            const bullet = createTestBullet({
              id: "json-dry-run-bullet",
              deprecated: true,
              deprecatedAt: "2025-01-01T00:00:00Z",
              deprecationReason: "Test",
              state: "retired",
              maturity: "deprecated"
            });
            const playbook = createTestPlaybook([bullet]);
            await savePlaybook(playbook, env.playbookPath);

            const capture = captureConsole();
            try {
              await undoCommand("json-dry-run-bullet", { dryRun: true, json: true });
            } finally {
              capture.restore();
            }

            log.snapshot("output", { logs: capture.logs, errors: capture.errors });

            // Find and parse JSON output
            const jsonOutput = capture.logs.find(l => l.startsWith("{"));
            expect(jsonOutput).toBeDefined();

            const parsed = JSON.parse(jsonOutput!);
            log.snapshot("parsed JSON", parsed);

            expect(parsed.success).toBe(true);
            expect(parsed.data.plan).toBeDefined();
            expect(parsed.data.plan.dryRun).toBe(true);
            expect(parsed.data.plan.action).toBe("un-deprecate");
          } finally {
            process.chdir(originalCwd);
          }
        }, "undo-json-dry-run");
      });
    });
  });

  describe("error handling", () => {
    it("reports error when bullet not found", async () => {
      const log = createE2ELogger("undo: bullet not found");
      log.setRepro("bun test test/cli-undo.e2e.test.ts");

      await log.run(async () => {
        await withTempCassHome(async (env) => {
          const originalCwd = process.cwd();
          process.chdir(env.home);

          try {
            // Create empty playbook
            const playbook = createTestPlaybook([]);
            await savePlaybook(playbook, env.playbookPath);

            const capture = captureConsole();
            try {
              await undoCommand("nonexistent-bullet", {});
            } finally {
              capture.restore();
            }

            log.snapshot("output", { logs: capture.logs, errors: capture.errors });

            // Should report bullet not found
            const allOutput = [...capture.logs, ...capture.errors].join("\n");
            expect(allOutput).toContain("not found");
          } finally {
            process.chdir(originalCwd);
          }
        }, "undo-bullet-not-found");
      });
    });
  });
});
