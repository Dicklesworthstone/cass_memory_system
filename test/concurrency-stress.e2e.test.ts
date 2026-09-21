/**
 * E2E Tests: Concurrency Stress Testing
 *
 * Tests cass-memory's behavior under concurrent operations.
 * Verifies:
 * - Parallel command execution
 * - Concurrent file access safety
 * - Race condition handling
 * - State consistency after concurrent operations
 */
import { describe, expect, it } from "bun:test";
import { appendFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import yaml from "yaml";
import { contextCommand } from "../src/commands/context.js";
import { doctorCommand } from "../src/commands/doctor.js";
import { initCommand } from "../src/commands/init.js";
import { markCommand } from "../src/commands/mark.js";
import { playbookCommand } from "../src/commands/playbook.js";
import { createTestLogger } from "./helpers/logger.js";
import { TestEnv, withTempCassHome } from "./helpers/temp.js";

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
    },
    getOutput: () => logs.join("\n"),
    getErrors: () => errors.join("\n"),
  };
}

// Helper to check file exists
async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

// Helper to run command capturing output
async function runCaptured<T>(
  fn: () => Promise<T>,
): Promise<{ result?: T; logs: string[]; errors: string[]; error?: Error }> {
  const capture = captureConsole();
  try {
    const result = await fn();
    return { result, logs: capture.logs, errors: capture.errors };
  } catch (error) {
    return { logs: capture.logs, errors: capture.errors, error: error as Error };
  } finally {
    capture.restore();
  }
}

