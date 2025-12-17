/**
 * E2E Test: Performance - Large Scale Operations
 *
 * Per bead cass_memory_system-su8w:
 * - Exercise context scoring on a large playbook (1000 bullets)
 * - Exercise parallel context queries (10) against the same large playbook
 * - Exercise diary scanning behavior with many diary entries (100)
 *
 * Notes:
 * - Thresholds are intentionally generous to avoid flakiness across machines.
 * - We force cass offline (`config.cassPath="__nonexistent__"`) for deterministic behavior.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createTestLogger } from "./helpers/logger.js";
import { createEmptyPlaybook, savePlaybook } from "../src/playbook.js";
import { createTestDiary } from "./helpers/factories.js";
import { generateBulletId, now } from "../src/utils.js";

const CM_PATH = join(import.meta.dir, "..", "src", "cm.ts");

interface CmResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

function runCmSync(args: string[], cwd: string, env: Record<string, string> = {}): CmResult {
  const start = Date.now();
  const result = spawnSync("bun", ["run", CM_PATH, ...args], {
    cwd,
    env: {
      ...process.env,
      CASS_MEMORY_LLM: "none",
      HOME: cwd,
      NO_COLOR: "1",
      FORCE_COLOR: "0",
      ...env,
    },
    encoding: "utf-8",
    timeout: 60000,
  });

  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    exitCode: result.status ?? 1,
    durationMs: Date.now() - start,
  };
}

function runCmAsync(args: string[], cwd: string, env: Record<string, string> = {}): Promise<CmResult> {
  const start = Date.now();
  return new Promise((resolve) => {
    const proc = spawn("bun", ["run", CM_PATH, ...args], {
      cwd,
      env: {
        ...process.env,
        CASS_MEMORY_LLM: "none",
        HOME: cwd,
        NO_COLOR: "1",
        FORCE_COLOR: "0",
        ...env,
      },
      timeout: 60000,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    proc.on("close", (code) => {
      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: code ?? 1,
        durationMs: Date.now() - start,
      });
    });

    proc.on("error", (err) => {
      resolve({
        stdout: "",
        stderr: err.message,
        exitCode: 1,
        durationMs: Date.now() - start,
      });
    });
  });
}

function patchCassPathToNonexistent(testDir: string): void {
  const configPath = join(testDir, ".cass-memory", "config.json");
  const raw = readFileSync(configPath, "utf-8");
  const json = JSON.parse(raw) as any;
  json.cassPath = "__nonexistent__";
  writeFileSync(configPath, JSON.stringify(json, null, 2), "utf-8");
}

describe("E2E: Performance (Large Scale)", () => {
  let testDir: string;
  const logger = createTestLogger("performance", "debug");

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "cass-perf-"));
    logger.step("setup", "info", "Created isolated test directory", { testDir });
  });

  afterEach(() => {
    if (testDir && existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
      logger.step("teardown", "info", "Cleaned up isolated test directory", { testDir });
    }
  });

  test.serial("handles 1000 bullets + 10 parallel context queries", async () => {
    // Step 0: init
    logger.startStep("init");
    const init = runCmSync(["init", "--json"], testDir);
    logger.step("init", "info", "cm init completed", {
      exitCode: init.exitCode,
      durationMs: init.durationMs,
      stdout: init.stdout,
      stderr: init.stderr,
    });
    expect(init.exitCode).toBe(0);
    patchCassPathToNonexistent(testDir);
    logger.endStep("init", true);

    const cassMemoryDir = join(testDir, ".cass-memory");
    const playbookPath = join(cassMemoryDir, "playbook.yaml");
    const diaryDir = join(cassMemoryDir, "diary");
    expect(existsSync(diaryDir)).toBe(true);

    // Step 1: generate + save large playbook
    logger.startStep("generate-playbook");
    const playbook = createEmptyPlaybook("perf");
    const ts = now();

    for (let i = 0; i < 1000; i++) {
      const hot = i % 10 === 0;
      playbook.bullets.push({
        id: generateBulletId(),
        category: hot ? "typescript" : "general",
        content: hot
          ? `TypeScript error handling: always check errors and handle failures (case ${i})`
          : `General workflow rule ${i}: keep changes small and reviewable`,
        createdAt: ts,
        updatedAt: ts,
      } as any);
    }

    const startSave = Date.now();
    await savePlaybook(playbook, playbookPath);
    const saveDurationMs = Date.now() - startSave;
    const playbookBytes = statSync(playbookPath).size;

    logger.step("generate-playbook", "info", "Saved playbook.yaml", {
      bullets: playbook.bullets.length,
      saveDurationMs,
      playbookBytes,
    });
    logger.endStep("generate-playbook", true);

    // Step 2: single context query timing
    logger.startStep("context-single");
    const single = runCmSync(["context", "typescript error handling", "--json"], testDir);
    logger.step("context-single", "info", "cm context (single) completed", {
      exitCode: single.exitCode,
      durationMs: single.durationMs,
      stdout: single.stdout,
      stderr: single.stderr,
    });
    expect(single.exitCode).toBe(0);
    expect(single.durationMs).toBeLessThan(15000);

    const singleJson = JSON.parse(single.stdout) as any;
    expect(Array.isArray(singleJson.data.relevantBullets)).toBe(true);
    expect(singleJson.data.relevantBullets.length).toBeGreaterThan(0);
    logger.endStep("context-single", true);

    // Step 3: 10 parallel context queries
    logger.startStep("context-parallel");
    const parallelStart = Date.now();
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        runCmAsync(["context", `typescript error handling ${i}`, "--json"], testDir)
      )
    );
    const parallelDurationMs = Date.now() - parallelStart;

    const failures = results.filter((r) => r.exitCode !== 0);
    if (failures.length > 0) {
      logger.step("context-parallel", "error", "Some parallel context queries failed", {
        failures: failures.map((f) => ({ exitCode: f.exitCode, stderr: f.stderr.slice(0, 200) })),
      });
    }

    expect(failures).toHaveLength(0);
    logger.step("context-parallel", "info", "Parallel context timings", {
      parallelDurationMs,
      perQueryMs: results.map((r) => r.durationMs),
      avgMs: results.reduce((sum, r) => sum + r.durationMs, 0) / results.length,
    });

    expect(parallelDurationMs).toBeLessThan(60000);
    logger.endStep("context-parallel", true);

    // Step 4: many diaries + why timing (diary scan behavior)
    logger.startStep("why-with-diaries");
    mkdirSync(diaryDir, { recursive: true });
    for (let i = 0; i < 100; i++) {
      const diary = createTestDiary({
        sessionPath: join(testDir, "sessions", `perf-session-${i}.jsonl`),
        timestamp: new Date(Date.now() - i * 60_000).toISOString(), // spaced 1 min apart
      });
      writeFileSync(join(diaryDir, `${diary.id}.json`), JSON.stringify(diary, null, 2), "utf-8");
    }

    const targetBulletId = playbook.bullets[0]?.id;
    expect(typeof targetBulletId).toBe("string");

    const why = runCmSync(["why", targetBulletId, "--json"], testDir);
    logger.step("why-with-diaries", "info", "cm why completed", {
      exitCode: why.exitCode,
      durationMs: why.durationMs,
      stdout: why.stdout,
      stderr: why.stderr,
    });
    expect(why.exitCode).toBe(0);
    expect(why.durationMs).toBeLessThan(15000);
    expect(() => JSON.parse(why.stdout)).not.toThrow();
    logger.endStep("why-with-diaries", true);
  }, { timeout: 120000 });
});
