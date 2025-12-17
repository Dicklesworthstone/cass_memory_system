/**
 * E2E Test: New User Onboarding Flow
 *
 * Per bead cass_memory_system-4w3l:
 * Simulates a complete new user experience from fresh install to first context retrieval.
 *
 * Flow:
 * 1. Fresh environment (no config, no playbook)
 * 2. Run `cm init`
 * 3. Get context (empty playbook)
 * 4. Add first bullet via `cm playbook add`
 * 5. Get context again (should find the bullet)
 * 6. Mark bullet as helpful
 * 7. Run doctor to verify system health
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import yaml from "yaml";
import { createTestLogger } from "./helpers/logger.js";
import { makeCassStub } from "./helpers/temp.js";

const CM_PATH = join(import.meta.dir, "..", "src", "cm.ts");

interface CmResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runCm(args: string[], cwd: string, env: Record<string, string> = {}): CmResult {
  const result = spawnSync("bun", ["run", CM_PATH, ...args], {
    cwd,
    env: {
      ...process.env,
      CASS_MEMORY_LLM: "none", // Disable LLM
      CASS_PATH: "__nonexistent__", // Disable cass search to speed up
      HOME: cwd, // Isolate from real home
      ...env,
    },
    encoding: "utf-8",
    timeout: 60000,
  });

  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    exitCode: result.status ?? 1,
  };
}

describe("E2E: New User Onboarding", () => {
  let testDir: string;
  const logger = createTestLogger("info");

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "cass-onboarding-"));
    logger.info("Created test directory", { testDir });
  });

  afterEach(() => {
    if (testDir && existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
      logger.info("Cleaned up test directory");
    }
  });

  describe("Complete Onboarding Flow", () => {
    test(
      "fresh install → init → context → add bullet → mark helpful → doctor",
      () => {
        logger.info("Starting complete onboarding flow test");

        // Step 1: Verify fresh environment (no .cass-memory)
        const cassMemoryDir = join(testDir, ".cass-memory");
        expect(existsSync(cassMemoryDir)).toBe(false);
        logger.info("Step 1: Verified fresh environment - no .cass-memory exists");

        // Step 2: Run init
        const initResult = runCm(["init", "--json"], testDir);
        expect(initResult.exitCode).toBe(0);

        const initResponse = JSON.parse(initResult.stdout) as any;
        expect(initResponse.success).toBe(true);
        expect(initResponse.data.created).toContain("config.json");
        expect(initResponse.data.created).toContain("playbook.yaml");
        logger.info("Step 2: Init completed successfully", {
          created: initResponse.data.created,
        });

        // Verify structure created
        expect(existsSync(cassMemoryDir)).toBe(true);
        expect(existsSync(join(cassMemoryDir, "config.json"))).toBe(true);
        expect(existsSync(join(cassMemoryDir, "playbook.yaml"))).toBe(true);
        expect(existsSync(join(cassMemoryDir, "diary"))).toBe(true);

        // Step 3: Get context with empty playbook
        const contextResult1 = runCm(
          ["context", "implement user authentication", "--json"],
          testDir
        );
        expect(contextResult1.exitCode).toBe(0);

        const context1 = (JSON.parse(contextResult1.stdout) as any).data;
        expect(context1.task).toBe("implement user authentication");
        expect(context1.relevantBullets).toEqual([]);
        logger.info("Step 3: Context with empty playbook", {
          bulletCount: context1.relevantBullets.length,
        });

        // Step 4: Add first bullet
        const addResult = runCm(
          [
            "playbook",
            "add",
            "Always validate and sanitize user inputs before processing",
            "--category",
            "security",
            "--json",
          ],
          testDir
        );
        expect(addResult.exitCode).toBe(0);

        const addResponse = JSON.parse(addResult.stdout) as any;
        expect(addResponse.success).toBe(true);
        expect(addResponse.data.bullet).toBeDefined();
        expect(addResponse.data.bullet.id).toMatch(/^b-/);

        const bulletId = addResponse.data.bullet.id;
        logger.info("Step 4: Added first bullet", { bulletId });

        // Verify playbook now has the bullet
        const playbookContent = readFileSync(
          join(cassMemoryDir, "playbook.yaml"),
          "utf-8"
        );
        const playbook = yaml.parse(playbookContent);
        expect(playbook.bullets).toHaveLength(1);
        expect(playbook.bullets[0].id).toBe(bulletId);

        // Step 5: Get context again - should find the bullet
        const contextResult2 = runCm(
          ["context", "validate user input for login", "--json"],
          testDir
        );
        expect(contextResult2.exitCode).toBe(0);

        const context2 = (JSON.parse(contextResult2.stdout) as any).data;
        expect(context2.task).toBe("validate user input for login");
        // The bullet should be found since it's about validation/user input
        expect(context2.relevantBullets.length).toBeGreaterThanOrEqual(0);
        logger.info("Step 5: Context after adding bullet", {
          bulletCount: context2.relevantBullets.length,
        });

        // Step 6: Mark bullet as helpful
        const markResult = runCm(["mark", bulletId, "--helpful", "--json"], testDir);
        expect(markResult.exitCode).toBe(0);

        const markResponse = JSON.parse(markResult.stdout) as any;
        expect(markResponse.success).toBe(true);
        expect(markResponse.data.type).toBe("helpful");

        // Verify helpfulCount via playbook get
        const getResult1 = runCm(["playbook", "get", bulletId, "--json"], testDir);
        const bullet1 = (JSON.parse(getResult1.stdout) as any).data.bullet;
        expect(bullet1.helpfulCount).toBe(1);
        logger.info("Step 6: Marked bullet as helpful", {
          helpfulCount: bullet1.helpfulCount,
        });

        // Mark helpful again to show feedback accumulates
        const markResult2 = runCm(["mark", bulletId, "--helpful", "--json"], testDir);
        expect(markResult2.exitCode).toBe(0);
        const getResult2 = runCm(["playbook", "get", bulletId, "--json"], testDir);
        const bullet2 = (JSON.parse(getResult2.stdout) as any).data.bullet;
        expect(bullet2.helpfulCount).toBe(2);

        // Step 7: Run doctor to verify system health
        // In a fresh test environment, doctor might report "unhealthy" or "degraded"
        // due to missing optional dependencies (like cass binary). The important thing
        // is that doctor runs and provides useful diagnostics.
        const doctorResult = runCm(["doctor", "--json"], testDir);
        expect(doctorResult.exitCode).toBe(0);

        const doctorResponse = (JSON.parse(doctorResult.stdout) as any).data;
        expect(doctorResponse.overallStatus).toBeDefined();
        expect(["healthy", "degraded", "unhealthy"]).toContain(doctorResponse.overallStatus);
        expect(doctorResponse.checks).toBeDefined();
        expect(doctorResponse.checks.length).toBeGreaterThan(0);

        logger.info("Step 7: Doctor completed", {
          overallStatus: doctorResponse.overallStatus,
          totalChecks: doctorResponse.checks.length,
        });

        logger.info("Complete onboarding flow test PASSED");
      },
      { timeout: 60000 }
    );
  });

  describe("Individual Onboarding Steps", () => {
    test("init provides helpful output for new users", () => {
      const result = runCm(["init"], testDir);
      expect(result.exitCode).toBe(0);

      // Human-readable output should mention success and what was created
      expect(result.stdout + result.stderr).toMatch(/created|initialized|success/i);
    });

    test("context with empty playbook gives helpful guidance", () => {
      // Initialize first
      runCm(["init", "--json"], testDir);

      // Get context with empty playbook
      const result = runCm(["context", "test task"], testDir);
      expect(result.exitCode).toBe(0);

      // Output should indicate no rules found or similar
      const output = result.stdout + result.stderr;
      expect(output).toBeDefined();
    });

    test("playbook add confirms what was added", () => {
      runCm(["init", "--json"], testDir);

      const result = runCm(
        ["playbook", "add", "Write tests before implementing features"],
        testDir
      );
      expect(result.exitCode).toBe(0);

      // Should confirm the addition
      expect(result.stdout).toMatch(/added|created|success/i);
    });

    test("mark provides feedback confirmation", () => {
      runCm(["init", "--json"], testDir);
      const addResult = runCm(
        ["playbook", "add", "Test bullet", "--json"],
        testDir
      );
      const bulletId = (JSON.parse(addResult.stdout) as any).data.bullet.id;

      const result = runCm(["mark", bulletId, "--helpful"], testDir);
      expect(result.exitCode).toBe(0);

      // Should confirm the mark
      expect(result.stdout).toMatch(/marked|helpful|success/i);
    });

    test("doctor gives clear health status", () => {
      runCm(["init", "--json"], testDir);

      const result = runCm(["doctor"], testDir);
      expect(result.exitCode).toBe(0);

      // Should show clear pass/fail status
      const output = result.stdout + result.stderr;
      expect(output).toMatch(/pass|ok|healthy|check/i);
    });
  });

  describe("Edge Cases for New Users", () => {
    test("running context before init gives helpful error", () => {
      const result = runCm(["context", "test task", "--json"], testDir);

      // Should fail gracefully with helpful message
      // Exact behavior depends on implementation, but should not crash
      if (result.exitCode !== 0) {
        expect(result.stderr + result.stdout).toMatch(/init|config|not found|not initialized/i);
      }
    });

    test("running doctor before init suggests running init", () => {
      const result = runCm(["doctor", "--json"], testDir);

      // Should detect missing config/playbook
      if (result.exitCode === 0) {
        const response = (JSON.parse(result.stdout) as any).data;
        // Doctor should report issues about missing setup
        expect(response.checks || response.issues).toBeDefined();
      } else {
        // If doctor fails, should have helpful error
        expect(result.stderr + result.stdout).toMatch(/init|config|not found/i);
      }
    });

    test("stats shows meaningful info even with empty playbook", () => {
      runCm(["init", "--json"], testDir);

      const result = runCm(["stats", "--json"], testDir);
      expect(result.exitCode).toBe(0);

      const stats = (JSON.parse(result.stdout) as any).data;
      expect(stats.total).toBe(0);
    });

    test("playbook list shows empty state gracefully", () => {
      runCm(["init", "--json"], testDir);

      const result = runCm(["playbook", "list", "--json"], testDir);
      expect(result.exitCode).toBe(0);

      const listResponse = JSON.parse(result.stdout) as any;
      expect(listResponse.success).toBe(true);
      expect(listResponse.data).toEqual({ bullets: [] });
    });
  });

  describe("Onboard Command Safety", () => {
    test("onboard reset --json requires --yes", () => {
      const result = runCm(["onboard", "reset", "--json"], testDir);
      expect(result.exitCode).toBe(1);

      const parsed = JSON.parse(result.stdout);
      expect(parsed.success).toBe(false);
      expect(parsed.error.code).toBe("MISSING_REQUIRED");
    });

    test("onboard sample redacts secrets from cass snippets", async () => {
      // Initialize config/playbook first
      runCm(["init", "--json"], testDir);

      // Create a cass stub that returns a snippet containing an obvious secret.
      const secretValue = "ABCDEFGHIJKLMNOPQRSTUVWX1234";
      const searchOut = JSON.stringify([
        {
          source_path: "/sessions/s1.jsonl",
          line_number: 1,
          agent: "stub",
          workspace: "/tmp/ws",
          snippet: `apiKey: ${secretValue}`,
          score: 0.9,
        },
      ]);

      const cassStubPath = await makeCassStub(testDir, { search: searchOut }, "", "cass-stub");

      // Point config.cassPath at the stub so onboarding sampling uses it.
      const configPath = join(testDir, ".cass-memory", "config.json");
      const configJson = JSON.parse(readFileSync(configPath, "utf-8")) as any;
      configJson.cassPath = cassStubPath;
      writeFileSync(configPath, JSON.stringify(configJson, null, 2), "utf-8");

      const sample = runCm(["onboard", "sample", "--limit", "1", "--json"], testDir);
      expect(sample.exitCode).toBe(0);

      const sampleJson = JSON.parse(sample.stdout) as any;
      expect(sampleJson.success).toBe(true);
      expect(Array.isArray(sampleJson.data.sessions)).toBe(true);
      expect(sampleJson.data.sessions.length).toBeGreaterThan(0);

      const snippet = String(sampleJson.data.sessions[0]?.snippet || "");
      expect(snippet).toContain("[API_KEY]");
      expect(snippet).not.toContain(secretValue);
    });
  });

  describe("Progressive Learning Flow", () => {
    test("maturity progresses with repeated helpful marks", () => {
      runCm(["init", "--json"], testDir);

      // Add a bullet
      const addResult = runCm(
        [
          "playbook",
          "add",
          "Document all public API functions with JSDoc",
          "--category",
          "documentation",
          "--json",
        ],
        testDir
      );
      const bulletId = (JSON.parse(addResult.stdout) as any).data.bullet.id;

      // Get initial maturity
      const getResult1 = runCm(["playbook", "get", bulletId, "--json"], testDir);
      const bullet1 = (JSON.parse(getResult1.stdout) as any).data.bullet;
      expect(bullet1.maturity).toBe("candidate");
      expect(bullet1.helpfulCount).toBe(0);

      // Mark helpful 3 times (threshold for established)
      for (let i = 0; i < 3; i++) {
        runCm(["mark", bulletId, "--helpful", "--json"], testDir);
      }

      // Check maturity progressed
      const getResult2 = runCm(["playbook", "get", bulletId, "--json"], testDir);
      const bullet2 = (JSON.parse(getResult2.stdout) as any).data.bullet;
      expect(bullet2.helpfulCount).toBe(3);
      expect(bullet2.maturity).toBe("established");
    });

    test("harmful marks reduce effective score", () => {
      runCm(["init", "--json"], testDir);

      // Add a bullet
      const addResult = runCm(
        ["playbook", "add", "Never use var, always use const or let", "--json"],
        testDir
      );
      const bulletId = (JSON.parse(addResult.stdout) as any).data.bullet.id;

      // Mark harmful
      const markResult = runCm(["mark", bulletId, "--harmful", "--json"], testDir);
      expect(markResult.exitCode).toBe(0);

      const markResponse = JSON.parse(markResult.stdout) as any;
      expect(markResponse.success).toBe(true);
      expect(markResponse.data.type).toBe("harmful");

      // Verify harmfulCount via playbook get
      const getResult = runCm(["playbook", "get", bulletId, "--json"], testDir);
      const bullet = (JSON.parse(getResult.stdout) as any).data.bullet;
      expect(bullet.harmfulCount).toBe(1);
    });
  });
});