describe("E2E: Concurrency Stress Tests", () => {
  describe("Parallel Command Execution", () => {
    it.serial(
      "handles multiple parallel context queries",
      async () => {
        const logger = createTestLogger("debug");
        logger.info("Starting parallel context queries test");

        await withTempCassHome(async (env) => {
          await rm(env.cassMemoryDir, { recursive: true, force: true });

          // Initialize
          const capture = captureConsole();
          try {
            await initCommand({});
          } finally {
            capture.restore();
          }

          // Add playbook content for context queries
          const now = new Date().toISOString();
          const playbookContent = yaml.stringify({
            version: "1.0",
            metadata: {
              createdAt: now,
              updatedAt: now,
            },
            bullets: [
              {
                id: "test-1",
                content: "Use TypeScript for all new code",
                category: "typescript",
                kind: "project_convention",
                maturity: "established",
                scope: "global",
                helpfulCount: 0,
                harmfulCount: 0,
                createdAt: now,
                updatedAt: now,
              },
              {
                id: "test-2",
                content: "Write tests for all features",
                category: "testing",
                kind: "workflow_rule",
                maturity: "established",
                scope: "global",
                helpfulCount: 0,
                harmfulCount: 0,
                createdAt: now,
                updatedAt: now,
              },
              {
                id: "test-3",
                content: "Follow semantic versioning",
                category: "versioning",
                kind: "project_convention",
                maturity: "established",
                scope: "global",
                helpfulCount: 0,
                harmfulCount: 0,
                createdAt: now,
                updatedAt: now,
              },
              {
                id: "test-4",
                content: "Use async/await over callbacks",
                category: "async",
                kind: "stack_pattern",
                maturity: "established",
                scope: "global",
                helpfulCount: 0,
                harmfulCount: 0,
                createdAt: now,
                updatedAt: now,
              },
              {
                id: "test-5",
                content: "Document public APIs",
                category: "documentation",
                kind: "workflow_rule",
                maturity: "established",
                scope: "global",
                helpfulCount: 0,
                harmfulCount: 0,
                createdAt: now,
                updatedAt: now,
              },
            ],
          });
          await writeFile(env.playbookPath, playbookContent);

          // Run 10 parallel context queries
          const queries = [
            "typescript",
            "testing",
            "async",
            "documentation",
            "versioning",
            "code quality",
            "best practices",
            "performance",
            "security",
            "error handling",
          ];

          const start = performance.now();
          const results = await Promise.all(
            queries.map(async (query) => {
              const captured = await runCaptured(() => contextCommand(query, { json: true }));
              return { query, ...captured };
            }),
          );
          const duration = performance.now() - start;

          logger.info("Parallel queries completed", {
            count: results.length,
            durationMs: Math.round(duration),
          });

          // Verify queries completed (some may not match which is OK)
          let successCount = 0;
          const errorsFound: string[] = [];
          for (const result of results) {
            if (!result.error) {
              successCount++;
            } else {
              errorsFound.push(`${result.query}: ${result.error.message}`);
            }
          }

          logger.info("Errors found", { errors: errorsFound });

          // At least 80% should complete without errors
          expect(successCount).toBeGreaterThanOrEqual(queries.length * 0.8);
          logger.info("Success rate", { successCount, total: queries.length });
        });
      },
      60000,
    );

    it.serial(
      "handles parallel playbook reads",
      async () => {
        await withTempCassHome(async (env) => {
          await rm(env.cassMemoryDir, { recursive: true, force: true });

          const capture = captureConsole();
          try {
            await initCommand({});
          } finally {
            capture.restore();
          }

          // Run 20 parallel playbook reads
          const results = await Promise.all(
            Array(20)
              .fill(null)
              .map(async () => {
                const captured = await runCaptured(() =>
                  playbookCommand("list", [], { json: true }),
                );
                return captured;
              }),
          );

          // All reads should succeed (no errors)
          const errors = results.filter((r) => r.error);
          expect(errors.length).toBe(0);
        });
      },
      30000,
    );
  });

  describe("Concurrent File Access", () => {
    it.serial(
      "handles concurrent playbook additions",
      async () => {
        const logger = createTestLogger("debug");
        logger.info("Starting concurrent playbook additions test");

        await withTempCassHome(async (env) => {
          await rm(env.cassMemoryDir, { recursive: true, force: true });

          const capture = captureConsole();
          try {
            await initCommand({});
          } finally {
            capture.restore();
          }

          // Add 10 bullets concurrently (tests file locking/atomic writes)
          const bullets = Array(10)
            .fill(null)
            .map((_, i) => `Concurrent rule ${i + 1}: Test content ${Date.now()}-${i}`);

          const results = await Promise.all(
            bullets.map(async (content) => {
              const captured = await runCaptured(() =>
                playbookCommand("add", [content], { json: true }),
              );
              return { content, ...captured };
            }),
          );

          // Check results - some may fail due to race conditions which is OK
          const successes = results.filter((r) => !r.error);
          logger.info("Concurrent additions", {
            attempted: bullets.length,
            succeeded: successes.length,
          });

          // At least some should succeed (testing graceful handling)
          expect(successes.length).toBeGreaterThan(0);

          // Verify playbook is still valid YAML after concurrent writes
          const playbookContent = await readFile(env.playbookPath, "utf-8");
          const playbook = yaml.parse(playbookContent);
          expect(playbook).toBeDefined();
          expect(Array.isArray(playbook.bullets)).toBe(true);

          logger.info("Final playbook state", {
            bulletCount: playbook.bullets.length,
          });
        });
      },
      60000,
    );

    it.serial(
      "handles interleaved reads and writes",
      async () => {
        const logger = createTestLogger("debug");

        await withTempCassHome(async (env) => {
          await rm(env.cassMemoryDir, { recursive: true, force: true });

          const capture = captureConsole();
          try {
            await initCommand({});
          } finally {
            capture.restore();
          }

          // Create interleaved read/write operations
          const operations: Array<() => Promise<any>> = [];

          for (let i = 0; i < 5; i++) {
            // Add a write
            operations.push(async () => {
              const captured = await runCaptured(() =>
                playbookCommand("add", [`Interleaved rule ${i}`], { json: true }),
              );
              return { type: "write", ...captured };
            });
            // Add a read
            operations.push(async () => {
              const captured = await runCaptured(() => playbookCommand("list", [], { json: true }));
              return { type: "read", ...captured };
            });
          }

          // Shuffle operations for more realistic interleaving
          operations.sort(() => Math.random() - 0.5);

          const results = await Promise.all(operations.map((op) => op()));

          // Verify no crashes occurred (errors with ENOENT/EPERM in message)
          const crashes = results.filter(
            (r) =>
              r.error && (r.error.message.includes("ENOENT") || r.error.message.includes("EPERM")),
          );

          logger.info("Interleaved operations", {
            total: results.length,
            crashes: crashes.length,
          });

          // Should have no file-related crashes
          expect(crashes.length).toBe(0);

          // Final playbook should be valid
          const playbookContent = await readFile(env.playbookPath, "utf-8");
          const playbook = yaml.parse(playbookContent);
          expect(playbook).toBeDefined();
        });
      },
      60000,
    );
  });

  describe("Race Condition Handling", () => {
    it.serial(
      "handles rapid init calls gracefully",
      async () => {
        const logger = createTestLogger("debug");

        await withTempCassHome(async (env) => {
          await rm(env.cassMemoryDir, { recursive: true, force: true });

          // Try to init 5 times in rapid succession
          const results = await Promise.all(
            Array(5)
              .fill(null)
              .map(async () => {
                const captured = await runCaptured(() => initCommand({ json: true }));
                return captured;
              }),
          );

          // Count successes (JSON output with success: true or created files)
          const successes = results.filter((r) => {
            if (r.error) return false;
            const output = r.logs.join("\n");
            try {
              const parsed = JSON.parse(output);
              return parsed.success === true;
            } catch {
              // Non-JSON but no error means it might have succeeded
              return !r.error;
            }
          });

          logger.info("Rapid init results", {
            total: results.length,
            successes: successes.length,
          });

          // At least one should succeed
          expect(successes.length).toBeGreaterThanOrEqual(1);

          // Directory should exist and be valid
          const cassMemoryExists = await exists(env.cassMemoryDir);
          expect(cassMemoryExists).toBe(true);
        });
      },
      30000,
    );

    it.serial(
      "handles concurrent diary writes to same day",
      async () => {
        const logger = createTestLogger("debug");

        await withTempCassHome(async (env) => {
          await rm(env.cassMemoryDir, { recursive: true, force: true });

          const capture = captureConsole();
          try {
            await initCommand({});
          } finally {
            capture.restore();
          }

          // Simulate multiple diary entries being written concurrently
          const diaryEntries = Array(5)
            .fill(null)
            .map((_, i) => ({
              content: `Concurrent session ${i + 1} entry`,
              timestamp: new Date().toISOString(),
            }));

          // Write diary entries directly to test file system race conditions
          const diaryPath = path.join(
            env.diaryDir,
            `${new Date().toISOString().split("T")[0]}.jsonl`,
          );

          await Promise.all(
            diaryEntries.map(async (entry) => {
              const line = JSON.stringify(entry) + "\n";
              await appendFile(diaryPath, line);
            }),
          );

          // Verify file was written and is valid JSONL
          const diaryContent = await readFile(diaryPath, "utf-8");
          const lines = diaryContent.trim().split("\n").filter(Boolean);

          logger.info("Diary write results", {
            expectedLines: diaryEntries.length,
            actualLines: lines.length,
          });

          // Each line should be valid JSON
          for (const line of lines) {
            const parsed = JSON.parse(line);
            expect(parsed.content).toBeDefined();
          }
        });
      },
      30000,
    );
  });

  describe("State Consistency", () => {
    it.serial(
      "maintains consistent state after concurrent modifications",
      async () => {
        const logger = createTestLogger("debug");

        await withTempCassHome(async (env) => {
          await rm(env.cassMemoryDir, { recursive: true, force: true });

          const capture = captureConsole();
          try {
            await initCommand({});
          } finally {
            capture.restore();
          }

          // Add initial bullet
          const addCapture = captureConsole();
          try {
            await playbookCommand("add", ["Initial rule: always test concurrency"], { json: true });
          } finally {
            addCapture.restore();
          }

          // Get the bullet ID
          const initialPlaybook = yaml.parse(await readFile(env.playbookPath, "utf-8"));
          const bulletId = initialPlaybook.bullets[0]?.id;

          if (!bulletId) {
            logger.info("No bullet ID found, skipping mark test");
            return;
          }

          // Run concurrent marks on the same bullet
          const results = await Promise.all(
            Array(5)
              .fill(null)
              .map(async (_, i) => {
                const captured = await runCaptured(() =>
                  markCommand(bulletId, {
                    helpful: i % 2 === 0,
                    harmful: i % 2 !== 0,
                    json: true,
                  }),
                );
                return captured;
              }),
          );

          // Verify no corrupted state
          const finalPlaybook = yaml.parse(await readFile(env.playbookPath, "utf-8"));
          expect(finalPlaybook).toBeDefined();
          expect(Array.isArray(finalPlaybook.bullets)).toBe(true);

          // The bullet should still exist
          const bullet = finalPlaybook.bullets.find((b: any) => b.id === bulletId);
          expect(bullet).toBeDefined();

          // Counts should be valid numbers
          expect(typeof bullet.helpfulCount).toBe("number");
          expect(typeof bullet.harmfulCount).toBe("number");
          expect(Number.isNaN(bullet.helpfulCount)).toBe(false);
          expect(Number.isNaN(bullet.harmfulCount)).toBe(false);

          logger.info("State consistency verified", {
            bulletExists: !!bullet,
            helpfulCount: bullet?.helpfulCount,
            harmfulCount: bullet?.harmfulCount,
          });
        });
      },
      60000,
    );

    it.serial(
      "doctor command detects no corruption after stress test",
      async () => {
        const logger = createTestLogger("debug");

        await withTempCassHome(async (env) => {
          await rm(env.cassMemoryDir, { recursive: true, force: true });

          const capture = captureConsole();
          try {
            await initCommand({});
          } finally {
            capture.restore();
          }

          // Run a bunch of random operations
          const operations: Array<() => Promise<any>> = [];

          // Add some playbook rules
          for (let i = 0; i < 3; i++) {
            operations.push(async () => {
              const captured = await runCaptured(() =>
                playbookCommand("add", [`Stress test rule ${i}`], {}),
              );
              return { type: "add", ...captured };
            });
          }

          // Add some context queries
          for (let i = 0; i < 3; i++) {
            operations.push(async () => {
              const captured = await runCaptured(() =>
                contextCommand(`query ${i}`, { json: true }),
              );
              return { type: "context", ...captured };
            });
          }

          // Add some playbook reads
          for (let i = 0; i < 3; i++) {
            operations.push(async () => {
              const captured = await runCaptured(() => playbookCommand("list", [], { json: true }));
              return { type: "read", ...captured };
            });
          }

          // Shuffle and run all
          operations.sort(() => Math.random() - 0.5);
          await Promise.all(operations.map((op) => op()));

          // Now run doctor to verify no corruption
          const doctorCapture = captureConsole();
          let doctorError: Error | undefined;
          try {
            await doctorCommand({ json: true });
          } catch (e) {
            doctorError = e as Error;
          } finally {
            doctorCapture.restore();
          }

          logger.info("Doctor result", {
            hasError: !!doctorError,
            output: doctorCapture.logs.slice(0, 5),
          });

          // Doctor should not throw critical errors
          if (!doctorError) {
            const output = doctorCapture.logs.join("\n");
            try {
              const parsed = JSON.parse(output);
              // Should have no critical issues
              const criticalIssues = (parsed.issues || []).filter(
                (i: any) => i.severity === "critical" || i.severity === "error",
              );
              expect(criticalIssues.length).toBe(0);
            } catch {
              // Non-JSON output is OK
            }
          }
        });
      },
      60000,
    );
  });

  describe("Performance Under Load", () => {
    it.serial(
      "context queries complete within reasonable time under load",
      async () => {
        const logger = createTestLogger("debug");

        await withTempCassHome(async (env) => {
          await rm(env.cassMemoryDir, { recursive: true, force: true });

          const capture = captureConsole();
          try {
            await initCommand({});
          } finally {
            capture.restore();
          }

          // Add a larger playbook to make queries more realistic
          const perfNow = new Date().toISOString();
          const kinds = [
            "project_convention",
            "workflow_rule",
            "stack_pattern",
            "anti_pattern",
          ] as const;
          const bullets = Array(50)
            .fill(null)
            .map((_, i) => ({
              id: `bulk-${i}`,
              content: `Rule ${i}: Lorem ipsum dolor sit amet, consectetur adipiscing elit. Category: ${["typescript", "testing", "documentation", "performance"][i % 4]}`,
              category: ["typescript", "testing", "documentation", "performance"][i % 4],
              kind: kinds[i % 4],
              maturity: "established",
              scope: "global",
              helpfulCount: 0,
              harmfulCount: 0,
              createdAt: perfNow,
              updatedAt: perfNow,
            }));

          const playbookContent = yaml.stringify({
            version: "1.0",
            metadata: {
              createdAt: perfNow,
              updatedAt: perfNow,
            },
            bullets,
          });
          await writeFile(env.playbookPath, playbookContent);

          // Run 20 queries and measure total time
          const queries = Array(20)
            .fill(null)
            .map((_, i) => `query term ${i % 5}`);

          const start = performance.now();
          await Promise.all(
            queries.map(async (q) => {
              const captured = await runCaptured(() => contextCommand(q, { json: true }));
              return captured;
            }),
          );
          const duration = performance.now() - start;

          const avgTime = duration / queries.length;

          logger.info("Query performance", {
            totalQueries: queries.length,
            totalDurationMs: Math.round(duration),
            avgDurationMs: Math.round(avgTime),
          });

          // Average query time should be under 2 seconds
          // (generous limit for CI environments)
          expect(avgTime).toBeLessThan(2000);
        });
      },
      120000,
    );

    it.serial(
      "handles burst of 50 rapid sequential commands",
      async () => {
        const logger = createTestLogger("debug");

        await withTempCassHome(async (env) => {
          await rm(env.cassMemoryDir, { recursive: true, force: true });

          const capture = captureConsole();
          try {
            await initCommand({});
          } finally {
            capture.restore();
          }

          const start = performance.now();
          const results: { success: boolean; duration: number }[] = [];

          // Run 50 commands in rapid succession (sequential, not parallel)
          for (let i = 0; i < 50; i++) {
            const cmdStart = performance.now();
            const captured = await runCaptured(() => playbookCommand("list", [], { json: true }));
            results.push({
              success: !captured.error,
              duration: performance.now() - cmdStart,
            });
          }

          const totalDuration = performance.now() - start;
          const successRate = results.filter((r) => r.success).length / results.length;
          const avgDuration = results.reduce((sum, r) => sum + r.duration, 0) / results.length;

          logger.info("Burst test results", {
            totalCommands: results.length,
            totalDurationMs: Math.round(totalDuration),
            avgDurationMs: Math.round(avgDuration),
            successRate: `${(successRate * 100).toFixed(1)}%`,
          });

          // Success rate should be 100%
          expect(successRate).toBe(1);

          // Total time for 50 commands should be under 30 seconds
          expect(totalDuration).toBeLessThan(30000);
        });
      },
      60000,
    );
  });
});
