import { describe, expect, it } from "bun:test";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withLock } from "../src/lock.js";
import { withTempDir } from "./helpers/index.js";

// =============================================================================
// withLock - Basic Operations
// =============================================================================
describe("withLock - Basic Operations", () => {
  it("executes operation and returns result", async () => {
    await withTempDir("lock-basic", async (tempDir) => {
      const targetPath = join(tempDir, "test.txt");
      await writeFile(targetPath, "content");

      const result = await withLock(targetPath, async () => {
        return "operation result";
      });

      expect(result).toBe("operation result");
    });
  });

  it("creates lock directory during operation", async () => {
    await withTempDir("lock-creates", async (tempDir) => {
      const targetPath = join(tempDir, "test.txt");
      await writeFile(targetPath, "content");
      const lockPath = `${targetPath}.lock.d`;

      let lockExistedDuringOp = false;

      await withLock(targetPath, async () => {
        try {
          const stats = await stat(lockPath);
          lockExistedDuringOp = stats.isDirectory();
        } catch {
          lockExistedDuringOp = false;
        }
        return null;
      });

      expect(lockExistedDuringOp).toBe(true);
    });
  });

  it("removes lock directory after operation completes", async () => {
    await withTempDir("lock-cleanup", async (tempDir) => {
      const targetPath = join(tempDir, "test.txt");
      await writeFile(targetPath, "content");
      const lockPath = `${targetPath}.lock.d`;

      await withLock(targetPath, async () => null);

      // Lock should be removed
      let lockExists = true;
      try {
        await stat(lockPath);
      } catch {
        lockExists = false;
      }
      expect(lockExists).toBe(false);
    });
  });

  it("stores PID in lock directory", async () => {
    await withTempDir("lock-pid", async (tempDir) => {
      const targetPath = join(tempDir, "test.txt");
      await writeFile(targetPath, "content");
      const lockPath = `${targetPath}.lock.d`;

      let pidContent = "";

      await withLock(targetPath, async () => {
        pidContent = await readFile(join(lockPath, "pid"), "utf-8");
        return null;
      });

      expect(pidContent).toBe(process.pid.toString());
    });
  });

  it("creates parent directories if needed", async () => {
    await withTempDir("lock-mkdir", async (tempDir) => {
      const targetPath = join(tempDir, "nested/dir/test.txt");

      const result = await withLock(targetPath, async () => {
        return "nested success";
      });

      expect(result).toBe("nested success");
    });
  });
});

// =============================================================================
// withLock - Error Handling
// =============================================================================
describe("withLock - Error Handling", () => {
  it("removes lock directory when operation throws", async () => {
    await withTempDir("lock-error", async (tempDir) => {
      const targetPath = join(tempDir, "test.txt");
      await writeFile(targetPath, "content");
      const lockPath = `${targetPath}.lock.d`;

      let errorThrown = false;
      try {
        await withLock(targetPath, async () => {
          throw new Error("Operation failed");
        });
      } catch (err: any) {
        errorThrown = true;
        expect(err.message).toBe("Operation failed");
      }

      expect(errorThrown).toBe(true);

      // Lock should still be cleaned up
      let lockExists = true;
      try {
        await stat(lockPath);
      } catch {
        lockExists = false;
      }
      expect(lockExists).toBe(false);
    });
  });

  it("propagates operation errors after releasing lock", async () => {
    await withTempDir("lock-propagate", async (tempDir) => {
      const targetPath = join(tempDir, "test.txt");
      await writeFile(targetPath, "content");

      const customError = new Error("Custom error message");

      await expect(
        withLock(targetPath, async () => {
          throw customError;
        }),
      ).rejects.toThrow("Custom error message");
    });
  });
});

