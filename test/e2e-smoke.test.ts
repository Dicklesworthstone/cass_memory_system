/**
 * E2E Smoke Test - CLI Workflow
 *
 * Tests the basic CLI workflow: init -> context -> mark -> playbook
 * Runs with LLM/cass disabled to verify offline/degraded path.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const CM_PATH = join(import.meta.dir, "..", "src", "cm.ts");

function runCm(args: string[], cwd: string, env: Record<string, string> = {}): {
  stdout: string;
  stderr: string;
  exitCode: number;
} {
  const result = spawnSync("bun", ["run", CM_PATH, ...args], {
    cwd,
    env: {
      ...process.env,
      CASS_MEMORY_LLM: "none",  // Disable LLM
      HOME: cwd,  // Isolate from real home
      ...env
    },
    encoding: "utf-8",
    timeout: 30000
  });

  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    exitCode: result.status ?? 1
  };
}

describe("E2E CLI Smoke Test", () => {
  let testDir: string;

  beforeAll(() => {
    testDir = mkdtempSync(join(tmpdir(), "cass-e2e-"));
  });

  afterAll(() => {
    if (testDir && existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  test("cm --help shows available commands", () => {
    const result = runCm(["--help"], testDir);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: cm");
    expect(result.stdout).toContain("context");
    expect(result.stdout).toContain("playbook");
    expect(result.stdout).toContain("init");
  });

  test("cm init creates config and playbook", () => {
    const result = runCm(["init", "--json"], testDir);

    // Should succeed or warn about existing
    expect(result.exitCode).toBeLessThanOrEqual(1);

    // Stdout must always be parseable JSON in --json mode
    const payload = JSON.parse(result.stdout);
    expect(typeof payload).toBe("object");
    expect(typeof payload.success).toBe("boolean");

    // Check files created
    const cassMemoryDir = join(testDir, ".cass-memory");
    expect(existsSync(cassMemoryDir) || result.stdout.includes("initialized")).toBe(true);
  });

  test("cm playbook list shows playbook (empty or with bullets)", () => {
    const result = runCm(["playbook", "list", "--json"], testDir);

    expect(result.exitCode).toBe(0);

    // Should return valid JSON object with bullets array
    const listResponse = JSON.parse(result.stdout);
    expect(listResponse.success).toBe(true);
    expect(Array.isArray(listResponse.data?.bullets)).toBe(true);
  });

  test("cm playbook add creates a bullet", () => {
    const result = runCm([
      "playbook", "add",
      "Test rule for smoke testing",
      "--category", "testing",
      "--json"
    ], testDir);

    expect(result.exitCode).toBe(0);

    const response = JSON.parse(result.stdout);
    expect(response.success).toBe(true);
    expect(response.data?.bullet).toBeDefined();
    expect(response.data?.bullet?.id).toMatch(/^b-/);
  });

  test("cm context returns context (degraded without cass)", () => {
    const result = runCm([
      "context",
      "test task for smoke testing",
      "--json"
    ], testDir);

    // May succeed with empty results or warn about missing cass
    expect(result.exitCode).toBeLessThanOrEqual(1);

    const context = JSON.parse(result.stdout);
    expect(context.data?.task).toBe("test task for smoke testing");
    expect(Array.isArray(context.data?.relevantBullets)).toBe(true);
  });

  test("cm stats returns playbook statistics", () => {
    const result = runCm(["stats", "--json"], testDir);

    expect(result.exitCode).toBe(0);

    const stats = JSON.parse(result.stdout);
    expect(stats.data?.total).toBeGreaterThanOrEqual(0);
    expect(stats.data?.byScope).toBeDefined();
    expect(stats.data?.scoreDistribution).toBeDefined();
  });

  test("cm doctor checks system health", () => {
    const result = runCm(["doctor", "--json"], testDir);

    expect(result.exitCode).toBeLessThanOrEqual(1);

    const health = JSON.parse(result.stdout);
    expect(Array.isArray(health.data?.checks)).toBe(true);
    expect(typeof health.data?.overallStatus).toBe("string");
    expect(Array.isArray(health.data?.recommendedActions)).toBe(true);
  });

  test("cm top shows effective bullets", () => {
    const result = runCm(["top", "--json"], testDir);

    expect(result.exitCode).toBe(0);

    const top = JSON.parse(result.stdout);
    expect(top.data?.bullets).toBeDefined();
    expect(Array.isArray(top.data?.bullets)).toBe(true);
  });

  test("cm stale finds stale bullets", () => {
    const result = runCm(["stale", "--json", "--days", "0"], testDir);

    expect(result.exitCode).toBe(0);

    const stale = JSON.parse(result.stdout);
    expect(stale.data?.threshold).toBe(0);
    expect(Array.isArray(stale.data?.bullets)).toBe(true);
  });

  test("cm quickstart shows agent documentation", () => {
    const result = runCm(["quickstart", "--json"], testDir);

    expect(result.exitCode).toBe(0);

    const quickstart = JSON.parse(result.stdout);
    expect(quickstart.data?.oneCommand).toContain("cm context");
    expect(quickstart.data?.protocol).toBeDefined();
  });

  test("cm usage shows LLM cost tracking", () => {
    const result = runCm(["usage", "--json"], testDir);

    expect(result.exitCode).toBe(0);

    const usage = JSON.parse(result.stdout);
    expect(typeof usage.data?.today).toBe("number");
    expect(typeof usage.data?.dailyLimit).toBe("number");
  });

  test("cm project --output refuses to overwrite without --force", () => {
    // Ensure baseline init exists (idempotent)
    runCm(["init", "--json"], testDir);

    const outPath = join(testDir, "project-export.md");
    const first = runCm(["project", "--output", outPath], testDir);
    expect(first.exitCode).toBe(0);
    expect(existsSync(outPath)).toBe(true);

    const second = runCm(["project", "--output", outPath], testDir);
    expect(second.exitCode).toBe(1);
    expect(second.stderr).toContain("--force");

    const third = runCm(["project", "--output", outPath, "--force"], testDir);
    expect(third.exitCode).toBe(0);
  });

  test("cm similar returns parseable JSON (and errors are JSON too)", () => {
    const ok = runCm(["similar", "smoke test query", "--json"], testDir);
    expect(ok.exitCode).toBe(0);
    expect(() => JSON.parse(ok.stdout)).not.toThrow();

    const bad = runCm(["similar", "smoke test query", "--threshold", "2", "--json"], testDir);
    expect(bad.exitCode).toBe(1);
    const err = JSON.parse(bad.stdout);
    expect(typeof err.error?.message).toBe("string");
  });

  test("cm undo handles non-existent bullet gracefully", () => {
    const result = runCm(["undo", "b-nonexistent", "--json"], testDir);

    // Should fail with exit code 1
    expect(result.exitCode).toBe(1);

    const response = JSON.parse(result.stdout);
    expect(response.error?.message).toContain("not found");
  });

  test("cm undo --feedback fails when no feedback to undo", () => {
    // First add a bullet
    const addResult = runCm([
      "playbook", "add",
      "Test rule for undo testing",
      "--category", "testing",
      "--json"
    ], testDir);
    expect(addResult.exitCode).toBe(0);
    const bullet = JSON.parse(addResult.stdout).data?.bullet;

    // Try to undo feedback when there's none
    const result = runCm(["undo", bullet.id, "--feedback", "--json"], testDir);

    // Should fail with exit code 1
    expect(result.exitCode).toBe(1);

    const response = JSON.parse(result.stdout);
    // Updated to match structured error format from CLI handler
    const errorMessage = response.error.message || response.error;
    expect(errorMessage).toContain("No feedback events to undo");
  });
});
