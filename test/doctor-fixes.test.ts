import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type ApplyFixesOptions,
  applyFixes,
  detectFixableIssues,
  type FixableIssue,
  type FixResult,
} from "../src/commands/doctor.js";
import { PLAYBOOK_INPUT_LIMITS } from "../src/input-limits.js";
import { withLock } from "../src/lock.js";
import { createEmptyPlaybook, loadPlaybook, savePlaybook } from "../src/playbook.js";
import { createTestBullet } from "./helpers/factories.js";
import { withTempDir } from "./helpers/temp.js";

describe("Doctor Fixes", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "doctor-fix-test-"));
  });

  afterEach(async () => {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  describe("FixableIssue interface", () => {
    test("creates valid fixable issue", () => {
      const issue: FixableIssue = {
        id: "test-issue",
        description: "Test issue description",
        category: "test",
        severity: "warn",
        safety: "safe",
        fix: async () => {},
      };

      expect(issue.id).toBe("test-issue");
      expect(issue.severity).toBe("warn");
      expect(issue.safety).toBe("safe");
      expect(typeof issue.fix).toBe("function");
    });

    test("fix function can be async", async () => {
      let fixed = false;
      const issue: FixableIssue = {
        id: "async-fix",
        description: "Async fix test",
        category: "test",
        severity: "fail",
        safety: "safe",
        fix: async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          fixed = true;
        },
      };

      await issue.fix();
      expect(fixed).toBe(true);
    });
  });

  describe("applyFixes", () => {
    test("returns empty array for no issues", async () => {
      const results = await applyFixes([]);
      expect(results).toEqual([]);
    });

    test("applies safe fixes without confirmation in non-interactive mode", async () => {
      const fixedFiles: string[] = [];
      const testFile = path.join(tmpDir, "test.txt");

      const issue: FixableIssue = {
        id: "create-file",
        description: "Create test file",
        category: "storage",
        severity: "warn",
        safety: "safe",
        fix: async () => {
          await fs.writeFile(testFile, "content");
          fixedFiles.push(testFile);
        },
      };

      const results = await applyFixes([issue], { interactive: false });

      expect(results.length).toBe(1);
      expect(results[0].success).toBe(true);
      expect(fixedFiles).toContain(testFile);

      // Verify file was created
      const exists = await fs
        .access(testFile)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(true);
    });

    test("reports failed fixes", async () => {
      const issue: FixableIssue = {
        id: "failing-fix",
        description: "This fix will fail",
        category: "test",
        severity: "fail",
        safety: "safe",
        fix: async () => {
          throw new Error("Intentional failure");
        },
      };

      const results = await applyFixes([issue], { interactive: false });

      expect(results.length).toBe(1);
      expect(results[0].success).toBe(false);
      expect(results[0].message).toContain("Intentional failure");
    });

    test("dry run does not apply fixes", async () => {
      let applied = false;
      const issue: FixableIssue = {
        id: "dry-run-test",
        description: "Should not be applied",
        category: "test",
        severity: "warn",
        safety: "safe",
        fix: async () => {
          applied = true;
        },
      };

      const results = await applyFixes([issue], { dryRun: true });

      expect(applied).toBe(false);
      expect(results.length).toBe(1);
      expect(results[0].message).toContain("Dry run");
    });

    test("processes multiple fixes in order", async () => {
      const order: string[] = [];

      const issues: FixableIssue[] = [
        {
          id: "first",
          description: "First fix",
          category: "test",
          severity: "warn",
          safety: "safe",
          fix: async () => {
            order.push("first");
          },
        },
        {
          id: "second",
          description: "Second fix",
          category: "test",
          severity: "warn",
          safety: "safe",
          fix: async () => {
            order.push("second");
          },
        },
        {
          id: "third",
          description: "Third fix",
          category: "test",
          severity: "warn",
          safety: "safe",
          fix: async () => {
            order.push("third");
          },
        },
      ];

      await applyFixes(issues, { interactive: false });

      expect(order).toEqual(["first", "second", "third"]);
    });

    test("continues after individual fix failures", async () => {
      const applied: string[] = [];

      const issues: FixableIssue[] = [
        {
          id: "success-1",
          description: "First success",
          category: "test",
          severity: "warn",
          safety: "safe",
          fix: async () => {
            applied.push("success-1");
          },
        },
        {
          id: "failure",
          description: "Will fail",
          category: "test",
          severity: "warn",
          safety: "safe",
          fix: async () => {
            throw new Error("Fail");
          },
        },
        {
          id: "success-2",
          description: "Second success",
          category: "test",
          severity: "warn",
          safety: "safe",
          fix: async () => {
            applied.push("success-2");
          },
        },
      ];

      const results = await applyFixes(issues, { interactive: false });

      // Should have applied first and third fixes
      expect(applied).toContain("success-1");
      expect(applied).toContain("success-2");

      // Results should reflect the failure
      const failedResult = results.find((r) => r.id === "failure");
      expect(failedResult?.success).toBe(false);
    });

    test("skips cautious fixes without force flag", async () => {
      let applied = false;
      const issue: FixableIssue = {
        id: "cautious-fix",
        description: "Cautious operation",
        category: "config",
        severity: "fail",
        safety: "cautious",
        fix: async () => {
          applied = true;
        },
      };

      // Non-interactive, non-force mode should skip cautious fixes
      await applyFixes([issue], { interactive: false, force: false });

      expect(applied).toBe(false);
    });

    test("applies cautious fixes with force flag", async () => {
      let applied = false;
      const issue: FixableIssue = {
        id: "cautious-fix",
        description: "Cautious operation",
        category: "config",
        severity: "fail",
        safety: "cautious",
        fix: async () => {
          applied = true;
        },
      };

      await applyFixes([issue], { interactive: false, force: true });

      expect(applied).toBe(true);
    });

    test("manual fixes are never auto-applied", async () => {
      let applied = false;
      const issue: FixableIssue = {
        id: "manual-fix",
        description: "Manual operation",
        category: "external",
        severity: "fail",
        safety: "manual",
        fix: async () => {
          applied = true;
        },
      };

      // Even with force, manual fixes should not be applied
      await applyFixes([issue], { interactive: false, force: true });

      expect(applied).toBe(false);
    });
  });

  describe("Fix functions", () => {
    test("creates directory with correct permissions", async () => {
      const testDir = path.join(tmpDir, "new-dir");

      const issue: FixableIssue = {
        id: "create-dir",
        description: "Create directory",
        category: "storage",
        severity: "fail",
        safety: "safe",
        fix: async () => {
          await fs.mkdir(testDir, { recursive: true, mode: 0o700 });
        },
      };

      await applyFixes([issue], { interactive: false });

      const stats = await fs.stat(testDir);
      expect(stats.isDirectory()).toBe(true);
    });

    test("creates empty file", async () => {
      const testFile = path.join(tmpDir, "empty.txt");

      const issue: FixableIssue = {
        id: "create-empty-file",
        description: "Create empty file",
        category: "storage",
        severity: "warn",
        safety: "safe",
        fix: async () => {
          await fs.writeFile(testFile, "");
        },
      };

      await applyFixes([issue], { interactive: false });

      const content = await fs.readFile(testFile, "utf-8");
      expect(content).toBe("");
    });

    test("creates nested directories", async () => {
      const nestedDir = path.join(tmpDir, "a", "b", "c");

      const issue: FixableIssue = {
        id: "create-nested",
        description: "Create nested directories",
        category: "storage",
        severity: "warn",
        safety: "safe",
        fix: async () => {
          await fs.mkdir(nestedDir, { recursive: true });
        },
      };

      await applyFixes([issue], { interactive: false });

      const stats = await fs.stat(nestedDir);
      expect(stats.isDirectory()).toBe(true);
    });
  });

  describe("detectFixableIssues", () => {
    // Note: This tests the detection logic but can't easily test
    // the actual global directory detection without mocking
    test("returns array", async () => {
      const issues = await detectFixableIssues();
      expect(Array.isArray(issues)).toBe(true);
    });

    test("each issue has required fields", async () => {
      const issues = await detectFixableIssues();
      for (const issue of issues) {
        expect(typeof issue.id).toBe("string");
        expect(typeof issue.description).toBe("string");
        expect(typeof issue.category).toBe("string");
        expect(["warn", "fail"]).toContain(issue.severity);
        expect(["safe", "cautious", "manual"]).toContain(issue.safety);
        expect(typeof issue.fix).toBe("function");
      }
    });
  });

  describe("FixResult", () => {
    test("successful result has correct shape", () => {
      const result: FixResult = {
        id: "test-fix",
        success: true,
        message: "Fixed successfully",
      };

      expect(result.id).toBe("test-fix");
      expect(result.success).toBe(true);
      expect(result.message).toBe("Fixed successfully");
    });

    test("failed result includes error message", () => {
      const result: FixResult = {
        id: "failed-fix",
        success: false,
        message: "ENOENT: file not found",
      };

      expect(result.success).toBe(false);
      expect(result.message).toContain("ENOENT");
    });
  });

  describe("Mixed safety levels", () => {
    test("applies safe fixes and skips cautious without force", async () => {
      const applied: string[] = [];

      const issues: FixableIssue[] = [
        {
          id: "safe-1",
          description: "Safe fix",
          category: "test",
          severity: "warn",
          safety: "safe",
          fix: async () => {
            applied.push("safe-1");
          },
        },
        {
          id: "cautious-1",
          description: "Cautious fix",
          category: "test",
          severity: "warn",
          safety: "cautious",
          fix: async () => {
            applied.push("cautious-1");
          },
        },
        {
          id: "safe-2",
          description: "Another safe fix",
          category: "test",
          severity: "warn",
          safety: "safe",
          fix: async () => {
            applied.push("safe-2");
          },
        },
      ];

      await applyFixes(issues, { interactive: false, force: false });

      expect(applied).toContain("safe-1");
      expect(applied).toContain("safe-2");
      expect(applied).not.toContain("cautious-1");
    });

    test("applies all fixes with force", async () => {
      const applied: string[] = [];

      const issues: FixableIssue[] = [
        {
          id: "safe",
          description: "Safe",
          category: "test",
          severity: "warn",
          safety: "safe",
          fix: async () => {
            applied.push("safe");
          },
        },
        {
          id: "cautious",
          description: "Cautious",
          category: "test",
          severity: "warn",
          safety: "cautious",
          fix: async () => {
            applied.push("cautious");
          },
        },
      ];

      await applyFixes(issues, { interactive: false, force: true });

      expect(applied).toContain("safe");
      expect(applied).toContain("cautious");
    });
  });
});