// =============================================================================
// withLock - Lock Contention
// =============================================================================
describe("withLock - Lock Contention", () => {
  it("serializes concurrent operations", async () => {
    await withTempDir("lock-concurrent", async (tempDir) => {
      const targetPath = join(tempDir, "test.txt");
      await writeFile(targetPath, "0");

      const results: number[] = [];
      const intervals: { id: number; start: number; end: number }[] = [];

      // Use explicit options to ensure reliability under load
      const lockOptions = { retries: 50, delay: 50 };

      // Start 3 concurrent operations
      await Promise.all([
        withLock(
          targetPath,
          async () => {
            const start = Date.now();
            const val = parseInt(await readFile(targetPath, "utf-8"), 10);
            await new Promise((r) => setTimeout(r, 30)); // Simulate work
            await writeFile(targetPath, (val + 1).toString());
            results.push(1);
            intervals.push({ id: 1, start, end: Date.now() });
            return null;
          },
          lockOptions,
        ),
        withLock(
          targetPath,
          async () => {
            const start = Date.now();
            const val = parseInt(await readFile(targetPath, "utf-8"), 10);
            await new Promise((r) => setTimeout(r, 30));
            await writeFile(targetPath, (val + 1).toString());
            results.push(2);
            intervals.push({ id: 2, start, end: Date.now() });
            return null;
          },
          lockOptions,
        ),
        withLock(
          targetPath,
          async () => {
            const start = Date.now();
            const val = parseInt(await readFile(targetPath, "utf-8"), 10);
            await new Promise((r) => setTimeout(r, 30));
            await writeFile(targetPath, (val + 1).toString());
            results.push(3);
            intervals.push({ id: 3, start, end: Date.now() });
            return null;
          },
          lockOptions,
        ),
      ]);

      // All 3 should have executed (serialized)
      expect(results.length).toBe(3);

      // Final value should be 3 (each incremented once)
      const finalVal = await readFile(targetPath, "utf-8");
      expect(finalVal).toBe("3");

      // Verify serialization: no two operations should have overlapping intervals
      // (start of one should be >= end of another for proper serialization)
      intervals.sort((a, b) => a.start - b.start);
      for (let i = 1; i < intervals.length; i++) {
        expect(intervals[i].start).toBeGreaterThanOrEqual(intervals[i - 1].end);
      }
    });
  });

  it("waits and retries when lock is held", async () => {
    await withTempDir("lock-wait", async (tempDir) => {
      const targetPath = join(tempDir, "test.txt");
      await writeFile(targetPath, "content");
      const lockPath = `${targetPath}.lock.d`;

      // Manually create lock
      await mkdir(lockPath);
      await writeFile(join(lockPath, "pid"), process.pid.toString());

      // Start operation that will need to wait
      const startTime = Date.now();
      const operationPromise = withLock(targetPath, async () => "success", {
        retries: 50,
        delay: 50,
      });

      // Release lock after 100ms
      setTimeout(async () => {
        try {
          await rm(lockPath, { recursive: true, force: true });
        } catch {
          // Ignore
        }
      }, 100);

      const result = await operationPromise;
      const elapsed = Date.now() - startTime;

      expect(result).toBe("success");
      expect(elapsed).toBeGreaterThanOrEqual(100);
    });
  });

  it("throws after max retries exceeded", async () => {
    await withTempDir("lock-timeout", async (tempDir) => {
      const targetPath = join(tempDir, "test.txt");
      await writeFile(targetPath, "content");
      const lockPath = `${targetPath}.lock.d`;

      // Create a lock that won't be released
      await mkdir(lockPath);
      await writeFile(join(lockPath, "pid"), process.pid.toString());

      // Touch the lock directory continuously to keep it fresh
      // Using utimes to update directory mtime
      const { utimes } = await import("node:fs/promises");
      const interval = setInterval(async () => {
        try {
          const now = new Date();
          await utimes(lockPath, now, now);
        } catch {
          // Ignore errors
        }
      }, 10);

      try {
        await expect(
          withLock(targetPath, async () => null, { retries: 3, delay: 10 }),
        ).rejects.toThrow(/Could not acquire lock/);
      } finally {
        clearInterval(interval);
        try {
          await rm(lockPath, { recursive: true, force: true });
        } catch {
          // Ignore
        }
      }
    });
  });
});

