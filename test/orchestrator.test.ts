/**
 * Unit tests for `src/orchestrator.ts`.
 *
 * These tests run in-process (for Bun coverage) and avoid network/LLM calls by:
 * - Setting `CASS_MEMORY_LLM=none` (fast diary generation, no LLM)
 * - Using `CM_REFLECTOR_STUBS` to inject deterministic deltas (no LLM)
 * - Setting `config.validationEnabled=false` to bypass validator/evidence calls
 * - Pointing `config.cassPath` at a non-existent binary so `cassExport` uses fallback parsing
 */
import { describe, test, expect } from "bun:test";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import yaml from "yaml";

import { orchestrateReflection } from "../src/orchestrator.js";
import { getProcessedLogPath, ProcessedLog } from "../src/tracking.js";
import { expandPath, now } from "../src/utils.js";
import { cleanupEnvironment, createIsolatedEnvironment, TestEnv } from "./helpers/temp.js";
import { createTestConfig, createTestPlaybook, createBullet } from "./helpers/factories.js";

async function withEnv<T>(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<T> | T
): Promise<T> {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function withIsolatedHome<T>(fn: (env: TestEnv) => Promise<T>): Promise<T> {
  const env = await createIsolatedEnvironment("orchestrator-test");
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const originalCwd = process.cwd();

  try {
    process.env.HOME = env.home;
    process.env.USERPROFILE = env.home;
    process.chdir(env.home); // ensure resolveRepoDir() returns null (avoid touching repo .cass/)
    return await fn(env);
  } finally {
    process.env.HOME = originalHome;
    process.env.USERPROFILE = originalUserProfile;
    process.chdir(originalCwd);
    await cleanupEnvironment(env);
  }
}

function writeJsonlSession(sessionPath: string, lines: Array<{ role: string; content: string }>): void {
  mkdirSync(path.dirname(sessionPath), { recursive: true });
  const body = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  writeFileSync(sessionPath, body, "utf-8");
}

function readPlaybook(playbookPath: string): any {
  return yaml.parse(readFileSync(playbookPath, "utf-8"));
}

function setReflectorStubs(deltas: any[]): void {
  process.env.CM_REFLECTOR_STUBS = JSON.stringify([{ deltas }]);
}

describe("orchestrateReflection (unit)", () => {
  test("processes a single session and persists add delta to global playbook", async () => {
    await withIsolatedHome(async (env) => {
      writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])), "utf-8");

      const sessionPath = path.join(env.home, "sessions", "s1.jsonl");
      writeJsonlSession(sessionPath, [
        { role: "user", content: "I need help writing reliable unit tests for my CLI tool." },
        { role: "assistant", content: "Sure. Let's start by identifying seams and adding deterministic fixtures." },
      ]);

      const config = createTestConfig({
        playbookPath: env.playbookPath,
        diaryDir: env.diaryDir,
        cassPath: "/__missing__/cass",
        validationEnabled: false,
      });

      await withEnv(
        {
          CASS_MEMORY_LLM: "none",
          CM_REFLECTOR_STUBS: undefined,
        },
        async () => {
          setReflectorStubs([
            {
              type: "add",
              bullet: { content: "Always add an in-process unit test before refactors.", category: "testing", tags: [] },
              reason: "Ensures coverage and prevents regressions",
              sourceSession: "stub",
            },
          ]);

          const outcome = await orchestrateReflection(config, { session: sessionPath });

          expect(outcome.errors).toEqual([]);
          expect(outcome.sessionsProcessed).toBe(1);
          expect(outcome.deltasGenerated).toBe(1);

          const saved = readPlaybook(env.playbookPath);
          const contents = (saved?.bullets || []).map((b: any) => b.content);
          expect(contents).toContain("Always add an in-process unit test before refactors.");
        }
      );
    });
  });

  test("dryRun returns deltas but does not modify the playbook", async () => {
    await withIsolatedHome(async (env) => {
      writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])), "utf-8");

      const sessionPath = path.join(env.home, "sessions", "s1.jsonl");
      writeJsonlSession(sessionPath, [
        { role: "user", content: "This session has enough content to exceed the short-session threshold." },
        { role: "assistant", content: "Adding more content so the text export is long enough for processing." },
      ]);

      const config = createTestConfig({
        playbookPath: env.playbookPath,
        diaryDir: env.diaryDir,
        cassPath: "/__missing__/cass",
        validationEnabled: false,
      });

      await withEnv({ CASS_MEMORY_LLM: "none", CM_REFLECTOR_STUBS: undefined }, async () => {
        setReflectorStubs([
          {
            type: "add",
            bullet: { content: "Dry-run delta should be returned, not persisted.", category: "testing", tags: [] },
            reason: "Dry-run behavior",
            sourceSession: "stub",
          },
        ]);

        const outcome = await orchestrateReflection(config, { session: sessionPath, dryRun: true });

        expect(outcome.sessionsProcessed).toBe(1);
        expect(outcome.deltasGenerated).toBe(1);
        expect(outcome.dryRunDeltas?.length).toBe(1);

        const saved = readPlaybook(env.playbookPath);
        expect((saved?.bullets || []).length).toBe(0);
      });
    });
  });

  test("skips short sessions and marks them processed with 0 deltas", async () => {
    await withIsolatedHome(async (env) => {
      writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])), "utf-8");

      const sessionPath = path.join(env.home, "sessions", "short.jsonl");
      writeJsonlSession(sessionPath, [{ role: "user", content: "hi" }]);

      const config = createTestConfig({
        playbookPath: env.playbookPath,
        diaryDir: env.diaryDir,
        cassPath: "/__missing__/cass",
        validationEnabled: false,
      });

      await withEnv({ CASS_MEMORY_LLM: "none", CM_REFLECTOR_STUBS: undefined }, async () => {
        const outcome = await orchestrateReflection(config, { session: sessionPath });

        expect(outcome.errors).toEqual([]);
        expect(outcome.sessionsProcessed).toBe(0);
        expect(outcome.deltasGenerated).toBe(0);

        const logPath = expandPath(getProcessedLogPath());
        const content = readFileSync(logPath, "utf-8");
        expect(content).toContain(sessionPath);
      });
    });
  });

  test("returns early when session is already processed", async () => {
    await withIsolatedHome(async (env) => {
      writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])), "utf-8");

      const sessionPath = path.join(env.home, "sessions", "s1.jsonl");
      writeJsonlSession(sessionPath, [
        { role: "user", content: "Long enough content to pass the short-session threshold (already processed)." },
        { role: "assistant", content: "More content." },
      ]);

      const processedLog = new ProcessedLog(expandPath(getProcessedLogPath()));
      await processedLog.append({
        sessionPath,
        processedAt: now(),
        diaryId: "diary-xyz",
        deltasGenerated: 0,
      });

      const config = createTestConfig({
        playbookPath: env.playbookPath,
        diaryDir: env.diaryDir,
        cassPath: "/__missing__/cass",
        validationEnabled: false,
      });

      await withEnv({ CASS_MEMORY_LLM: "none", CM_REFLECTOR_STUBS: undefined }, async () => {
        const outcome = await orchestrateReflection(config, { session: sessionPath });
        expect(outcome.sessionsProcessed).toBe(0);
        expect(outcome.deltasGenerated).toBe(0);
      });
    });
  });

  test("merge deltas deprecate into an existing active replacement (no new bullet)", async () => {
    await withIsolatedHome(async (env) => {
      const replacement = createBullet({ content: "Merged rule content", category: "merged", state: "active" });
      const other = createBullet({ content: "Older duplicate content", category: "general", state: "active" });

      writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([replacement, other])), "utf-8");

      const sessionPath = path.join(env.home, "sessions", "s1.jsonl");
      writeJsonlSession(sessionPath, [
        { role: "user", content: "Merge these duplicate rules into a single canonical rule." },
        { role: "assistant", content: "We'll merge and deprecate the duplicates." },
      ]);

      const config = createTestConfig({
        playbookPath: env.playbookPath,
        diaryDir: env.diaryDir,
        cassPath: "/__missing__/cass",
        validationEnabled: false,
        dedupSimilarityThreshold: 0.85,
      });

      await withEnv({ CASS_MEMORY_LLM: "none", CM_REFLECTOR_STUBS: undefined }, async () => {
        setReflectorStubs([
          {
            type: "merge",
            bulletIds: [replacement.id, other.id],
            mergedContent: replacement.content,
            reason: "Duplicates",
          },
        ]);

        const outcome = await orchestrateReflection(config, { session: sessionPath });
        expect(outcome.errors).toEqual([]);

        const saved = readPlaybook(env.playbookPath);
        const bullets = saved?.bullets || [];
        expect(bullets.length).toBe(2);

        const savedOther = bullets.find((b: any) => b.id === other.id);
        expect(savedOther).toBeTruthy();
        expect(savedOther.deprecated).toBe(true);
        expect(savedOther.replacedBy).toBe(replacement.id);

        const savedReplacement = bullets.find((b: any) => b.id === replacement.id);
        expect(savedReplacement).toBeTruthy();
        expect(savedReplacement.deprecated).toBe(false);
      });
    });
  });

  test("serializes concurrent reflections for the same workspace log", async () => {
    await withIsolatedHome(async (env) => {
      writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])), "utf-8");

      const sessionPath = path.join(env.home, "sessions", "s1.jsonl");
      writeJsonlSession(sessionPath, [
        { role: "user", content: "Concurrent run test: this content should be long enough to avoid skipping." },
        { role: "assistant", content: "More content to ensure length threshold is passed." },
      ]);

      const config = createTestConfig({
        playbookPath: env.playbookPath,
        diaryDir: env.diaryDir,
        cassPath: "/__missing__/cass",
        validationEnabled: false,
      });

      await withEnv({ CASS_MEMORY_LLM: "none", CM_REFLECTOR_STUBS: undefined }, async () => {
        setReflectorStubs([
          {
            type: "add",
            bullet: { content: "Only one concurrent run should apply this rule.", category: "testing", tags: [] },
            reason: "Concurrency",
            sourceSession: "stub",
          },
        ]);

        const [a, b] = await Promise.all([
          orchestrateReflection(config, { session: sessionPath }),
          orchestrateReflection(config, { session: sessionPath }),
        ]);

        expect(a.sessionsProcessed + b.sessionsProcessed).toBe(1);

        const saved = readPlaybook(env.playbookPath);
        const contents = (saved?.bullets || []).map((bullet: any) => bullet.content);
        expect(contents.filter((c: string) => c === "Only one concurrent run should apply this rule.").length).toBe(1);
      });
    });
  });
});
