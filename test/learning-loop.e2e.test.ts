/**
 * E2E Test: ACE Learning Loop - Accumulate → Curate → Extend Cycle
 *
 * Per bead cass_memory_system-37p9:
 * Validates that the system can:
 * 1) Reflect on a session (stubbed) and add learned bullets
 * 2) Surface learned bullets via `cm context`
 * 3) Accept feedback via `cm mark`
 * 4) Prune harmful bullets during a subsequent curation pass (triggered by another reflect)
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
  };
}

function patchCassPathToNonexistent(testDir: string): void {
  const configPath = join(testDir, ".cass-memory", "config.json");
  const raw = readFileSync(configPath, "utf-8");
  const json = JSON.parse(raw) as any;
  json.cassPath = "__nonexistent__";
  writeFileSync(configPath, JSON.stringify(json, null, 2), "utf-8");
}

describe("E2E: ACE Learning Loop", () => {
  let testDir: string;
  const logger = createTestLogger("learning-loop", "debug");

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "cass-learning-loop-"));
    logger.step("setup", "info", "Created isolated test directory", { testDir });
  });

  afterEach(() => {
    if (testDir && existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
      logger.step("teardown", "info", "Cleaned up isolated test directory", { testDir });
    }
  });

  test(
    "reflect → context → mark harmful → reflect → context prunes low-signal rule",
    () => {
      // Step 0: init
      logger.startStep("init");
      const initResult = runCm(["init", "--json"], testDir);
      logger.step("init", "info", "cm init completed", {
        exitCode: initResult.exitCode,
        stdout: initResult.stdout,
        stderr: initResult.stderr,
      });
      expect(initResult.exitCode).toBe(0);
      expect(() => JSON.parse(initResult.stdout)).not.toThrow();
      patchCassPathToNonexistent(testDir);
      logger.endStep("init", true);

      const cassMemoryDir = join(testDir, ".cass-memory");
      const diaryDir = join(cassMemoryDir, "diary");
      expect(existsSync(diaryDir)).toBe(true);

      // Step 1: create mock session A
      logger.startStep("session-a");
      const sessionsDir = join(testDir, "sessions");
      mkdirSync(sessionsDir, { recursive: true });
      const sessionAPath = join(sessionsDir, "session-a.jsonl");
      writeFileSync(
        sessionAPath,
        [
          JSON.stringify({ role: "user", content: "We keep missing Promise rejections in our code and tests." }),
          JSON.stringify({ role: "assistant", content: "We should add a rule about always handling Promise rejections." }),
        ].join("\n") + "\n",
        "utf-8"
      );
      logger.step("session-a", "info", "Wrote mock session A", { sessionAPath });
      logger.endStep("session-a", true);

      // Step 2: reflect session A (adds a bullet)
      logger.startStep("reflect-a");
      const ruleA = "Always handle Promise rejections (use try/catch or .catch) to avoid silent failures";
      const reflectA = runCm(["reflect", "--session", sessionAPath, "--json"], testDir, {
        CM_REFLECTOR_STUBS: JSON.stringify([
          {
            deltas: [
              {
                type: "add",
                bullet: { content: ruleA, category: "reliability" },
                reason: "Prevents unhandled rejections from causing flaky/hidden failures",
                sourceSession: sessionAPath,
              },
            ],
          },
        ]),
      });
      logger.step("reflect-a", "info", "cm reflect (A) completed", {
        exitCode: reflectA.exitCode,
        stdout: reflectA.stdout,
        stderr: reflectA.stderr,
      });
      expect(reflectA.exitCode).toBe(0);
      const reflectAJson = JSON.parse(reflectA.stdout) as any;
      expect(Array.isArray(reflectAJson.data.errors)).toBe(true);
      expect(reflectAJson.data.errors).toHaveLength(0);
      expect(reflectAJson.data.global?.applied ?? 0).toBeGreaterThanOrEqual(1);
      logger.endStep("reflect-a", true);

      // Verify diary entry saved (imported)
      logger.startStep("diary-after-a");
      const diaryFilesAfterA = readdirSync(diaryDir).filter((f) => f.endsWith(".json"));
      logger.step("diary-after-a", "info", "Diary files after reflect A", {
        diaryDir,
        count: diaryFilesAfterA.length,
        files: diaryFilesAfterA.slice(0, 5),
      });
      expect(diaryFilesAfterA.length).toBeGreaterThanOrEqual(1);
      logger.endStep("diary-after-a", true);

      // Step 3: find bullet id via playbook list
      logger.startStep("find-bullet-a");
      const listA = runCm(["playbook", "list", "--json"], testDir);
      logger.step("find-bullet-a", "info", "cm playbook list completed", {
        exitCode: listA.exitCode,
        stdout: listA.stdout,
        stderr: listA.stderr,
      });
      expect(listA.exitCode).toBe(0);
      const listAResponse = JSON.parse(listA.stdout) as any;
      const bulletA = listAResponse.data.bullets.find((b: any) => typeof b?.content === "string" && b.content.includes("Promise rejections"));
      expect(bulletA).toBeDefined();
      const bulletAId = bulletA.id as string;
      expect(bulletAId).toMatch(/^b-/);
      logger.step("find-bullet-a", "info", "Identified bullet A", { bulletAId, content: bulletA.content });
      logger.endStep("find-bullet-a", true);

      // Step 4: context surfaces learned bullet
      logger.startStep("context-a");
      const contextA = runCm(["context", "Promise error handling", "--json"], testDir);
      logger.step("context-a", "info", "cm context (A) completed", {
        exitCode: contextA.exitCode,
        stdout: contextA.stdout,
        stderr: contextA.stderr,
      });
      expect(contextA.exitCode).toBe(0);
      const contextAJson = JSON.parse(contextA.stdout) as any;
      expect(Array.isArray(contextAJson.data.relevantBullets)).toBe(true);
      expect(contextAJson.data.relevantBullets.some((b: any) => b.id === bulletAId)).toBe(true);
      logger.endStep("context-a", true);

      // Step 5: mark bullet harmful (but not enough to auto-deprecate via maturity threshold)
      logger.startStep("mark-harmful");
      for (let i = 0; i < 2; i++) {
        const mark = runCm(["mark", bulletAId, "--harmful", "--json"], testDir);
        logger.step("mark-harmful", "info", "cm mark --harmful completed", {
          index: i + 1,
          exitCode: mark.exitCode,
          stdout: mark.stdout,
          stderr: mark.stderr,
        });
        expect(mark.exitCode).toBe(0);
      }

      const getAfterMarks = runCm(["playbook", "get", bulletAId, "--json"], testDir);
      expect(getAfterMarks.exitCode).toBe(0);
      const bulletAfterMarks = (JSON.parse(getAfterMarks.stdout) as any).data.bullet as any;
      expect(bulletAfterMarks.harmfulCount).toBeGreaterThanOrEqual(2);
      expect(bulletAfterMarks.deprecated).toBe(false);
      logger.step("mark-harmful", "info", "Verified harmfulCount after marks", {
        bulletAId,
        harmfulCount: bulletAfterMarks.harmfulCount,
        helpfulCount: bulletAfterMarks.helpfulCount,
      });
      logger.endStep("mark-harmful", true);

      // Step 6: create mock session B and reflect to trigger a new curation pass
      logger.startStep("reflect-b");
      const sessionBPath = join(sessionsDir, "session-b.jsonl");
      writeFileSync(
        sessionBPath,
        [
          JSON.stringify({ role: "user", content: "We also need guidance on caching expensive computations." }),
          JSON.stringify({ role: "assistant", content: "Add a rule to prefer memoization or caching in hot paths." }),
        ].join("\n") + "\n",
        "utf-8"
      );

      const ruleB = "Cache expensive computations in hot paths (memoize or persist) to reduce repeated work";
      const reflectB = runCm(["reflect", "--session", sessionBPath, "--json"], testDir, {
        CM_REFLECTOR_STUBS: JSON.stringify([
          {
            deltas: [
              {
                type: "add",
                bullet: { content: ruleB, category: "performance" },
                reason: "Reduces redundant work and improves latency in hot paths",
                sourceSession: sessionBPath,
              },
            ],
          },
        ]),
      });
      logger.step("reflect-b", "info", "cm reflect (B) completed", {
        exitCode: reflectB.exitCode,
        stdout: reflectB.stdout,
        stderr: reflectB.stderr,
      });
      expect(reflectB.exitCode).toBe(0);
      const reflectBJson = JSON.parse(reflectB.stdout) as any;
      expect(Array.isArray(reflectBJson.data.errors)).toBe(true);
      expect(reflectBJson.data.errors).toHaveLength(0);
      logger.endStep("reflect-b", true);

      // Verify bullet A is now deprecated (inverted or auto-pruned)
      logger.startStep("verify-prune");
      const getAfterCurate = runCm(["playbook", "get", bulletAId, "--json"], testDir);
      logger.step("verify-prune", "info", "cm playbook get (after curate) completed", {
        exitCode: getAfterCurate.exitCode,
        stdout: getAfterCurate.stdout,
        stderr: getAfterCurate.stderr,
      });
      expect(getAfterCurate.exitCode).toBe(0);
      const bulletAfterCurate = (JSON.parse(getAfterCurate.stdout) as any).data.bullet as any;
      expect(bulletAfterCurate.deprecated).toBe(true);
      expect(typeof bulletAfterCurate.deprecationReason).toBe("string");
      expect(bulletAfterCurate.deprecationReason).toContain("Auto-deprecated");
      logger.step("verify-prune", "info", "Bullet A deprecated after curation pass", {
        bulletAId,
        deprecationReason: bulletAfterCurate.deprecationReason,
        replacedBy: bulletAfterCurate.replacedBy,
      });

      // Step 7: context no longer shows the deprecated rule
      const contextAfter = runCm(["context", "Promise error handling", "--json"], testDir);
      logger.step("verify-prune", "info", "cm context (after) completed", {
        exitCode: contextAfter.exitCode,
        stdout: contextAfter.stdout,
        stderr: contextAfter.stderr,
      });
      expect(contextAfter.exitCode).toBe(0);
      const contextAfterJson = JSON.parse(contextAfter.stdout) as any;
      expect(Array.isArray(contextAfterJson.data.relevantBullets)).toBe(true);
      expect(contextAfterJson.data.relevantBullets.some((b: any) => b.id === bulletAId)).toBe(false);
      expect(Array.isArray(contextAfterJson.data.antiPatterns)).toBe(true);

      logger.endStep("verify-prune", true);
    },
    { timeout: 60000 }
  );
});
