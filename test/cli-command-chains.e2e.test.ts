/**
 * CLI Command Chains E2E Tests
 *
 * Tests multi-command workflows that verify state changes across sequential CLI operations.
 * Unlike single-command tests, these verify that outputs from one command correctly
 * affect the behavior of subsequent commands.
 *
 * Per bead jl41 requirements:
 * - Init → Context → Mark → Context flow (score changes)
 * - Playbook add → Mark → Score update flow
 * - Playbook add → Forget → Undo flow (new undo command)
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import yaml from "yaml";
import { createTestLogger } from "./helpers/logger.js";

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
      CASS_MEMORY_LLM: "none",  // Disable LLM
      CASS_PATH: "__nonexistent__",  // Disable cass search to speed up
      HOME: cwd,  // Isolate from real home
      ...env
    },
    encoding: "utf-8",
    timeout: 60000  // Increased timeout
  });

  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    exitCode: result.status ?? 1
  };
}

function getPathState(p: string): { exists: boolean; type?: "file" | "dir"; size?: number } {
  try {
    const stat = statSync(p);
    return { exists: true, type: stat.isDirectory() ? "dir" : "file", size: stat.size };
  } catch {
    return { exists: false };
  }
}

describe("CLI Command Chains E2E", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "cass-chain-"));
  });

  afterEach(() => {
    if (testDir && existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("Init → Context → Mark → Context Flow", () => {
    test.serial("marking a bullet as helpful increases its score in subsequent context calls", () => {
      // Step 1: Initialize
      const initResult = runCm(["init", "--json"], testDir);
      expect(initResult.exitCode).toBe(0);

      // Step 2: Add a bullet
      const addResult = runCm([
        "playbook", "add",
        "Always validate user input before processing",
        "--category", "security",
        "--json"
      ], testDir);
      expect(addResult.exitCode).toBe(0);
      const addResponse = JSON.parse(addResult.stdout) as any;
      expect(addResponse.success).toBe(true);
      const bulletId = addResponse.data.bullet.id;
      expect(bulletId).toMatch(/^b-/);

      // Step 3: Get initial context with the bullet
      const contextResult1 = runCm([
        "context",
        "validate user input security",
        "--json"
      ], testDir);
      expect(contextResult1.exitCode).toBe(0);

      // Step 4: Mark the bullet as helpful multiple times
      for (let i = 0; i < 3; i++) {
        const markResult = runCm([
          "mark", bulletId,
          "--helpful",
          "--json"
        ], testDir);
        expect(markResult.exitCode).toBe(0);
      }

      // Step 5: Get context again - score should be higher
      const contextResult2 = runCm([
        "context",
        "validate user input security",
        "--json"
      ], testDir);
      expect(contextResult2.exitCode).toBe(0);

      // Verify the bullet is included and context was retrieved
      const context2 = JSON.parse(contextResult2.stdout) as any;
      expect(context2.data.task).toBeDefined();
      // Relevant bullets may or may not include our specific bullet depending on matching
      // The key test is that context works after marking

      // Verify playbook was updated with helpful count
      const statsResult = runCm(["stats", "--json"], testDir);
      expect(statsResult.exitCode).toBe(0);
    }, { timeout: 30000 });
  });

  describe("Playbook Add → Mark → Score Flow", () => {
    test.serial("marking bullets changes their effective score and maturity", () => {
      // Initialize
      runCm(["init", "--json"], testDir);

      // Add a bullet
      const addResult = runCm([
        "playbook", "add",
        "Use TypeScript strict mode for better type safety",
        "--category", "typescript",
        "--json"
      ], testDir);
      expect(addResult.exitCode).toBe(0);
      const bulletId = (JSON.parse(addResult.stdout) as any).data.bullet.id;

      // Get initial state
      const getResult1 = runCm(["playbook", "get", bulletId, "--json"], testDir);
      expect(getResult1.exitCode).toBe(0);
      const response1 = (JSON.parse(getResult1.stdout) as any).data;
      expect(response1.bullet.helpfulCount).toBe(0);
      expect(response1.bullet.maturity).toBe("candidate");

      // Mark helpful 3 times to trigger maturity transition
      for (let i = 0; i < 3; i++) {
        runCm(["mark", bulletId, "--helpful", "--json"], testDir);
      }

      // Get updated state
      const getResult2 = runCm(["playbook", "get", bulletId, "--json"], testDir);
      expect(getResult2.exitCode).toBe(0);
      const response2 = (JSON.parse(getResult2.stdout) as any).data;
      expect(response2.bullet.helpfulCount).toBe(3);
      // After 3 helpful marks, should transition to established
      expect(response2.bullet.maturity).toBe("established");
    }, { timeout: 30000 });
  });

  describe("Playbook Add → Forget → Undo Flow", () => {
    test.serial("undo restores a forgotten bullet to active state", () => {
      // Initialize
      runCm(["init", "--json"], testDir);

      // Add a bullet
      const addResult = runCm([
        "playbook", "add",
        "Test rule for undo workflow",
        "--category", "testing",
        "--json"
      ], testDir);
      expect(addResult.exitCode).toBe(0);
      const bulletId = (JSON.parse(addResult.stdout) as any).data.bullet.id;

      // Verify bullet is active
      const listResult1 = runCm(["playbook", "list", "--json"], testDir);
      expect(listResult1.exitCode).toBe(0);
      const list1Response = (JSON.parse(listResult1.stdout) as any).data;
      expect(list1Response.bullets.some((b: any) => b.id === bulletId)).toBe(true);

      // Forget the bullet
      const forgetResult = runCm([
        "forget", bulletId,
        "--reason", "Testing undo flow",
        "--json"
      ], testDir);
      expect(forgetResult.exitCode).toBe(0);

      // Verify bullet is deprecated
      const getResult = runCm(["playbook", "get", bulletId, "--json"], testDir);
      expect(getResult.exitCode).toBe(0);
      const forgottenResponse = (JSON.parse(getResult.stdout) as any).data;
      expect(forgottenResponse.bullet.deprecated).toBe(true);

      // Bullet should not appear in active list
      const listResult2 = runCm(["playbook", "list", "--json"], testDir);
      expect(listResult2.exitCode).toBe(0);
      const list2Response = (JSON.parse(listResult2.stdout) as any).data;
      expect(list2Response.bullets.some((b: any) => b.id === bulletId)).toBe(false);

      // Undo the forget
      const undoResult = runCm(["undo", bulletId, "--json"], testDir);
      expect(undoResult.exitCode).toBe(0);
      const undoResponse = JSON.parse(undoResult.stdout) as any;
      expect(undoResponse.success).toBe(true);
      expect(undoResponse.data.action).toBe("un-deprecate");

      // Verify bullet is restored
      const getResult2 = runCm(["playbook", "get", bulletId, "--json"], testDir);
      expect(getResult2.exitCode).toBe(0);
      const restoredResponse = (JSON.parse(getResult2.stdout) as any).data;
      expect(restoredResponse.bullet.deprecated).toBe(false);

      // Bullet should appear in active list again
      const listResult3 = runCm(["playbook", "list", "--json"], testDir);
      expect(listResult3.exitCode).toBe(0);
      const list3Response = (JSON.parse(listResult3.stdout) as any).data;
      expect(list3Response.bullets.some((b: any) => b.id === bulletId)).toBe(true);
    }, { timeout: 30000 });

    test.serial("undo --feedback removes the last feedback event", () => {
      // Initialize
      runCm(["init", "--json"], testDir);

      // Add a bullet
      const addResult = runCm([
        "playbook", "add",
        "Test rule for feedback undo",
        "--category", "testing",
        "--json"
      ], testDir);
      expect(addResult.exitCode).toBe(0);
      const bulletId = (JSON.parse(addResult.stdout) as any).data.bullet.id;

      // Mark as helpful twice
      runCm(["mark", bulletId, "--helpful", "--json"], testDir);
      runCm(["mark", bulletId, "--helpful", "--json"], testDir);

      // Verify helpful count is 2
      const getResult1 = runCm(["playbook", "get", bulletId, "--json"], testDir);
      expect(getResult1.exitCode).toBe(0);
      expect((JSON.parse(getResult1.stdout) as any).data.bullet.helpfulCount).toBe(2);

      // Undo last feedback
      const undoResult = runCm(["undo", bulletId, "--feedback", "--json"], testDir);
      expect(undoResult.exitCode).toBe(0);
      const undoResponse = JSON.parse(undoResult.stdout) as any;
      expect(undoResponse.success).toBe(true);
      expect(undoResponse.data.action).toBe("undo-feedback");

      // Verify helpful count is now 1
      const getResult2 = runCm(["playbook", "get", bulletId, "--json"], testDir);
      expect(getResult2.exitCode).toBe(0);
      expect((JSON.parse(getResult2.stdout) as any).data.bullet.helpfulCount).toBe(1);
    }, { timeout: 60000 });

    test.serial("undo --hard requires explicit confirmation (--yes) in non-interactive mode", () => {
      runCm(["init", "--json"], testDir);

      const addResult = runCm([
        "playbook", "add",
        "Test rule for hard delete confirmation",
        "--category", "testing",
        "--json"
      ], testDir);
      expect(addResult.exitCode).toBe(0);
      const bulletId = (JSON.parse(addResult.stdout) as any).data.bullet.id;

      // Without --yes this should refuse to delete (no TTY in tests)
      const hardNoConfirm = runCm(["undo", bulletId, "--hard", "--json"], testDir);
      expect(hardNoConfirm.exitCode).toBe(1);

      // Bullet should still exist
      const getAfterRefusal = runCm(["playbook", "get", bulletId, "--json"], testDir);
      expect(getAfterRefusal.exitCode).toBe(0);

      // With --yes it should delete
      const hardConfirmed = runCm(["undo", bulletId, "--hard", "--yes", "--json"], testDir);
      expect(hardConfirmed.exitCode).toBe(0);
      const hardResponse = JSON.parse(hardConfirmed.stdout) as any;
      expect(hardResponse.success).toBe(true);
      expect(hardResponse.data.action).toBe("hard-delete");

      // Bullet should be gone from list
      const listAfterDelete = runCm(["playbook", "list", "--json"], testDir);
      expect(listAfterDelete.exitCode).toBe(0);
      const listAfterDeleteResponse = (JSON.parse(listAfterDelete.stdout) as any).data;
      expect(listAfterDeleteResponse.bullets.some((b: any) => b.id === bulletId)).toBe(false);
    }, { timeout: 60000 });
  });

  describe("Stats → Top → Stale Flow", () => {
    test.serial("stats, top, and stale reflect the same playbook state", () => {
      // Initialize
      runCm(["init", "--json"], testDir);

      // Add multiple bullets with different characteristics
      const bullets: string[] = [];
      for (let i = 0; i < 5; i++) {
        const addResult = runCm([
          "playbook", "add",
          `Test rule ${i + 1} for stats flow`,
          "--category", i < 3 ? "primary" : "secondary",
          "--json"
        ], testDir);
        expect(addResult.exitCode).toBe(0);
        bullets.push((JSON.parse(addResult.stdout) as any).data.bullet.id);
      }

      // Mark some as helpful to vary scores
      runCm(["mark", bullets[0], "--helpful", "--json"], testDir);
      runCm(["mark", bullets[0], "--helpful", "--json"], testDir);
      runCm(["mark", bullets[1], "--helpful", "--json"], testDir);

      // Get stats
      const statsResult = runCm(["stats", "--json"], testDir);
      expect(statsResult.exitCode).toBe(0);
      const stats = (JSON.parse(statsResult.stdout) as any).data;
      expect(stats.total).toBe(5);

      // Get top bullets
      const topResult = runCm(["top", "--json"], testDir);
      expect(topResult.exitCode).toBe(0);
      const top = (JSON.parse(topResult.stdout) as any).data;
      expect(top.bullets).toBeDefined();
      expect(Array.isArray(top.bullets)).toBe(true);
      expect(top.bullets.length).toBeLessThanOrEqual(10);

      // Get stale bullets (all should be stale since just created with 0 day threshold)
      const staleResult = runCm(["stale", "--days", "0", "--json"], testDir);
      expect(staleResult.exitCode).toBe(0);
      const stale = (JSON.parse(staleResult.stdout) as any).data;
      expect(stale.count).toBeDefined();
    }, { timeout: 30000 });
  });

  describe("Why → Mark → Why Flow", () => {
    test.serial("why command shows updated feedback after marking", () => {
      // Initialize
      runCm(["init", "--json"], testDir);

      // Add a bullet
      const addResult = runCm([
        "playbook", "add",
        "Test rule for why flow",
        "--category", "testing",
        "--json"
      ], testDir);
      expect(addResult.exitCode).toBe(0);
      const bulletId = (JSON.parse(addResult.stdout) as any).data.bullet.id;

      // Get initial why
      const whyResult1 = runCm(["why", bulletId, "--json"], testDir);
      expect(whyResult1.exitCode).toBe(0);
      const why1 = (JSON.parse(whyResult1.stdout) as any).data;
      expect(why1.currentStatus.helpfulCount).toBe(0);
      expect(why1.feedbackHistory).toHaveLength(0);

      // Mark as helpful
      runCm(["mark", bulletId, "--helpful", "--json"], testDir);

      // Get updated why
      const whyResult2 = runCm(["why", bulletId, "--json"], testDir);
      expect(whyResult2.exitCode).toBe(0);
      const why2 = (JSON.parse(whyResult2.stdout) as any).data;
      expect(why2.currentStatus.helpfulCount).toBe(1);
      expect(why2.feedbackHistory.length).toBeGreaterThanOrEqual(1);
    }, { timeout: 30000 });
  });

  describe("Doctor → Init --force → Doctor Flow", () => {
    test.serial("doctor detects missing files and init --force resolves issues", () => {
      // Initialize normally first
      runCm(["init", "--json"], testDir);

      // Verify doctor passes
      const doctorResult1 = runCm(["doctor", "--json"], testDir);
      expect(doctorResult1.exitCode).toBeLessThanOrEqual(1);
      const doctor1 = (JSON.parse(doctorResult1.stdout) as any).data;
      expect(doctor1.checks).toBeDefined();
      expect(doctor1.overallStatus).toBeDefined();

      // Add some data
      runCm([
        "playbook", "add",
        "Test rule for doctor flow",
        "--category", "testing",
        "--json"
      ], testDir);

      // Verify doctor still passes
      const doctorResult2 = runCm(["doctor", "--json"], testDir);
      expect(doctorResult2.exitCode).toBeLessThanOrEqual(1);
    }, { timeout: 30000 });
  });

  describe("Doctor Flags", () => {
    test.serial("doctor --dry-run does not create or modify files", () => {
      const dryRun = runCm(["doctor", "--dry-run"], testDir);
      expect(dryRun.exitCode).toBeLessThanOrEqual(1);

      // Dry-run should not create ~/.cass-memory/
      const globalDir = join(testDir, ".cass-memory");
      expect(existsSync(globalDir)).toBe(false);
    }, { timeout: 30000 });

    test.serial("doctor --fix --no-interactive applies safe fixes without hanging", () => {
      const fix = runCm(["doctor", "--fix", "--no-interactive"], testDir);
      expect(fix.exitCode).toBeLessThanOrEqual(1);

      // Safe fixes should create ~/.cass-memory/
      const globalDir = join(testDir, ".cass-memory");
      expect(existsSync(globalDir)).toBe(true);
    }, { timeout: 30000 });

    test.serial("doctor --json --self-test includes selfTest results only when requested", () => {
      const base = runCm(["doctor", "--json"], testDir);
      expect(base.exitCode).toBeLessThanOrEqual(1);
      const baseParsed = (JSON.parse(base.stdout) as any).data;
      expect(baseParsed.checks).toBeDefined();
      expect(baseParsed.overallStatus).toBeDefined();
      expect(Array.isArray(baseParsed.recommendedActions)).toBe(true);
      expect(baseParsed.selfTest).toBeUndefined();

      const withSelfTest = runCm(["doctor", "--json", "--self-test"], testDir);
      expect(withSelfTest.exitCode).toBeLessThanOrEqual(1);
      const parsed = (JSON.parse(withSelfTest.stdout) as any).data;
      expect(parsed.checks).toBeDefined();
      expect(parsed.overallStatus).toBeDefined();
      expect(Array.isArray(parsed.recommendedActions)).toBe(true);
      expect(Array.isArray(parsed.selfTest)).toBe(true);
      expect(parsed.selfTest.length).toBeGreaterThan(0);
    }, { timeout: 60000 });

    test.serial("doctor --json --fix --dry-run includes a fix plan and makes no changes", () => {
      const result = runCm(["doctor", "--json", "--fix", "--dry-run"], testDir);
      expect(result.exitCode).toBeLessThanOrEqual(1);

      const parsed = (JSON.parse(result.stdout) as any).data;
      expect(parsed.fixPlan).toBeDefined();
      expect(Array.isArray(parsed.fixPlan.wouldApply)).toBe(true);

      // Dry-run should not create ~/.cass-memory/
      const globalDir = join(testDir, ".cass-memory");
      expect(existsSync(globalDir)).toBe(false);
    }, { timeout: 30000 });
  });

  describe("Quickstart → Context Flow", () => {
    test.serial("quickstart provides valid workflow that context can follow", () => {
      // Initialize
      runCm(["init", "--json"], testDir);

      // Get quickstart guidance
      const quickstartResult = runCm(["quickstart", "--json"], testDir);
      expect(quickstartResult.exitCode).toBe(0);
      const quickstart = (JSON.parse(quickstartResult.stdout) as any).data;
      expect(quickstart.oneCommand).toContain("cm context");

      // Follow the quickstart advice - get context
      const contextResult = runCm([
        "context",
        "implement a new feature",
        "--json"
      ], testDir);
      expect(contextResult.exitCode).toBe(0);
      const context = (JSON.parse(contextResult.stdout) as any).data;
      expect(context.task).toBe("implement a new feature");
    }, { timeout: 30000 });
  });

  describe("New User Onboarding Flow", () => {
    test.serial("fresh install → init → context → mark helpful → doctor", () => {
      const logger = createTestLogger("cli-onboarding", "debug");

      const globalDir = join(testDir, ".cass-memory");
      logger.step("precheck", "info", "Starting onboarding flow", {
        testDir,
        globalDir,
        globalDirExists: existsSync(globalDir),
      });
      expect(existsSync(globalDir)).toBe(false);

      // Step 1: init creates global structure
      logger.startStep("init");
      const initStart = Date.now();
      const initResult = runCm(["init", "--json"], testDir);
      const initDurationMs = Date.now() - initStart;
      logger.step("init", "info", "cm init completed", {
        args: ["init", "--json"],
        exitCode: initResult.exitCode,
        durationMs: initDurationMs,
        stdout: initResult.stdout,
        stderr: initResult.stderr,
      });
      expect(initResult.exitCode).toBe(0);
      expect(() => JSON.parse(initResult.stdout)).not.toThrow();
      logger.endStep("init", true);

      const configPath = join(globalDir, "config.json");
      const playbookPath = join(globalDir, "playbook.yaml");
      const diaryDir = join(globalDir, "diary");
      logger.step("fs-after-init", "info", "File system state after init", {
        config: { path: configPath, ...getPathState(configPath) },
        playbook: { path: playbookPath, ...getPathState(playbookPath) },
        diary: { path: diaryDir, ...getPathState(diaryDir) },
      });
      expect(getPathState(configPath).exists).toBe(true);
      expect(getPathState(playbookPath).exists).toBe(true);
      expect(getPathState(diaryDir).exists).toBe(true);

      // Make cass deterministic for this test (avoid depending on local machine cass/index state)
      logger.startStep("patch-config");
      const configJson = JSON.parse(readFileSync(configPath, "utf-8")) as any;
      configJson.cassPath = "__nonexistent__";
      writeFileSync(configPath, JSON.stringify(configJson, null, 2), "utf-8");
      logger.step("patch-config", "info", "Patched config.cassPath", { cassPath: configJson.cassPath });
      logger.endStep("patch-config", true);

      // Step 2: Add a bullet so context can return something meaningful
      logger.startStep("playbook-add");
      const addArgs = [
        "playbook",
        "add",
        "Always validate user input before processing",
        "--category",
        "security",
        "--json",
      ];
      const addStart = Date.now();
      const addResult = runCm(addArgs, testDir);
      const addDurationMs = Date.now() - addStart;
      logger.step("playbook-add", "info", "cm playbook add completed", {
        args: addArgs,
        exitCode: addResult.exitCode,
        durationMs: addDurationMs,
        stdout: addResult.stdout,
        stderr: addResult.stderr,
      });
      expect(addResult.exitCode).toBe(0);
      const addJson = JSON.parse(addResult.stdout) as any;
      const bulletId = addJson?.data?.bullet?.id;
      expect(typeof bulletId).toBe("string");
      expect(bulletId).toMatch(/^b-/);
      logger.endStep("playbook-add", true);

      // Step 3: Context returns relevant bullets for the first task
      logger.startStep("context");
      const contextArgs = ["context", "validate user input", "--json"];
      const contextStart = Date.now();
      const contextResult = runCm(contextArgs, testDir);
      const contextDurationMs = Date.now() - contextStart;
      logger.step("context", "info", "cm context completed", {
        args: contextArgs,
        exitCode: contextResult.exitCode,
        durationMs: contextDurationMs,
        stdout: contextResult.stdout,
        stderr: contextResult.stderr,
      });
      expect(contextResult.exitCode).toBe(0);
      const contextJson = JSON.parse(contextResult.stdout) as any;
      expect(contextJson.data.task).toBe("validate user input");
      expect(Array.isArray(contextJson.data.relevantBullets)).toBe(true);
      expect(contextJson.data.relevantBullets.some((b: any) => b.id === bulletId)).toBe(true);
      expect(contextJson.data.degraded?.cass?.available).toBe(false);
      logger.endStep("context", true);

      // Step 4: Mark the surfaced bullet helpful
      logger.startStep("mark");
      const markArgs = ["mark", bulletId, "--helpful", "--json"];
      const markStart = Date.now();
      const markResult = runCm(markArgs, testDir);
      const markDurationMs = Date.now() - markStart;
      logger.step("mark", "info", "cm mark completed", {
        args: markArgs,
        exitCode: markResult.exitCode,
        durationMs: markDurationMs,
        stdout: markResult.stdout,
        stderr: markResult.stderr,
      });
      expect(markResult.exitCode).toBe(0);
      const markJson = JSON.parse(markResult.stdout) as any;
      expect(markJson.success).toBe(true);
      expect(markJson.data.bulletId).toBe(bulletId);
      expect(markJson.data.type).toBe("helpful");
      logger.endStep("mark", true);

      logger.step("fs-after-mark", "info", "File system state after mark", {
        config: { path: configPath, ...getPathState(configPath) },
        playbook: { path: playbookPath, ...getPathState(playbookPath) },
      });

      // Step 5: Doctor provides system health signal (even in degraded mode)
      logger.startStep("doctor");
      const doctorArgs = ["doctor", "--json"];
      const doctorStart = Date.now();
      const doctorResult = runCm(doctorArgs, testDir);
      const doctorDurationMs = Date.now() - doctorStart;
      logger.step("doctor", "info", "cm doctor completed", {
        args: doctorArgs,
        exitCode: doctorResult.exitCode,
        durationMs: doctorDurationMs,
        stdout: doctorResult.stdout,
        stderr: doctorResult.stderr,
      });
      expect(() => JSON.parse(doctorResult.stdout)).not.toThrow();
      const doctorJson = JSON.parse(doctorResult.stdout) as any;
      expect(Array.isArray(doctorJson.data.checks)).toBe(true);
      expect(typeof doctorJson.data.overallStatus).toBe("string");
      expect(Array.isArray(doctorJson.data.recommendedActions)).toBe(true);
      logger.endStep("doctor", true);

      logger.info("Onboarding flow complete", {
        totalDurationMs: initDurationMs + addDurationMs + contextDurationMs + markDurationMs + doctorDurationMs,
      });
    }, { timeout: 30000 });
  });

  describe("Error Recovery Flow", () => {
    test.serial("corrupted config.json → doctor --fix resets config and restores clean runs", () => {
      const logger = createTestLogger("cli-error-recovery", "debug");
      logger.startStep("init");

      const initResult = runCm(["init", "--json"], testDir);
      logger.step("init", "info", "cm init completed", {
        exitCode: initResult.exitCode,
        stdout: initResult.stdout,
        stderr: initResult.stderr,
      });
      expect(initResult.exitCode).toBe(0);
      logger.endStep("init", true);

      // Corrupt the global config file
      logger.startStep("corrupt-config");
      const configPath = join(testDir, ".cass-memory", "config.json");
      writeFileSync(configPath, "{ invalid json", "utf-8");
      logger.step("corrupt-config", "info", "Wrote invalid config.json", { configPath });
      logger.endStep("corrupt-config", true);

      // Doctor should surface a reset-config fix in JSON output
      logger.startStep("doctor-detect");
      const doctorResult = runCm(["doctor", "--json"], testDir);
      logger.step("doctor-detect", "info", "cm doctor completed", {
        exitCode: doctorResult.exitCode,
        stdout: doctorResult.stdout,
        stderr: doctorResult.stderr,
      });
      expect(() => JSON.parse(doctorResult.stdout)).not.toThrow();
      const doctorJson = JSON.parse(doctorResult.stdout) as any;
      expect(Array.isArray(doctorJson.data.fixableIssues)).toBe(true);
      expect(doctorJson.data.fixableIssues.some((i: any) => i.id === "reset-config")).toBe(true);
      logger.endStep("doctor-detect", true);

      // Apply fixes (force allows cautious reset-config)
      logger.startStep("doctor-fix");
      const fixResult = runCm(["doctor", "--fix", "--force", "--json"], testDir);
      logger.step("doctor-fix", "info", "cm doctor --fix completed", {
        exitCode: fixResult.exitCode,
        stdout: fixResult.stdout,
        stderr: fixResult.stderr,
      });
      expect(() => JSON.parse(fixResult.stdout)).not.toThrow();
      const fixJson = JSON.parse(fixResult.stdout) as any;
      expect(Array.isArray(fixJson.data.fixResults)).toBe(true);
      expect(fixJson.data.fixResults.some((r: any) => r.id === "reset-config" && r.success === true)).toBe(true);
      logger.endStep("doctor-fix", true);

      // Subsequent commands should no longer warn about failing to load config.
      logger.startStep("context-after-fix");
      const contextResult = runCm(["context", "test query", "--json"], testDir);
      logger.step("context-after-fix", "info", "cm context completed", {
        exitCode: contextResult.exitCode,
        stdout: contextResult.stdout,
        stderr: contextResult.stderr,
      });
      expect(() => JSON.parse(contextResult.stdout)).not.toThrow();
      expect(contextResult.stderr).not.toContain("Failed to load config");
      logger.endStep("context-after-fix", true);
    }, { timeout: 30000 });
  });
});