// =============================================================================
// withLock - Stale Lock Detection
// =============================================================================
describe("withLock - Stale Lock Detection", () => {
  it("removes stale lock directories (> 30s old)", async () => {
    await withTempDir("lock-stale", async (tempDir) => {
      const targetPath = join(tempDir, "test.txt");
      await writeFile(targetPath, "content");
      const lockPath = `${targetPath}.lock.d`;

      // Create a lock dir with old mtime and a non-existent PID
      // (must use non-existent PID since stale check skips if PID is still running)
      await mkdir(lockPath);
      await writeFile(join(lockPath, "pid"), "999998");

      const oldTime = Date.now() - 35_000; // 35 seconds ago
      const { utimes } = await import("node:fs/promises");
      await utimes(lockPath, oldTime / 1000, oldTime / 1000);

      // Should succeed because lock is stale
      const result = await withLock(targetPath, async () => "stale removed");
      expect(result).toBe("stale removed");
    });
  });

  it("honors custom staleLockThresholdMs", async () => {
    await withTempDir("lock-stale-custom", async (tempDir) => {
      const targetPath = join(tempDir, "test.txt");
      await writeFile(targetPath, "content");
      const lockPath = `${targetPath}.lock.d`;

      // Create a lock dir with mtime 2s ago and a non-existent PID
      // (must use non-existent PID since stale check skips if PID is still running)
      await mkdir(lockPath);
      await writeFile(join(lockPath, "pid"), "999997");
      const twoSecondsAgo = Date.now() - 2_000;
      const { utimes } = await import("node:fs/promises");
      await utimes(lockPath, twoSecondsAgo / 1000, twoSecondsAgo / 1000);

      // With default (30s) this would NOT be considered stale; using 1s threshold should remove it.
      const result = await withLock(targetPath, async () => "custom stale removed", {
        staleLockThresholdMs: 1_000,
      });

      expect(result).toBe("custom stale removed");
    });
  });

  it("removes abandoned lock directories even when fresh", async () => {
    await withTempDir("lock-abandoned", async (tempDir) => {
      const targetPath = join(tempDir, "test.txt");
      await writeFile(targetPath, "content");
      const lockPath = `${targetPath}.lock.d`;

      // Create a fresh lock dir with a PID that should not exist.
      await mkdir(lockPath);
      await writeFile(join(lockPath, "pid"), "999999");

      const result = await withLock(targetPath, async () => "abandoned removed");
      expect(result).toBe("abandoned removed");
    });
  });

  it("does not remove fresh lock directories", async () => {
    await withTempDir("lock-fresh", async (tempDir) => {
      const targetPath = join(tempDir, "test.txt");
      await writeFile(targetPath, "content");
      const lockPath = `${targetPath}.lock.d`;

      // Create a fresh lock
      await mkdir(lockPath);
      await writeFile(join(lockPath, "pid"), process.pid.toString());

      // Keep the lock fresh
      const { utimes } = await import("node:fs/promises");
      const interval = setInterval(async () => {
        try {
          const now = new Date();
          await utimes(lockPath, now, now);
        } catch {
          // Ignore
        }
      }, 10);

      try {
        // Should timeout because lock is not stale
        await expect(
          withLock(targetPath, async () => null, { retries: 3, delay: 10 }),
        ).rejects.toThrow(/Could not acquire lock/);
      } finally {
        clearInterval(interval);
        try {
          await rm(lockPath, { recursive: true, force: true });
        } catch {
          // Ignore
        }
      }
    });
  });
});

// =============================================================================
// withLock - Async Operation
// =============================================================================
describe("withLock - Async Operations", () => {
  it("handles async operations correctly", async () => {
    await withTempDir("lock-async", async (tempDir) => {
      const targetPath = join(tempDir, "test.txt");
      await writeFile(targetPath, "initial");

      const result = await withLock(targetPath, async () => {
        await new Promise((r) => setTimeout(r, 50));
        await writeFile(targetPath, "modified");
        return await readFile(targetPath, "utf-8");
      });

      expect(result).toBe("modified");
    });
  });

  it("maintains lock throughout async operation", async () => {
    await withTempDir("lock-maintain", async (tempDir) => {
      const targetPath = join(tempDir, "test.txt");
      await writeFile(targetPath, "content");
      const lockPath = `${targetPath}.lock.d`;

      let lockExistedMidway = false;

      await withLock(targetPath, async () => {
        // Wait, then check lock
        await new Promise((r) => setTimeout(r, 50));
        try {
          await stat(lockPath);
          lockExistedMidway = true;
        } catch {
          lockExistedMidway = false;
        }
        return null;
      });

      expect(lockExistedMidway).toBe(true);
    });
  });
});

