/**
 * Unit tests for `src/orchestrator.ts`.
 *
 * These tests run in-process (for Bun coverage) and avoid network/LLM calls by:
 * - Setting `CASS_MEMORY_LLM=none` (fast diary generation, no LLM)
 * - Using LLMIO injection to inject deterministic deltas (no env vars needed)
 * - Setting `config.validationEnabled=false` to bypass validator/evidence calls
 * - Pointing `config.cassPath` at a non-existent binary so `cassExport` uses fallback parsing
 */
import { describe, test, expect } from "bun:test";
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import yaml from "yaml";

import { orchestrateReflection } from "../src/orchestrator.js";
import { getProcessedLogPath, ProcessedLog } from "../src/tracking.js";
import { expandPath, now } from "../src/utils.js";
import { cleanupEnvironment, createIsolatedEnvironment, TestEnv } from "./helpers/temp.js";
import { createTestConfig, createTestPlaybook, createBullet } from "./helpers/factories.js";
import { withLlmShim, type LlmShimConfig } from "./helpers/llm-shim.js";

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

      await withEnv({ CASS_MEMORY_LLM: "none" }, async () => {
        await withLlmShim({
          reflector: {
            deltas: [{
              type: "add",
              bullet: { content: "Always add an in-process unit test before refactors.", category: "testing", tags: [] },
              reason: "Ensures coverage and prevents regressions",
              sourceSession: "stub",
            }]
          }
        }, async (io) => {
          const outcome = await orchestrateReflection(config, { session: sessionPath, io });

          expect(outcome.errors).toEqual([]);
          expect(outcome.sessionsProcessed).toBe(1);
          expect(outcome.deltasGenerated).toBe(1);

          const saved = readPlaybook(env.playbookPath);
          const contents = (saved?.bullets || []).map((b: any) => b.content);
          expect(contents).toContain("Always add an in-process unit test before refactors.");
        });
      });
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

      await withEnv({ CASS_MEMORY_LLM: "none" }, async () => {
        await withLlmShim({
          reflector: {
            deltas: [{
              type: "add",
              bullet: { content: "Dry-run delta should be returned, not persisted.", category: "testing", tags: [] },
              reason: "Dry-run behavior",
              sourceSession: "stub",
            }]
          }
        }, async (io) => {
          const outcome = await orchestrateReflection(config, { session: sessionPath, dryRun: true, io });

          expect(outcome.sessionsProcessed).toBe(1);
          expect(outcome.deltasGenerated).toBe(1);
          expect(outcome.dryRunDeltas?.length).toBe(1);

          const saved = readPlaybook(env.playbookPath);
          expect((saved?.bullets || []).length).toBe(0);
        });
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

      await withEnv({ CASS_MEMORY_LLM: "none" }, async () => {
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

      await withEnv({ CASS_MEMORY_LLM: "none" }, async () => {
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

      await withEnv({ CASS_MEMORY_LLM: "none" }, async () => {
        await withLlmShim({
          reflector: {
            deltas: [{
              type: "merge",
              bulletIds: [replacement.id, other.id],
              mergedContent: replacement.content,
              reason: "Duplicates",
            }]
          }
        }, async (io) => {
          const outcome = await orchestrateReflection(config, { session: sessionPath, io });
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

      await withEnv({ CASS_MEMORY_LLM: "none" }, async () => {
        await withLlmShim({
          reflector: {
            deltas: [{
              type: "add",
              bullet: { content: "Only one concurrent run should apply this rule.", category: "testing", tags: [] },
              reason: "Concurrency",
              sourceSession: "stub",
            }]
          }
        }, async (io) => {
          const [a, b] = await Promise.all([
            orchestrateReflection(config, { session: sessionPath, io }),
            orchestrateReflection(config, { session: sessionPath, io }),
          ]);

          expect(a.sessionsProcessed + b.sessionsProcessed).toBe(1);

          const saved = readPlaybook(env.playbookPath);
          const contents = (saved?.bullets || []).map((bullet: any) => bullet.content);
          expect(contents.filter((c: string) => c === "Only one concurrent run should apply this rule.").length).toBe(1);
        });
      });
    });
  });

  test("succeeds when reflections directory does not exist (issue #14)", async () => {
    // This test verifies the fix for GitHub issue #14:
    // "cm reflect fails with 'Could not acquire lock' when .orchestrator file doesn't exist"
    //
    // The bug occurred because withLock would fail on fresh installs where
    // ~/.cass-memory/reflections/ doesn't exist. The fix ensures the parent
    // directory is created before attempting lock acquisition.
    await withIsolatedHome(async (env) => {
      writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])), "utf-8");

      // Create a session but intentionally do NOT create the reflections directory
      // The orchestrator should create it automatically before lock acquisition
      const sessionPath = path.join(env.home, "sessions", "fresh-install.jsonl");
      writeJsonlSession(sessionPath, [
        { role: "user", content: "Fresh install test: verifying lock acquisition works without pre-existing reflections dir." },
        { role: "assistant", content: "The ensureDir call should create the directory before withLock is called." },
      ]);

      // Verify reflections directory does NOT exist (simulate fresh install)
      const reflectionsDir = path.join(env.home, ".cass-memory", "reflections");
      const { existsSync } = await import("node:fs");
      expect(existsSync(reflectionsDir)).toBe(false);

      const config = createTestConfig({
        playbookPath: env.playbookPath,
        diaryDir: env.diaryDir,
        cassPath: "/__missing__/cass",
        validationEnabled: false,
      });

      await withEnv({ CASS_MEMORY_LLM: "none" }, async () => {
        await withLlmShim({
          reflector: {
            deltas: [{
              type: "add",
              bullet: { content: "Rule from fresh install test.", category: "testing", tags: [] },
              reason: "Fresh install",
              sourceSession: "stub",
            }]
          }
        }, async (io) => {
          // This should NOT throw "Could not acquire lock" error
          const outcome = await orchestrateReflection(config, { session: sessionPath, io });

          expect(outcome.errors).toEqual([]);
          expect(outcome.sessionsProcessed).toBe(1);

          // Verify the reflections directory was created
          expect(existsSync(reflectionsDir)).toBe(true);
        });
      });
    });
  });
});

