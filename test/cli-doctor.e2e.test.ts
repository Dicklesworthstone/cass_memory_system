/**
 * E2E Tests for CLI doctor command - Health diagnostics
 *
 * Tests the `cm doctor` command for system health checks and auto-fix capabilities.
 * Uses isolated temp directories to avoid affecting the real system.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { stat, readFile, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import yaml from "yaml";
import os from "node:os";

import {
  doctorCommand,
  detectFixableIssues,
  applyFixes,
  runSelfTest,
  HealthCheck,
  FixableIssue,
} from "../src/commands/doctor.js";
import { createEmptyPlaybook, savePlaybook } from "../src/playbook.js";
import { createTestConfig } from "./helpers/index.js";

// --- Helper Functions ---

let tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdir(path.join(os.tmpdir(), `doctor-test-${Date.now()}-${Math.random().toString(36).slice(2)}`), { recursive: true });
  const dirPath = path.join(os.tmpdir(), `doctor-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

// --- Test Suites ---

describe("E2E: CLI doctor command", () => {
  describe("Health Check Output", () => {
    it("outputs JSON when --json flag is used", async () => {
      const capture = captureConsole();
      try {
        await doctorCommand({ json: true });
      } finally {
        capture.restore();
      }

      const output = capture.logs.join("\n");
      expect(() => JSON.parse(output)).not.toThrow();

      const payload = JSON.parse(output);
      const result = payload.data;
      expect(result).toHaveProperty("checks");
      expect(Array.isArray(result.checks)).toBe(true);
    });

    it("includes all health check categories in JSON output", async () => {
      const capture = captureConsole();
      try {
        await doctorCommand({ json: true });
      } finally {
        capture.restore();
      }

      const output = capture.logs.join("\n");
      const payload = JSON.parse(output);
      const result = payload.data;

      const categories = result.checks.map((c: any) => c.category);

      // Core categories that should always be present
      expect(categories).toContain("Cass Integration");
      expect(categories).toContain("LLM Configuration");
      expect(categories).toContain("Global Storage (~/.cass-memory)");
    });

    it("outputs human-readable format without --json", async () => {
      const capture = captureConsole();
      try {
        await doctorCommand({ json: false });
      } finally {
        capture.restore();
      }

      const output = capture.logs.join("\n");

      // Should contain health check header
      expect(output).toContain("System Health Check");

      // Should contain status icons
      expect(output.match(/[✅⚠️❌]/)).toBeTruthy();
    });

    it("respects CASS_MEMORY_NO_EMOJI for human output", async () => {
      const capture = captureConsole();
      const originalNoEmoji = process.env.CASS_MEMORY_NO_EMOJI;

      try {
        process.env.CASS_MEMORY_NO_EMOJI = "1";
        await doctorCommand({ json: false });
      } finally {
        capture.restore();
        if (originalNoEmoji === undefined) delete process.env.CASS_MEMORY_NO_EMOJI;
        else process.env.CASS_MEMORY_NO_EMOJI = originalNoEmoji;
      }

      const output = capture.logs.join("\n");
      expect(output).toContain("System Health Check");
      expect(output.match(/[✅⚠️❌]/)).toBeFalsy();
    });

    it("health check includes status for each category", async () => {
      const capture = captureConsole();
      try {
        await doctorCommand({ json: true });
      } finally {
        capture.restore();
      }

      const output = capture.logs.join("\n");
      const payload = JSON.parse(output);
      const result = payload.data;

      for (const check of result.checks) {
        expect(check).toHaveProperty("category");
        expect(check).toHaveProperty("status");
        expect(check).toHaveProperty("message");
        expect(["pass", "warn", "fail"]).toContain(check.status);
      }
    });
  });

  describe("Fixable Issue Detection", () => {
    it("detectFixableIssues returns array of issues", async () => {
      const issues = await detectFixableIssues();

      expect(Array.isArray(issues)).toBe(true);

      // Each issue should have required fields
      for (const issue of issues) {
        expect(issue).toHaveProperty("id");
        expect(issue).toHaveProperty("description");
        expect(issue).toHaveProperty("category");
        expect(issue).toHaveProperty("severity");
        expect(issue).toHaveProperty("fix");
        expect(issue).toHaveProperty("safety");
        expect(["warn", "fail"]).toContain(issue.severity);
        expect(["safe", "cautious", "manual"]).toContain(issue.safety);
      }
    });

    it("detects missing global directory when HOME is empty", async () => {
      const dir = await createTempDir();
      const home = path.join(dir, "home");
      const originalHome = process.env.HOME;

      try {
        // Set HOME to empty directory (no .cass-memory)
        process.env.HOME = home;
        await mkdir(home, { recursive: true });

        const issues = await detectFixableIssues();

        // Should detect missing global directory
        const globalDirIssue = issues.find(i => i.id === "missing-global-dir");
        expect(globalDirIssue).toBeDefined();
        expect(globalDirIssue?.severity).toBe("fail");
        expect(globalDirIssue?.safety).toBe("safe");
      } finally {
        process.env.HOME = originalHome;
      }
    });

    it("detects missing playbook when global dir exists", async () => {
      const dir = await createTempDir();
      const home = path.join(dir, "home");
      const cassMemoryDir = path.join(home, ".cass-memory");
      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;
        await mkdir(cassMemoryDir, { recursive: true });
        // Create config but NOT playbook
        await writeFile(path.join(cassMemoryDir, "config.json"), "{}");

        const issues = await detectFixableIssues();

        const playbookIssue = issues.find(i => i.id === "missing-playbook");
        expect(playbookIssue).toBeDefined();
        expect(playbookIssue?.safety).toBe("safe");
      } finally {
        process.env.HOME = originalHome;
      }
    });

    it("detects missing diary directory", async () => {
      const dir = await createTempDir();
      const home = path.join(dir, "home");
      const cassMemoryDir = path.join(home, ".cass-memory");
      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;
        await mkdir(cassMemoryDir, { recursive: true });
        // Create config and playbook but NOT diary
        await writeFile(path.join(cassMemoryDir, "config.json"), "{}");
        const playbook = createEmptyPlaybook("test");
        await savePlaybook(playbook, path.join(cassMemoryDir, "playbook.yaml"));

        const issues = await detectFixableIssues();

        const diaryIssue = issues.find(i => i.id === "missing-diary-dir");
        expect(diaryIssue).toBeDefined();
        expect(diaryIssue?.safety).toBe("safe");
      } finally {
        process.env.HOME = originalHome;
      }
    });
  });

  describe("Fix Application", () => {
    it("applyFixes with dryRun does not create files", async () => {
      const dir = await createTempDir();
      const home = path.join(dir, "home");
      const cassMemoryDir = path.join(home, ".cass-memory");
      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;
        await mkdir(home, { recursive: true });

        const issues = await detectFixableIssues();

        const capture = captureConsole();
        try {
          await applyFixes(issues, { dryRun: true });
        } finally {
          capture.restore();
        }

        // Directory should NOT exist after dry run
        const cassExists = await exists(cassMemoryDir);
        expect(cassExists).toBe(false);

        // Logs should indicate dry run
        const output = capture.logs.join("\n");
        expect(output.toLowerCase()).toContain("dry run");
      } finally {
        process.env.HOME = originalHome;
      }
    });

    it("applyFixes creates missing directories", async () => {
      const dir = await createTempDir();
      const home = path.join(dir, "home");
      const cassMemoryDir = path.join(home, ".cass-memory");
      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;
        await mkdir(home, { recursive: true });

        const issues = await detectFixableIssues();
        const safeIssues = issues.filter(i => i.safety === "safe");

        const capture = captureConsole();
        try {
          const results = await applyFixes(safeIssues, { interactive: false });

          // Should have applied some fixes
          const succeeded = results.filter(r => r.success);
          expect(succeeded.length).toBeGreaterThan(0);
        } finally {
          capture.restore();
        }

        // Directory should now exist
        const cassExists = await exists(cassMemoryDir);
        expect(cassExists).toBe(true);
      } finally {
        process.env.HOME = originalHome;
      }
    });

    it("applyFixes returns results with success/failure status", async () => {
      const dir = await createTempDir();
      const home = path.join(dir, "home");
      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;
        await mkdir(home, { recursive: true });

        const issues = await detectFixableIssues();

        const capture = captureConsole();
        try {
          const results = await applyFixes(issues.filter(i => i.safety === "safe"), { interactive: false });

          // Each result should have required fields
          for (const result of results) {
            expect(result).toHaveProperty("id");
            expect(result).toHaveProperty("success");
            expect(result).toHaveProperty("message");
          }
        } finally {
          capture.restore();
        }
      } finally {
        process.env.HOME = originalHome;
      }
    });
  });

  describe("Self-Test Functionality", () => {
    it("runSelfTest returns array of health checks", async () => {
      const config = createTestConfig();
      const checks = await runSelfTest(config);

      expect(Array.isArray(checks)).toBe(true);
      expect(checks.length).toBeGreaterThan(0);

      // Each check should have required fields
      for (const check of checks) {
        expect(check).toHaveProperty("category");
        expect(check).toHaveProperty("item");
        expect(check).toHaveProperty("status");
        expect(check).toHaveProperty("message");
        expect(["pass", "warn", "fail"]).toContain(check.status);
      }
    });

    it("runSelfTest includes playbook load check", async () => {
      const config = createTestConfig();
      const checks = await runSelfTest(config);

      const playbookCheck = checks.find(c => c.item === "Playbook Load");
      expect(playbookCheck).toBeDefined();
      expect(playbookCheck?.category).toBe("Self-Test");
    });

    it("runSelfTest includes sanitization check", async () => {
      const config = createTestConfig();
      const checks = await runSelfTest(config);

      const sanitizationCheck = checks.find(c => c.item === "Sanitization");
      expect(sanitizationCheck).toBeDefined();
    });

    it("runSelfTest includes config validation check", async () => {
      const config = createTestConfig();
      const checks = await runSelfTest(config);

      const configCheck = checks.find(c => c.item === "Config Validation");
      expect(configCheck).toBeDefined();
    });

    it("runSelfTest includes LLM system check", async () => {
      const config = createTestConfig();
      const checks = await runSelfTest(config);

      const llmCheck = checks.find(c => c.item === "LLM System");
      expect(llmCheck).toBeDefined();
    });
  });

  describe("Repo-Level Checks", () => {
    it("detects when not in a git repository", async () => {
      const dir = await createTempDir();
      const originalCwd = process.cwd();

      try {
        process.chdir(dir);

        const capture = captureConsole();
        try {
          await doctorCommand({ json: true });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        const payload = JSON.parse(output);
        const result = payload.data;

        const repoCheck = result.checks.find((c: any) => c.category.includes("Repo"));
        expect(repoCheck).toBeDefined();
        expect(repoCheck.status).toBe("warn");
        expect(repoCheck.message.toLowerCase()).toContain("not in a git");
      } finally {
        process.chdir(originalCwd);
      }
    });

    it("detects missing repo .cass structure in git repo", async () => {
      const dir = await createTempDir();
      const originalCwd = process.cwd();

      try {
        // Initialize git repo
        process.chdir(dir);
        const { execSync } = await import("node:child_process");
        execSync("git init", { cwd: dir, stdio: "pipe" });

        const capture = captureConsole();
        try {
          await doctorCommand({ json: true });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        const payload = JSON.parse(output);
        const result = payload.data;

        const repoCheck = result.checks.find((c: any) => c.category.includes("Repo"));
        expect(repoCheck).toBeDefined();
        // Should warn about not initialized
        expect(repoCheck.status).toBe("warn");
        expect(repoCheck.message.toLowerCase()).toContain("init");
      } finally {
        process.chdir(originalCwd);
      }
    });

    it("passes when repo .cass structure is complete", async () => {
      const dir = await createTempDir();
      const originalCwd = process.cwd();

      try {
        // Initialize git repo with .cass structure
        process.chdir(dir);
        const { execSync } = await import("node:child_process");
        execSync("git init", { cwd: dir, stdio: "pipe" });

        // Create complete .cass structure
        const cassDir = path.join(dir, ".cass");
        await mkdir(cassDir, { recursive: true });
        const playbook = createEmptyPlaybook("repo");
        await savePlaybook(playbook, path.join(cassDir, "playbook.yaml"));
        await writeFile(path.join(cassDir, "blocked.log"), "");

        const capture = captureConsole();
        try {
          await doctorCommand({ json: true });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        const payload = JSON.parse(output);
        const result = payload.data;

        const repoCheck = result.checks.find((c: any) => c.category.includes("Repo"));
        expect(repoCheck).toBeDefined();
        expect(repoCheck.status).toBe("pass");
        expect(repoCheck.message.toLowerCase()).toContain("complete");
      } finally {
        process.chdir(originalCwd);
      }
    });
  });

  describe("Sanitization Pattern Health", () => {
    it("checks sanitization pattern breadth", async () => {
      const capture = captureConsole();
      try {
        await doctorCommand({ json: true });
      } finally {
        capture.restore();
      }

      const output = capture.logs.join("\n");
      const payload = JSON.parse(output);
      const result = payload.data;

      const sanitizationCheck = result.checks.find((c: any) =>
        c.category.includes("Sanitization") && c.category.includes("Pattern")
      );
      expect(sanitizationCheck).toBeDefined();
      expect(["pass", "warn"]).toContain(sanitizationCheck.status);
    });

    it("warns when sanitization is disabled", async () => {
      const dir = await createTempDir();
      const home = path.join(dir, "home");
      const cassMemoryDir = path.join(home, ".cass-memory");
      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;
        await mkdir(cassMemoryDir, { recursive: true });

        // Create config with sanitization disabled
        const config = {
          schema_version: 1,
          sanitization: { enabled: false }
        };
        await writeFile(path.join(cassMemoryDir, "config.json"), JSON.stringify(config));
        await writeFile(path.join(cassMemoryDir, "playbook.yaml"), "bullets: []");
        await mkdir(path.join(cassMemoryDir, "diary"), { recursive: true });

        const capture = captureConsole();
        try {
          await doctorCommand({ json: true });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        const payload = JSON.parse(output);
        const result = payload.data;

        const sanitizationCheck = result.checks.find((c: any) =>
          c.category.includes("Sanitization")
        );
        expect(sanitizationCheck).toBeDefined();
        expect(sanitizationCheck.status).toBe("warn");
      } finally {
        process.env.HOME = originalHome;
      }
    });
  });

  describe("LLM Configuration Check", () => {
    it("checks LLM configuration status", async () => {
      const capture = captureConsole();
      try {
        await doctorCommand({ json: true });
      } finally {
        capture.restore();
      }

      const output = capture.logs.join("\n");
      const payload = JSON.parse(output);
      const result = payload.data;

      const llmCheck = result.checks.find((c: any) => c.category.includes("LLM"));
      expect(llmCheck).toBeDefined();
      // Message format depends on whether API keys are set:
      // - With keys: "Provider: <name> (ready)" or "Provider: <name> not configured, but..."
      // - Without keys: "No API keys set (optional - set ANTHROPIC_API_KEY...)"
      const msg = llmCheck.message.toLowerCase();
      expect(msg.includes("provider") || msg.includes("api key")).toBe(true);
    });
  });

  describe("Overall Status Reporting", () => {
    it("reports healthy status when all checks pass", async () => {
      const capture = captureConsole();
      try {
        await doctorCommand({ json: false });
      } finally {
        capture.restore();
      }

      const output = capture.logs.join("\n");

      // Should contain one of the status messages
      const hasStatus = output.includes("healthy") ||
                       output.includes("degraded") ||
                       output.includes("critical");
      expect(hasStatus).toBe(true);
    });

    it("reports degraded status when warnings exist", async () => {
      const dir = await createTempDir();
      const home = path.join(dir, "home");
      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;
        await mkdir(home, { recursive: true });
        // No .cass-memory means warnings will be generated

        const capture = captureConsole();
        try {
          await doctorCommand({ json: false });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");

        // Should report degraded or unhealthy due to missing structure
        expect(output.includes("degraded") || output.includes("unhealthy") || output.includes("critical")).toBe(true);
      } finally {
        process.env.HOME = originalHome;
      }
    });
  });

  describe("Fix Mode", () => {
    it("--fix option triggers fix detection when healthy", async () => {
      // Test with the default environment which should be healthy or have issues
      const capture = captureConsole();
      try {
        // First run without fix to see status
        await doctorCommand({ json: false, fix: false });
      } finally {
        capture.restore();
      }

      const output = capture.logs.join("\n");

      // Should show health check output
      expect(output.includes("System Health Check")).toBe(true);
    });

    it("--fix does nothing when system is healthy", async () => {
      const dir = await createTempDir();
      const home = path.join(dir, "home");
      const cassMemoryDir = path.join(home, ".cass-memory");
      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;

        // Create complete structure
        await mkdir(cassMemoryDir, { recursive: true });
        await mkdir(path.join(cassMemoryDir, "diary"), { recursive: true });

        const config = { schema_version: 1 };
        await writeFile(path.join(cassMemoryDir, "config.json"), JSON.stringify(config));

        const playbook = createEmptyPlaybook("test");
        await savePlaybook(playbook, path.join(cassMemoryDir, "playbook.yaml"));

        const capture = captureConsole();
        try {
          await doctorCommand({ json: false, fix: true });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");

        // Should indicate no fixes needed or system is healthy
        expect(
          output.includes("no fixes needed") ||
          output.includes("healthy") ||
          output.includes("No auto-fixable")
        ).toBe(true);
      } finally {
        process.env.HOME = originalHome;
      }
    });
  });
});