// =============================================================================
// withLock - Edge Cases
// =============================================================================
describe("withLock - Edge Cases", () => {
  it("handles empty result", async () => {
    await withTempDir("lock-empty", async (tempDir) => {
      const targetPath = join(tempDir, "test.txt");
      await writeFile(targetPath, "content");

      const result = await withLock(targetPath, async () => undefined);
      expect(result).toBe(undefined);
    });
  });

  it("handles null result", async () => {
    await withTempDir("lock-null", async (tempDir) => {
      const targetPath = join(tempDir, "test.txt");
      await writeFile(targetPath, "content");

      const result = await withLock(targetPath, async () => null);
      expect(result).toBe(null);
    });
  });

  it("handles complex return types", async () => {
    await withTempDir("lock-complex", async (tempDir) => {
      const targetPath = join(tempDir, "test.txt");
      await writeFile(targetPath, "content");

      const result = await withLock(targetPath, async () => ({
        nested: { data: [1, 2, 3] },
        value: "test",
      }));

      expect(result).toEqual({
        nested: { data: [1, 2, 3] },
        value: "test",
      });
    });
  });

  it("handles paths with spaces", async () => {
    await withTempDir("lock-spaces", async (tempDir) => {
      const targetPath = join(tempDir, "path with spaces", "test file.txt");
      await mkdir(join(tempDir, "path with spaces"), { recursive: true });
      await writeFile(targetPath, "content");

      const result = await withLock(targetPath, async () => "spaces ok");
      expect(result).toBe("spaces ok");
    });
  });

  it("handles very long paths", async () => {
    await withTempDir("lock-long", async (tempDir) => {
      // Create a reasonably long nested path
      const longDir = join(tempDir, "a".repeat(50), "b".repeat(50), "c".repeat(50));
      await mkdir(longDir, { recursive: true });
      const targetPath = join(longDir, "test.txt");
      await writeFile(targetPath, "content");

      const result = await withLock(targetPath, async () => "long path ok");
      expect(result).toBe("long path ok");
    });
  });
});

// =============================================================================
// withLock - Options
// =============================================================================
describe("withLock - Options", () => {
  it("respects custom retry count", async () => {
    await withTempDir("lock-retries", async (tempDir) => {
      const targetPath = join(tempDir, "test.txt");
      await writeFile(targetPath, "content");
      const lockPath = `${targetPath}.lock.d`;

      // Create blocking lock
      await mkdir(lockPath);
      await writeFile(join(lockPath, "pid"), process.pid.toString());

      const startTime = Date.now();

      // Keep lock fresh
      const { utimes } = await import("node:fs/promises");
      const interval = setInterval(async () => {
        try {
          const now = new Date();
          await utimes(lockPath, now, now);
        } catch {
          // Ignore
        }
      }, 5);

      try {
        await expect(
          withLock(targetPath, async () => null, { retries: 5, delay: 20 }),
        ).rejects.toThrow(/Could not acquire lock/);

        const elapsed = Date.now() - startTime;
        // Should have tried 5 times with 20ms delay = ~100ms minimum
        expect(elapsed).toBeGreaterThanOrEqual(80);
        expect(elapsed).toBeLessThan(500);
      } finally {
        clearInterval(interval);
        try {
          await rm(lockPath, { recursive: true, force: true });
        } catch {
          // Ignore
        }
      }
    });
  });

  it("respects custom delay", async () => {
    await withTempDir("lock-delay", async (tempDir) => {
      const targetPath = join(tempDir, "test.txt");
      await writeFile(targetPath, "content");
      const lockPath = `${targetPath}.lock.d`;

      // Create blocking lock
      await mkdir(lockPath);
      await writeFile(join(lockPath, "pid"), process.pid.toString());

      // Keep lock fresh
      const { utimes } = await import("node:fs/promises");
      const interval = setInterval(async () => {
        try {
          const now = new Date();
          await utimes(lockPath, now, now);
        } catch {
          // Ignore
        }
      }, 5);

      const startTime = Date.now();

      try {
        await expect(
          withLock(targetPath, async () => null, { retries: 3, delay: 100 }),
        ).rejects.toThrow(/Could not acquire lock/);

        const elapsed = Date.now() - startTime;
        // Should have taken at least 300ms (3 retries * 100ms)
        expect(elapsed).toBeGreaterThanOrEqual(200);
      } finally {
        clearInterval(interval);
        try {
          await rm(lockPath, { recursive: true, force: true });
        } catch {
          // Ignore
        }
      }
    });
  });
});
