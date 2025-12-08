import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  detectFixableIssues,
  applyFixes,
  type FixableIssue,
  type FixResult,
  type ApplyFixesOptions,
} from "../src/commands/doctor.js";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

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
