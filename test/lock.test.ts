import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdir, writeFile, unlink, stat, readFile } from "node:fs/promises";
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

  it("creates lock file during operation", async () => {
    await withTempDir("lock-creates", async (tempDir) => {
      const targetPath = join(tempDir, "test.txt");
      await writeFile(targetPath, "content");
      const lockPath = `${targetPath}.lock`;

      let lockExistedDuringOp = false;

      await withLock(targetPath, async () => {
        try {
          await stat(lockPath);
          lockExistedDuringOp = true;
        } catch {
          lockExistedDuringOp = false;
        }
        return null;
      });

      expect(lockExistedDuringOp).toBe(true);
    });
  });

  it("removes lock file after operation completes", async () => {
    await withTempDir("lock-cleanup", async (tempDir) => {
      const targetPath = join(tempDir, "test.txt");
      await writeFile(targetPath, "content");
      const lockPath = `${targetPath}.lock`;

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

  it("stores PID in lock file", async () => {
    await withTempDir("lock-pid", async (tempDir) => {
      const targetPath = join(tempDir, "test.txt");
      await writeFile(targetPath, "content");
      const lockPath = `${targetPath}.lock`;

      let pidContent = "";

      await withLock(targetPath, async () => {
        pidContent = await readFile(lockPath, "utf-8");
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
  it("removes lock file when operation throws", async () => {
    await withTempDir("lock-error", async (tempDir) => {
      const targetPath = join(tempDir, "test.txt");
      await writeFile(targetPath, "content");
      const lockPath = `${targetPath}.lock`;

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
        })
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

      // Start 3 concurrent operations
      await Promise.all([
        withLock(targetPath, async () => {
          const val = parseInt(await readFile(targetPath, "utf-8"), 10);
          await new Promise((r) => setTimeout(r, 50)); // Simulate work
          await writeFile(targetPath, (val + 1).toString());
          results.push(1);
          return null;
        }),
        withLock(targetPath, async () => {
          const val = parseInt(await readFile(targetPath, "utf-8"), 10);
          await new Promise((r) => setTimeout(r, 50));
          await writeFile(targetPath, (val + 1).toString());
          results.push(2);
          return null;
        }),
        withLock(targetPath, async () => {
          const val = parseInt(await readFile(targetPath, "utf-8"), 10);
          await new Promise((r) => setTimeout(r, 50));
          await writeFile(targetPath, (val + 1).toString());
          results.push(3);
          return null;
        }),
      ]);

      // All 3 should have executed (serialized)
      expect(results.length).toBe(3);

      // Final value should be 3 (each incremented once)
      const finalVal = await readFile(targetPath, "utf-8");
      expect(finalVal).toBe("3");
    });
  });

  it("waits and retries when lock is held", async () => {
    await withTempDir("lock-wait", async (tempDir) => {
      const targetPath = join(tempDir, "test.txt");
      await writeFile(targetPath, "content");
      const lockPath = `${targetPath}.lock`;

      // Manually create lock
      await writeFile(lockPath, "999999");

      // Start operation that will need to wait
      const startTime = Date.now();
      const operationPromise = withLock(
        targetPath,
        async () => "success",
        { retries: 50, delay: 50 }
      );

      // Release lock after 100ms
      setTimeout(async () => {
        try {
          await unlink(lockPath);
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
      const lockPath = `${targetPath}.lock`;

      // Create a lock that won't be released
      await writeFile(lockPath, process.pid.toString());

      // Touch the file continuously to keep it fresh
      const interval = setInterval(async () => {
        try {
          const content = await readFile(lockPath, "utf-8");
          await writeFile(lockPath, content);
        } catch {
          // Ignore errors
        }
      }, 10);

      try {
        await expect(
          withLock(targetPath, async () => null, { retries: 3, delay: 10 })
        ).rejects.toThrow(/Could not acquire lock/);
      } finally {
        clearInterval(interval);
        try {
          await unlink(lockPath);
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
  it("removes stale lock files (> 30s old)", async () => {
    await withTempDir("lock-stale", async (tempDir) => {
      const targetPath = join(tempDir, "test.txt");
      await writeFile(targetPath, "content");
      const lockPath = `${targetPath}.lock`;

      // Create a lock file with old mtime
      await writeFile(lockPath, "999999");
      const oldTime = Date.now() - 35_000; // 35 seconds ago
      const { utimes } = await import("node:fs/promises");
      await utimes(lockPath, oldTime / 1000, oldTime / 1000);

      // Should succeed because lock is stale
      const result = await withLock(targetPath, async () => "stale removed");
      expect(result).toBe("stale removed");
    });
  });

  it("does not remove fresh lock files", async () => {
    await withTempDir("lock-fresh", async (tempDir) => {
      const targetPath = join(tempDir, "test.txt");
      await writeFile(targetPath, "content");
      const lockPath = `${targetPath}.lock`;

      // Create a fresh lock
      await writeFile(lockPath, "999999");

      // Keep the lock fresh
      const interval = setInterval(async () => {
        try {
          const content = await readFile(lockPath, "utf-8");
          await writeFile(lockPath, content);
        } catch {
          // Ignore
        }
      }, 10);

      try {
        // Should timeout because lock is not stale
        await expect(
          withLock(targetPath, async () => null, { retries: 3, delay: 10 })
        ).rejects.toThrow(/Could not acquire lock/);
      } finally {
        clearInterval(interval);
        try {
          await unlink(lockPath);
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
      const lockPath = `${targetPath}.lock`;

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
      const lockPath = `${targetPath}.lock`;

      // Create blocking lock
      await writeFile(lockPath, "999999");

      const startTime = Date.now();

      // Keep lock fresh
      const interval = setInterval(async () => {
        try {
          await writeFile(lockPath, "999999");
        } catch {
          // Ignore
        }
      }, 5);

      try {
        await expect(
          withLock(targetPath, async () => null, { retries: 5, delay: 20 })
        ).rejects.toThrow(/Could not acquire lock/);

        const elapsed = Date.now() - startTime;
        // Should have tried 5 times with 20ms delay = ~100ms minimum
        expect(elapsed).toBeGreaterThanOrEqual(80);
        expect(elapsed).toBeLessThan(500);
      } finally {
        clearInterval(interval);
        try {
          await unlink(lockPath);
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
      const lockPath = `${targetPath}.lock`;

      // Create blocking lock
      await writeFile(lockPath, "999999");

      // Keep lock fresh
      const interval = setInterval(async () => {
        try {
          await writeFile(lockPath, "999999");
        } catch {
          // Ignore
        }
      }, 5);

      const startTime = Date.now();

      try {
        await expect(
          withLock(targetPath, async () => null, { retries: 3, delay: 100 })
        ).rejects.toThrow(/Could not acquire lock/);

        const elapsed = Date.now() - startTime;
        // Should have taken at least 300ms (3 retries * 100ms)
        expect(elapsed).toBeGreaterThanOrEqual(200);
      } finally {
        clearInterval(interval);
        try {
          await unlink(lockPath);
        } catch {
          // Ignore
        }
      }
    });
  });
});
