/**
 * E2E Tests for CLI forget command - Deprecate rules with reason
 *
 * Tests the `cm forget` command which:
 * - Deprecates a bullet with a required reason
 * - Optionally inverts the rule to an anti-pattern
 * - Logs to blocked.log for audit trail
 */
import { describe, it, expect } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { forgetCommand } from "../src/commands/forget.js";
import { withTempCassHome } from "./helpers/temp.js";
import { createTestBullet, createTestPlaybook } from "./helpers/factories.js";
import { savePlaybook, loadPlaybook, findBullet } from "../src/playbook.js";
import { createE2ELogger } from "./helpers/e2e-logger.js";

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

describe("E2E: CLI forget command", () => {
  describe("validation", () => {
    it("requires --reason flag", async () => {
      const log = createE2ELogger("forget: requires reason");
      log.setRepro("bun test test/cli-forget.e2e.test.ts");

      await log.run(async () => {
        await withTempCassHome(async (env) => {
          const originalCwd = process.cwd();
          process.chdir(env.home);

          try {
            // Create a playbook with a bullet
            const bullet = createTestBullet({ id: "test-bullet-1" });
            const playbook = createTestPlaybook([bullet]);
            await savePlaybook(playbook, env.playbookPath);

            const capture = captureConsole();
            try {
              await forgetCommand("test-bullet-1", {});
            } finally {
              capture.restore();
            }

            log.snapshot("output", { logs: capture.logs, errors: capture.errors });

            // Should report missing reason
            const allOutput = [...capture.logs, ...capture.errors].join("\n");
            expect(allOutput).toContain("Reason required");
          } finally {
            process.chdir(originalCwd);
          }
        }, "forget-requires-reason");
      });
    });

    it("reports error when bullet not found", async () => {
      const log = createE2ELogger("forget: bullet not found");
      log.setRepro("bun test test/cli-forget.e2e.test.ts");

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
              await forgetCommand("nonexistent-bullet", { reason: "Testing" });
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
        }, "forget-bullet-not-found");
      });
    });
  });

  describe("successful operations", () => {
    it("deprecates bullet with reason", async () => {
      const log = createE2ELogger("forget: deprecates bullet");
      log.setRepro("bun test test/cli-forget.e2e.test.ts");

      await log.run(async () => {
        await withTempCassHome(async (env) => {
          const originalCwd = process.cwd();
          process.chdir(env.home);

          try {
            // Create a playbook with a bullet
            const bullet = createTestBullet({
              id: "bullet-to-forget",
              content: "Always use semicolons in JavaScript"
            });
            const playbook = createTestPlaybook([bullet]);
            await savePlaybook(playbook, env.playbookPath);

            log.step("Created playbook with bullet", { bulletId: bullet.id });

            const capture = captureConsole();
            try {
              await forgetCommand("bullet-to-forget", { reason: "This is outdated advice" });
            } finally {
              capture.restore();
            }

            log.snapshot("output", { logs: capture.logs, errors: capture.errors });

            // Verify output
            const allOutput = capture.logs.join("\n");
            expect(allOutput).toContain("Forgot bullet");
            expect(allOutput).toContain("bullet-to-forget");

            // Verify bullet is deprecated in playbook
            const updatedPlaybook = await loadPlaybook(env.playbookPath);
            const deprecatedBullet = findBullet(updatedPlaybook, "bullet-to-forget");
            log.snapshot("deprecated bullet", deprecatedBullet);

            expect(deprecatedBullet).toBeDefined();
            expect(deprecatedBullet!.deprecated).toBe(true);
            expect(deprecatedBullet!.deprecationReason).toContain("This is outdated advice");
          } finally {
            process.chdir(originalCwd);
          }
        }, "forget-deprecates-bullet");
      });
    });

    it("creates anti-pattern when --invert is set", async () => {
      const log = createE2ELogger("forget: creates anti-pattern");
      log.setRepro("bun test test/cli-forget.e2e.test.ts");

      await log.run(async () => {
        await withTempCassHome(async (env) => {
          const originalCwd = process.cwd();
          process.chdir(env.home);

          try {
            // Create a playbook with a bullet
            const bullet = createTestBullet({
              id: "bullet-to-invert",
              content: "Use var instead of let/const",
              category: "javascript"
            });
            const playbook = createTestPlaybook([bullet]);
            await savePlaybook(playbook, env.playbookPath);

            log.step("Created playbook with bullet", { bulletId: bullet.id });

            const capture = captureConsole();
            try {
              await forgetCommand("bullet-to-invert", {
                reason: "var has function scoping issues",
                invert: true
              });
            } finally {
              capture.restore();
            }

            log.snapshot("output", { logs: capture.logs, errors: capture.errors });

            // Verify output mentions anti-pattern
            const allOutput = capture.logs.join("\n");
            expect(allOutput).toContain("Forgot bullet");
            expect(allOutput).toContain("anti-pattern");

            // Verify anti-pattern was created
            const updatedPlaybook = await loadPlaybook(env.playbookPath);
            log.snapshot("bullets after invert", updatedPlaybook.bullets?.map(b => ({
              id: b.id,
              type: b.type,
              content: b.content?.slice(0, 50),
              isNegative: b.isNegative
            })));

            // Find the anti-pattern
            const antiPattern = updatedPlaybook.bullets?.find(b =>
              b.type === "anti-pattern" &&
              b.content?.includes("AVOID:")
            );

            expect(antiPattern).toBeDefined();
            expect(antiPattern!.isNegative).toBe(true);
            expect(antiPattern!.content).toContain("var has function scoping issues");
            expect(antiPattern!.tags).toContain("inverted");
          } finally {
            process.chdir(originalCwd);
          }
        }, "forget-creates-anti-pattern");
      });
    });

    it("appends to blocked.log", async () => {
      const log = createE2ELogger("forget: appends to blocked.log");
      log.setRepro("bun test test/cli-forget.e2e.test.ts");

      await log.run(async () => {
        await withTempCassHome(async (env) => {
          const originalCwd = process.cwd();
          process.chdir(env.home);

          try {
            // Create a playbook with a bullet
            const bullet = createTestBullet({
              id: "bullet-for-log",
              content: "Log this bullet when forgotten"
            });
            const playbook = createTestPlaybook([bullet]);
            await savePlaybook(playbook, env.playbookPath);

            const capture = captureConsole();
            try {
              await forgetCommand("bullet-for-log", { reason: "Testing blocked log" });
            } finally {
              capture.restore();
            }

            // Verify blocked.log was created
            const blockedLogPath = path.join(env.cassMemoryDir, "blocked.log");
            const blockedLogExists = await fs.stat(blockedLogPath).then(() => true).catch(() => false);

            log.step("Checked blocked.log", { path: blockedLogPath, exists: blockedLogExists });
            expect(blockedLogExists).toBe(true);

            // Verify contents
            const blockedLogContent = await fs.readFile(blockedLogPath, "utf-8");
            log.snapshot("blocked.log content", blockedLogContent);

            expect(blockedLogContent).toContain("bullet-for-log");
            expect(blockedLogContent).toContain("Testing blocked log");
          } finally {
            process.chdir(originalCwd);
          }
        }, "forget-blocked-log");
      });
    });
  });

  describe("JSON output mode", () => {
    it("outputs valid JSON on success", async () => {
      const log = createE2ELogger("forget: JSON output success");
      log.setRepro("bun test test/cli-forget.e2e.test.ts");

      await log.run(async () => {
        await withTempCassHome(async (env) => {
          const originalCwd = process.cwd();
          process.chdir(env.home);

          try {
            // Create a playbook with a bullet
            const bullet = createTestBullet({ id: "json-test-bullet" });
            const playbook = createTestPlaybook([bullet]);
            await savePlaybook(playbook, env.playbookPath);

            const capture = captureConsole();
            try {
              await forgetCommand("json-test-bullet", {
                reason: "Testing JSON output",
                json: true
              });
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
            expect(parsed.command).toBe("forget");
            expect(parsed.data.bulletId).toBe("json-test-bullet");
            expect(parsed.data.action).toBe("forgotten");
          } finally {
            process.chdir(originalCwd);
          }
        }, "forget-json-success");
      });
    });

    it("outputs valid JSON on error", async () => {
      const log = createE2ELogger("forget: JSON output error");
      log.setRepro("bun test test/cli-forget.e2e.test.ts");

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
              await forgetCommand("nonexistent", {
                reason: "Testing",
                json: true
              });
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
          } finally {
            process.chdir(originalCwd);
          }
        }, "forget-json-error");
      });
    });

    it("includes inverted info in JSON when --invert is used", async () => {
      const log = createE2ELogger("forget: JSON with invert");
      log.setRepro("bun test test/cli-forget.e2e.test.ts");

      await log.run(async () => {
        await withTempCassHome(async (env) => {
          const originalCwd = process.cwd();
          process.chdir(env.home);

          try {
            // Create a playbook with a bullet
            const bullet = createTestBullet({ id: "invert-json-bullet" });
            const playbook = createTestPlaybook([bullet]);
            await savePlaybook(playbook, env.playbookPath);

            const capture = captureConsole();
            try {
              await forgetCommand("invert-json-bullet", {
                reason: "Testing JSON with invert",
                invert: true,
                json: true
              });
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
            expect(parsed.data.inverted).toBe(true);
            expect(parsed.data.antiPatternId).toBeDefined();
          } finally {
            process.chdir(originalCwd);
          }
        }, "forget-json-invert");
      });
    });
  });

  describe("edge cases", () => {
    it("handles multiple forgets of same bullet gracefully", async () => {
      const log = createE2ELogger("forget: double forget");
      log.setRepro("bun test test/cli-forget.e2e.test.ts");

      await log.run(async () => {
        await withTempCassHome(async (env) => {
          const originalCwd = process.cwd();
          process.chdir(env.home);

          try {
            // Create a playbook with a bullet
            const bullet = createTestBullet({ id: "double-forget-bullet" });
            const playbook = createTestPlaybook([bullet]);
            await savePlaybook(playbook, env.playbookPath);

            // First forget
            const capture1 = captureConsole();
            try {
              await forgetCommand("double-forget-bullet", { reason: "First forget" });
            } finally {
              capture1.restore();
            }

            log.step("First forget", { logs: capture1.logs });
            expect(capture1.logs.join("\n")).toContain("Forgot bullet");

            // Second forget attempt - bullet is already deprecated but still exists
            const capture2 = captureConsole();
            try {
              await forgetCommand("double-forget-bullet", { reason: "Second forget" });
            } finally {
              capture2.restore();
            }

            log.step("Second forget", { logs: capture2.logs, errors: capture2.errors });

            // Should still work (re-deprecating is idempotent for the deprecated status)
            // but the blocked.log will have a new entry
            const blockedLogPath = path.join(env.cassMemoryDir, "blocked.log");
            const blockedLogContent = await fs.readFile(blockedLogPath, "utf-8");
            log.snapshot("blocked.log after double forget", blockedLogContent);

            // Should have entries from both forgets
            expect(blockedLogContent).toContain("First forget");
            expect(blockedLogContent).toContain("Second forget");
          } finally {
            process.chdir(originalCwd);
          }
        }, "forget-double");
      });
    });
  });
});