describe("doctor missing-storage fixes preserve later writers", () => {
  async function withMissingDiagnostic(
    check: (fixture: { directory: string; file: string; issue: FixableIssue }) => Promise<void>,
    kind: "playbook" | "blocked-log" = "playbook",
  ): Promise<void> {
    await withTempDir("doctor-stale-storage", async root => {
      const memoryDirectory = path.join(root, "memory");
      await fs.mkdir(memoryDirectory);
      const directory = kind === "playbook" ? memoryDirectory : path.join(root, ".cass");
      const file = path.join(directory, kind === "playbook" ? "playbook.yaml" : "blocked.log");
      if (kind === "blocked-log") {
        const initialized = Bun.spawnSync(["git", "init", "--quiet", "--initial-branch=main", root]);
        expect(initialized.exitCode).toBe(0);
        await fs.mkdir(directory);
      }
      const previousHome = process.env.CASS_MEMORY_HOME;
      const previousCwd = process.cwd();
      process.env.CASS_MEMORY_HOME = memoryDirectory;
      process.chdir(root);
      try {
        const issues = await detectFixableIssues();
        const issue = issues.find(candidate => candidate.id === `missing-${kind}` && candidate.description.includes(file));
        expect(issue).toBeDefined();
        await check({ directory, file, issue: issue! });
      } finally {
        process.chdir(previousCwd);
        if (previousHome === undefined) delete process.env.CASS_MEMORY_HOME;
        else process.env.CASS_MEMORY_HOME = previousHome;
      }
    });
  }

  async function writeLearnedState(file: string): Promise<Buffer<ArrayBuffer>> {
    const playbook = createEmptyPlaybook("created-after-diagnosis");
    playbook.metadata.totalReflections = 3;
    playbook.metadata.totalSessionsProcessed = 7;
    playbook.bullets = [createTestBullet({
      id: "b-doctor-preserved", content: "Preserve feedback learned while a doctor diagnosis is awaiting repair.",
      helpfulCount: 1, sourceSessions: ["preserved-source-session"],
      feedbackEvents: [{ type: "helpful", timestamp: "2026-10-28T12:00:00Z", sessionPath: "preserved-source-session" }],
    })];
    await savePlaybook(playbook, file);
    return fs.readFile(file);
  }

  async function writeBlockedState(file: string): Promise<Buffer<ArrayBuffer>> {
    await fs.writeFile(file, `${JSON.stringify({
      id: "b-doctor-blocked",
      content: "Never erase learned blocked rules.",
      reason: "unsafe",
      forgottenAt: "2026-10-28T12:00:00Z",
    })}\n`);
    return fs.readFile(file);
  }

  test.serial("still initializes a playbook that is genuinely absent when the fix runs", async () => {
    await withMissingDiagnostic(async ({ file, issue }) => {
      await issue.fix();
      expect((await loadPlaybook(file)).bullets).toEqual([]);
      expect((await fs.stat(file)).isFile()).toBe(true);
    });
  });

  test.serial("preserves a valid playbook created after diagnosis byte for byte", async () => {
    await withMissingDiagnostic(async ({ file, issue }) => {
      const original = await writeLearnedState(file);
      await issue.fix();
      expect(await fs.readFile(file)).toEqual(original);
      expect((await loadPlaybook(file)).bullets[0]?.id).toBe("b-doctor-preserved");
    });
  });

  test.serial("still initializes a blocked log that is genuinely absent when the fix runs", async () => {
    await withMissingDiagnostic(async ({ file, issue }) => {
      await issue.fix();
      expect(await fs.readFile(file, "utf8")).toBe("");
      expect((await fs.stat(file)).isFile()).toBe(true);
    }, "blocked-log");
  });

  test.serial("preserves blocked records created after diagnosis byte for byte", async () => {
    await withMissingDiagnostic(async ({ file, issue }) => {
      const original = await writeBlockedState(file);
      await issue.fix();
      expect(await fs.readFile(file)).toEqual(original);
    }, "blocked-log");
  });

  for (const kind of ["playbook", "blocked-log"] as const) {
    test.serial(`rechecks ${kind} absence after acquiring the lock, including a writer that won the lock first`, async () => {
      await withMissingDiagnostic(async ({ file, issue }) => {
        let signalHeld!: () => void;
        let release!: () => void;
        const held = new Promise<void>(resolve => { signalHeld = resolve; });
        const released = new Promise<void>(resolve => { release = resolve; });
        const writer = withLock(file, async () => {
          signalHeld();
          await released;
        });
        await held;
        let signalAttempt!: () => void;
        const attempted = new Promise<void>(resolve => { signalAttempt = resolve; });
        const realMkdir = fs.mkdir.bind(fs);
        const mkdirSpy = spyOn(fs, "mkdir").mockImplementation(((...args: Parameters<typeof fs.mkdir>) => {
          if (String(args[0]) === `${file}.lock.d`) signalAttempt();
          return realMkdir(...args);
        }) as typeof fs.mkdir);
        const fixing = issue.fix();
        try {
          await attempted;
          const original = await (kind === "playbook" ? writeLearnedState(file) : writeBlockedState(file));
          release();
          await writer;
          await fixing;
          expect(await fs.readFile(file)).toEqual(original);
        } finally {
          release();
          await Promise.allSettled([writer, fixing]);
          mkdirSpy.mockRestore();
        }
      }, kind);
    });
  }

  test.serial("preserves an oversized legacy file that arrives after the missing-file diagnostic", async () => {
    await withMissingDiagnostic(async ({ directory, file, issue }) => {
      const handle = await fs.open(file, "wx");
      try {
        await handle.writeFile("Legacy learned state must be preserved\n");
        await handle.truncate(PLAYBOOK_INPUT_LIMITS.maxBytes + 1);
      } finally {
        await handle.close();
      }
      const before = await fs.stat(file);
      await issue.fix();
      const after = await fs.stat(file);
      expect(after.size).toBe(PLAYBOOK_INPUT_LIMITS.maxBytes + 1);
      expect(after.ino).toBe(before.ino);
      expect(after.mtimeMs).toBe(before.mtimeMs);
      expect(await fs.readdir(directory)).toEqual(["playbook.yaml"]);
    });
  });

  for (const code of ["EIO", "EACCES"]) {
    test.serial(`reports ${code} during the under-lock recheck without overwriting learned state`, async () => {
      await withMissingDiagnostic(async ({ file, issue }) => {
        const original = await writeLearnedState(file);
        const realAccess = fs.access.bind(fs);
        const failure = Object.assign(new Error(`injected ${code} under-lock probe`), { code });
        const accessSpy = spyOn(fs, "access").mockImplementation(async (...args: Parameters<typeof fs.access>) => {
          if (String(args[0]) === file) throw failure;
          return realAccess(...args);
        });
        try {
          if (code === "EACCES") {
            await expect(applyFixes([issue], { quiet: true })).rejects.toMatchObject({
              errorCode: "EACCES", path: file,
            });
          } else {
            const results = await applyFixes([issue], { quiet: true });
            expect(results[0]?.success).toBe(false);
            expect(results[0]?.message).toContain(`injected ${code}`);
          }
        } finally {
          accessSpy.mockRestore();
        }
        expect(await fs.readFile(file)).toEqual(original);
      });
    });
  }
});