describe("orchestrateReflection playbook metadata counters (#72)", () => {
  const longSession = [
    { role: "user", content: "I need help writing reliable unit tests for my CLI tool, with fixtures." },
    { role: "assistant", content: "Sure. Let's start by identifying seams and adding deterministic fixtures." },
  ];

  const addDelta = (content: string) => ({
    reflector: {
      deltas: [{
        type: "add" as const,
        bullet: { content, category: "testing", tags: [] },
        reason: "Counter test",
        sourceSession: "stub",
      }]
    }
  });

  test("advance per committed run and never for an already-processed session", async () => {
    await withIsolatedHome(async (env) => {
      writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])), "utf-8");

      const s1 = path.join(env.home, "sessions", "s1.jsonl");
      const s2 = path.join(env.home, "sessions", "s2.jsonl");
      const short = path.join(env.home, "sessions", "short.jsonl");
      writeJsonlSession(s1, longSession);
      writeJsonlSession(s2, longSession);
      writeJsonlSession(short, [{ role: "user", content: "hi" }]);

      const config = createTestConfig({
        playbookPath: env.playbookPath,
        diaryDir: env.diaryDir,
        cassPath: "/__missing__/cass",
        validationEnabled: false,
      });

      await withEnv({ CASS_MEMORY_LLM: "none" }, async () => {
        // Run 1: one session, one delta.
        await withLlmShim(addDelta("Rule one from session one."), async (io) => {
          const outcome = await orchestrateReflection(config, { session: s1, io });
          expect(outcome.errors).toEqual([]);
          expect(outcome.sessionsProcessed).toBe(1);
        });
        let saved = readPlaybook(env.playbookPath);
        expect(saved.metadata.totalReflections).toBe(1);
        expect(saved.metadata.totalSessionsProcessed).toBe(1);
        expect(saved.metadata.lastReflection).toBeTruthy();

        // Run 2: a different session.
        await withLlmShim(addDelta("Rule two from session two."), async (io) => {
          const outcome = await orchestrateReflection(config, { session: s2, io });
          expect(outcome.errors).toEqual([]);
          expect(outcome.sessionsProcessed).toBe(1);
        });
        saved = readPlaybook(env.playbookPath);
        expect(saved.metadata.totalReflections).toBe(2);
        expect(saved.metadata.totalSessionsProcessed).toBe(2);

        // Run 3: re-running an already-processed session must not inflate anything.
        await withLlmShim(addDelta("Should never be reached."), async (io) => {
          const outcome = await orchestrateReflection(config, { session: s1, io });
          expect(outcome.sessionsProcessed).toBe(0);
        });
        saved = readPlaybook(env.playbookPath);
        expect(saved.metadata.totalReflections).toBe(2);
        expect(saved.metadata.totalSessionsProcessed).toBe(2);

        // Run 4: a short session is committed to the processed log with zero deltas,
        // so it still counts as a processed session and a completed run.
        const outcome = await orchestrateReflection(config, { session: short });
        expect(outcome.errors).toEqual([]);
        expect(outcome.deltasGenerated).toBe(0);
        saved = readPlaybook(env.playbookPath);
        expect(saved.metadata.totalReflections).toBe(3);
        expect(saved.metadata.totalSessionsProcessed).toBe(3);
        expect((saved.bullets || []).length).toBe(2);

        // Run 5: a dry run changes nothing.
        const s3 = path.join(env.home, "sessions", "s3.jsonl");
        writeJsonlSession(s3, longSession);
        await withLlmShim(addDelta("Dry-run rule."), async (io) => {
          await orchestrateReflection(config, { session: s3, dryRun: true, io });
        });
        saved = readPlaybook(env.playbookPath);
        expect(saved.metadata.totalReflections).toBe(3);
        expect(saved.metadata.totalSessionsProcessed).toBe(3);
      });
    });
  });

  test("do not advance when every session fails", async () => {
    await withIsolatedHome(async (env) => {
      writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])), "utf-8");

      const config = createTestConfig({
        playbookPath: env.playbookPath,
        diaryDir: env.diaryDir,
        cassPath: "/__missing__/cass",
        validationEnabled: false,
      });

      await withEnv({ CASS_MEMORY_LLM: "none" }, async () => {
        const missing = path.join(env.home, "sessions", "does-not-exist.jsonl");
        const outcome = await orchestrateReflection(config, { session: missing });
        expect(outcome.sessionsProcessed).toBe(0);
        expect(outcome.errors.length).toBeGreaterThan(0);
      });

      const saved = readPlaybook(env.playbookPath);
      expect(saved.metadata.totalReflections).toBe(0);
      expect(saved.metadata.totalSessionsProcessed).toBe(0);
    });
  });
});

describe("orchestrateReflection diary agent provenance (#73)", () => {
  test("records omp for a session under ~/.omp/agent/sessions", async () => {
    await withIsolatedHome(async (env) => {
      writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])), "utf-8");

      const sessionPath = path.join(env.home, ".omp", "agent", "sessions", "--repo--", "2026-09-01T10-00-00.jsonl");
      writeJsonlSession(sessionPath, [
        { role: "user", content: "Please fix the failing build in this repository for me today." },
        { role: "assistant", content: "Done. The build passes now and all tests are green." },
      ]);

      const config = createTestConfig({
        playbookPath: env.playbookPath,
        diaryDir: env.diaryDir,
        cassPath: "/__missing__/cass",
        validationEnabled: false,
      });

      await withEnv({ CASS_MEMORY_LLM: "none" }, async () => {
        const outcome = await orchestrateReflection(config, { session: sessionPath });
        expect(outcome.errors).toEqual([]);
        expect(outcome.sessionsProcessed).toBe(1);
      });

      const diaryFiles = readdirSync(env.diaryDir).filter((f) => f.endsWith(".json"));
      expect(diaryFiles.length).toBe(1);
      const diary = JSON.parse(readFileSync(path.join(env.diaryDir, diaryFiles[0]!), "utf-8"));
      expect(diary.agent).toBe("omp");
      expect(diary.sessionPath).toBe(sessionPath);
    });
  });
});
