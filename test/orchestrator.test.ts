/**
 * Unit tests for `src/orchestrator.ts`.
 *
 * These tests run in-process (for Bun coverage) and avoid network/LLM calls by:
 * - Setting `CASS_MEMORY_LLM=none` (fast diary generation, no LLM)
 * - Using LLMIO injection to inject deterministic deltas (no env vars needed)
 * - Setting `config.validationEnabled=false` to bypass validator/evidence calls
 * - Pointing `config.cassPath` at a non-existent binary so `cassExport` uses fallback parsing
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import yaml from "yaml";

import { orchestrateReflection } from "../src/orchestrator.js";
import { tagCmSubprocessPrompt } from "../src/subprocess-tag.js";
import { getProcessedLogPath, ProcessedLog } from "../src/tracking.js";
import { expandPath, now } from "../src/utils.js";
import { createBullet, createTestConfig, createTestPlaybook } from "./helpers/factories.js";
import { type LlmShimConfig, withLlmShim } from "./helpers/llm-shim.js";
import { cleanupEnvironment, createIsolatedEnvironment, type TestEnv } from "./helpers/temp.js";

async function withEnv<T>(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<T> | T,
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

function writeJsonlSession(
  sessionPath: string,
  lines: Array<{ role: string; content: string }>,
): void {
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
        {
          role: "assistant",
          content: "Sure. Let's start by identifying seams and adding deterministic fixtures.",
        },
      ]);

      const config = createTestConfig({
        playbookPath: env.playbookPath,
        diaryDir: env.diaryDir,
        cassPath: "/__missing__/cass",
        validationEnabled: false,
      });

      await withEnv({ CASS_MEMORY_LLM: "none" }, async () => {
        await withLlmShim(
          {
            reflector: {
              deltas: [
                {
                  type: "add",
                  bullet: {
                    content: "Always add an in-process unit test before refactors.",
                    category: "testing",
                    tags: [],
                  },
                  reason: "Ensures coverage and prevents regressions",
                  sourceSession: "stub",
                },
              ],
            },
          },
          async (io) => {
            const outcome = await orchestrateReflection(config, { session: sessionPath, io });

            expect(outcome.errors).toEqual([]);
            expect(outcome.sessionsProcessed).toBe(1);
            expect(outcome.deltasGenerated).toBe(1);

            const saved = readPlaybook(env.playbookPath);
            const contents = (saved?.bullets || []).map((b: any) => b.content);
            expect(contents).toContain("Always add an in-process unit test before refactors.");
          },
        );
      });
    });
  });

  test("dryRun returns deltas but does not modify the playbook", async () => {
    await withIsolatedHome(async (env) => {
      writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])), "utf-8");

      const sessionPath = path.join(env.home, "sessions", "s1.jsonl");
      writeJsonlSession(sessionPath, [
        {
          role: "user",
          content: "This session has enough content to exceed the short-session threshold.",
        },
        {
          role: "assistant",
          content: "Adding more content so the text export is long enough for processing.",
        },
      ]);

      const config = createTestConfig({
        playbookPath: env.playbookPath,
        diaryDir: env.diaryDir,
        cassPath: "/__missing__/cass",
        validationEnabled: false,
      });

      await withEnv({ CASS_MEMORY_LLM: "none" }, async () => {
        await withLlmShim(
          {
            reflector: {
              deltas: [
                {
                  type: "add",
                  bullet: {
                    content: "Dry-run delta should be returned, not persisted.",
                    category: "testing",
                    tags: [],
                  },
                  reason: "Dry-run behavior",
                  sourceSession: "stub",
                },
              ],
            },
          },
          async (io) => {
            const outcome = await orchestrateReflection(config, {
              session: sessionPath,
              dryRun: true,
              io,
            });

            expect(outcome.sessionsProcessed).toBe(1);
            expect(outcome.deltasGenerated).toBe(1);
            expect(outcome.dryRunDeltas?.length).toBe(1);

            const saved = readPlaybook(env.playbookPath);
            expect((saved?.bullets || []).length).toBe(0);
          },
        );
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

        // #85: the too-short check runs before diary generation, so an empty
        // session never costs a diary (an LLM call outside CASS_MEMORY_LLM=none).
        let diaries: string[] = [];
        try {
          diaries = readdirSync(env.diaryDir).filter((f) => f.endsWith(".json"));
        } catch {
          diaries = [];
        }
        expect(diaries).toEqual([]);
      });
    });
  });

  test("#76 skips a transcript of cm's own LLM subprocess call and marks it processed", async () => {
    await withIsolatedHome(async (env) => {
      writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])), "utf-8");

      // A recording of one of cm's own `claude -p` calls: the piped prompt is
      // stored verbatim, so it carries the payload marker cm wraps it in.
      const sessionPath = path.join(env.home, "sessions", "cm-own-call.jsonl");
      writeJsonlSession(sessionPath, [
        {
          role: "user",
          content: tagCmSubprocessPrompt(
            "You are a reflector. Existing playbook:\n- b-aaa111 always run the linter\n" +
              "- b-bbb222 prefer explicit imports\nEmit deltas as JSON.",
          ),
        },
        { role: "assistant", content: '{"deltas":[]}' },
      ]);

      const config = createTestConfig({
        playbookPath: env.playbookPath,
        diaryDir: env.diaryDir,
        cassPath: "/__missing__/cass",
        validationEnabled: false,
      });

      await withEnv({ CASS_MEMORY_LLM: "none" }, async () => {
        const skips: string[] = [];
        const outcome = await orchestrateReflection(config, {
          session: sessionPath,
          onProgress: (e) => {
            if (e.phase === "session_skip") skips.push(e.reason);
          },
        });

        expect(outcome.errors).toEqual([]);
        expect(outcome.sessionsProcessed).toBe(0);
        expect(outcome.deltasGenerated).toBe(0);
        // No rule ids scraped from cm's own prompt → no auto-graded outcomes.
        expect(outcome.autoOutcome).toBeUndefined();
        expect(skips).toEqual(["Transcript of cm's own LLM subprocess call"]);

        // Marked processed so it can never consume the discovery budget again.
        const logContent = readFileSync(expandPath(getProcessedLogPath()), "utf-8");
        expect(logContent).toContain(sessionPath);
      });
    });
  });

  test("#76 an ordinary session beside cm's own transcripts is still reflected on and still graded", async () => {
    // Guards the other half of the fix: excluding cm's own calls must not cost
    // real sessions their reflection or their auto-recorded outcomes.
    await withIsolatedHome(async (env) => {
      writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])), "utf-8");

      const sessionPath = path.join(env.home, "sessions", "real-work.jsonl");
      writeJsonlSession(sessionPath, [
        {
          role: "user",
          content:
            "Following b-ccc333 I refactored the exporter, then debugged why reflect grades everything.",
        },
        {
          role: "assistant",
          content: "Applied the rule, the refactor is done and the whole suite is green now.",
        },
      ]);

      const config = createTestConfig({
        playbookPath: env.playbookPath,
        diaryDir: env.diaryDir,
        cassPath: "/__missing__/cass",
        validationEnabled: false,
      });

      await withEnv({ CASS_MEMORY_LLM: "none" }, async () => {
        await withLlmShim({ reflector: { deltas: [] } }, async (io) => {
          const outcome = await orchestrateReflection(config, { session: sessionPath, io });

          expect(outcome.errors).toEqual([]);
          expect(outcome.sessionsProcessed).toBe(1);
          expect(outcome.autoOutcome?.outcomesRecorded ?? 0).toBeGreaterThan(0);

          const outcomeLog = readFileSync(
            path.join(env.home, ".cass-memory", "outcomes.jsonl"),
            "utf-8",
          );
          expect(outcomeLog).toContain("b-ccc333");
        });
      });
    });
  });

  test("returns early when session is already processed", async () => {
    await withIsolatedHome(async (env) => {
      writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])), "utf-8");

      const sessionPath = path.join(env.home, "sessions", "s1.jsonl");
      writeJsonlSession(sessionPath, [
        {
          role: "user",
          content: "Long enough content to pass the short-session threshold (already processed).",
        },
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
      const replacement = createBullet({
        content: "Merged rule content",
        category: "merged",
        state: "active",
      });
      const other = createBullet({
        content: "Older duplicate content",
        category: "general",
        state: "active",
      });

      writeFileSync(
        env.playbookPath,
        yaml.stringify(createTestPlaybook([replacement, other])),
        "utf-8",
      );

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
        await withLlmShim(
          {
            reflector: {
              deltas: [
                {
                  type: "merge",
                  bulletIds: [replacement.id, other.id],
                  mergedContent: replacement.content,
                  reason: "Duplicates",
                },
              ],
            },
          },
          async (io) => {
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
          },
        );
      });
    });
  });

  test("serializes concurrent reflections for the same workspace log", async () => {
    await withIsolatedHome(async (env) => {
      writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])), "utf-8");

      const sessionPath = path.join(env.home, "sessions", "s1.jsonl");
      writeJsonlSession(sessionPath, [
        {
          role: "user",
          content: "Concurrent run test: this content should be long enough to avoid skipping.",
        },
        { role: "assistant", content: "More content to ensure length threshold is passed." },
      ]);

      const config = createTestConfig({
        playbookPath: env.playbookPath,
        diaryDir: env.diaryDir,
        cassPath: "/__missing__/cass",
        validationEnabled: false,
      });

      await withEnv({ CASS_MEMORY_LLM: "none" }, async () => {
        await withLlmShim(
          {
            reflector: {
              deltas: [
                {
                  type: "add",
                  bullet: {
                    content: "Only one concurrent run should apply this rule.",
                    category: "testing",
                    tags: [],
                  },
                  reason: "Concurrency",
                  sourceSession: "stub",
                },
              ],
            },
          },
          async (io) => {
            const [a, b] = await Promise.all([
              orchestrateReflection(config, { session: sessionPath, io }),
              orchestrateReflection(config, { session: sessionPath, io }),
            ]);

            expect(a.sessionsProcessed + b.sessionsProcessed).toBe(1);

            const saved = readPlaybook(env.playbookPath);
            const contents = (saved?.bullets || []).map((bullet: any) => bullet.content);
            expect(
              contents.filter(
                (c: string) => c === "Only one concurrent run should apply this rule.",
              ).length,
            ).toBe(1);
          },
        );
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
        {
          role: "user",
          content:
            "Fresh install test: verifying lock acquisition works without pre-existing reflections dir.",
        },
        {
          role: "assistant",
          content: "The ensureDir call should create the directory before withLock is called.",
        },
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
        await withLlmShim(
          {
            reflector: {
              deltas: [
                {
                  type: "add",
                  bullet: {
                    content: "Rule from fresh install test.",
                    category: "testing",
                    tags: [],
                  },
                  reason: "Fresh install",
                  sourceSession: "stub",
                },
              ],
            },
          },
          async (io) => {
            // This should NOT throw "Could not acquire lock" error
            const outcome = await orchestrateReflection(config, { session: sessionPath, io });

            expect(outcome.errors).toEqual([]);
            expect(outcome.sessionsProcessed).toBe(1);

            // Verify the reflections directory was created
            expect(existsSync(reflectionsDir)).toBe(true);
          },
        );
      });
    });
  });
});

describe("orchestrateReflection playbook metadata counters (#72)", () => {
  const longSession = [
    {
      role: "user",
      content: "I need help writing reliable unit tests for my CLI tool, with fixtures.",
    },
    {
      role: "assistant",
      content: "Sure. Let's start by identifying seams and adding deterministic fixtures.",
    },
  ];

  const addDelta = (content: string) => ({
    reflector: {
      deltas: [
        {
          type: "add" as const,
          bullet: { content, category: "testing", tags: [] },
          reason: "Counter test",
          sourceSession: "stub",
        },
      ],
    },
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

      const sessionPath = path.join(
        env.home,
        ".omp",
        "agent",
        "sessions",
        "--repo--",
        "2026-09-01T10-00-00.jsonl",
      );
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

      // A reflector that fails outright no longer counts as "processed"
      // (#78), so give this provenance test a reflector that succeeds with
      // nothing to say.
      await withEnv({ CASS_MEMORY_LLM: "none" }, async () => {
        await withLlmShim({ reflector: { deltas: [] } }, async (io) => {
          const outcome = await orchestrateReflection(config, { session: sessionPath, io });
          expect(outcome.errors).toEqual([]);
          expect(outcome.sessionsProcessed).toBe(1);
        });
      });

      const diaryFiles = readdirSync(env.diaryDir).filter((f) => f.endsWith(".json"));
      expect(diaryFiles.length).toBe(1);
      const diary = JSON.parse(readFileSync(path.join(env.diaryDir, diaryFiles[0]!), "utf-8"));
      expect(diary.agent).toBe("omp");
      expect(diary.sessionPath).toBe(sessionPath);
    });
  });
});

describe("orchestrateReflection reflector failures (#78)", () => {
  test("a session whose reflector failed is reported and left unprocessed for retry", async () => {
    await withIsolatedHome(async (env) => {
      writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])), "utf-8");

      const sessionPath = path.join(env.home, "sessions", "reflector-fails.jsonl");
      writeJsonlSession(sessionPath, [
        { role: "user", content: "I need help writing reliable unit tests for my CLI tool." },
        {
          role: "assistant",
          content: "Sure. Let's start by identifying seams and adding deterministic fixtures.",
        },
      ]);

      const config = createTestConfig({
        playbookPath: env.playbookPath,
        diaryDir: env.diaryDir,
        cassPath: "/__missing__/cass",
        validationEnabled: false,
      });

      await withEnv({ CASS_MEMORY_LLM: "none" }, async () => {
        await withLlmShim(
          { errors: { reflector: new Error("runReflector timed out after 30000ms") } },
          async (io) => {
            const outcome = await orchestrateReflection(config, { session: sessionPath, io });

            expect(outcome.sessionsProcessed).toBe(0);
            expect(outcome.deltasGenerated).toBe(0);
            expect(outcome.errors).toHaveLength(1);
            expect(outcome.errors[0]).toContain(sessionPath);
            expect(outcome.errors[0]).toContain("Reflector failed");

            // Not processed; the failure is recorded for bounded retry (#85).
            const log = new ProcessedLog(expandPath(getProcessedLogPath()));
            await log.load();
            expect(log.has(sessionPath)).toBe(false);
            expect(log.getProcessedPaths().has(sessionPath)).toBe(false);
            expect(log.get(sessionPath)).toMatchObject({ status: "failed", failures: 1 });
          },
        );
      });
    });
  });
});

// ---------------------------------------------------------------------------
// #85: incremental re-reflection of grown sessions, bounded retry, --force
// #81: project-scoped rules from the session's workspace
// ---------------------------------------------------------------------------

function appendJsonl(sessionPath: string, lines: Array<Record<string, unknown>>): void {
  const existing = readFileSync(sessionPath, "utf-8");
  writeFileSync(sessionPath, existing + lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

function feedbackDeltas(deltas: any[] | undefined): string[] {
  return (deltas || [])
    .filter((d) => d.type === "helpful" || d.type === "harmful")
    .map((d) => `${d.type}:${d.bulletId}`)
    .sort();
}

describe("orchestrateReflection incremental sessions (#85)", () => {
  test("a grown session reflects only the new turns; earlier feedback is not counted again", async () => {
    await withIsolatedHome(async (env) => {
      writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])), "utf-8");
      const sessionPath = path.join(env.home, "sessions", "grows.jsonl");
      writeJsonlSession(sessionPath, [
        { role: "user", content: "OLDTURN please refactor the parser module carefully." },
        {
          role: "assistant",
          content: "Done. // [cass: helpful b-old1] - followed the parser rule",
        },
      ]);
      const config = createTestConfig({
        playbookPath: env.playbookPath,
        diaryDir: env.diaryDir,
        cassPath: "/__missing__/cass",
        validationEnabled: false,
      });

      const prompts: string[] = [];
      await withEnv({ CASS_MEMORY_LLM: "none" }, async () => {
        await withLlmShim(
          {
            reflector: (prompt: string) => {
              prompts.push(prompt);
              return { deltas: [] };
            },
          },
          async (io) => {
            const first = await orchestrateReflection(config, { session: sessionPath, io });
            expect(first.errors).toEqual([]);
            expect(first.sessionsProcessed).toBe(1);

            const log = new ProcessedLog(expandPath(getProcessedLogPath()));
            await log.load();
            expect(log.get(sessionPath)?.recordCount).toBe(2);

            // Nothing new: an explicit re-run is a no-op.
            const again = await orchestrateReflection(config, {
              session: sessionPath,
              io,
              dryRun: true,
            });
            expect(again.sessionsProcessed).toBe(0);
            expect(again.deltasGenerated).toBe(0);

            appendJsonl(sessionPath, [
              { role: "user", content: "NEWTURN now add tests for the tokenizer edge cases." },
              {
                role: "assistant",
                content: "Added. // [cass: harmful b-new1] - rule was outdated here",
              },
            ]);

            prompts.length = 0;
            const second = await orchestrateReflection(config, {
              session: sessionPath,
              io,
              dryRun: true,
            });
            expect(second.errors).toEqual([]);
            expect(second.sessionsProcessed).toBe(1);
            // Only the new turn's inline feedback; b-old1 is not re-counted.
            expect(feedbackDeltas(second.dryRunDeltas)).toEqual(["harmful:b-new1"]);
            expect(prompts.length).toBeGreaterThan(0);
            expect(prompts.join("\n")).not.toContain("OLDTURN");

            // Committed for real, the watermark advances to the new end.
            const committed = await orchestrateReflection(config, { session: sessionPath, io });
            expect(committed.sessionsProcessed).toBe(1);
            const log2 = new ProcessedLog(expandPath(getProcessedLogPath()));
            await log2.load();
            expect(log2.get(sessionPath)?.recordCount).toBe(4);
          },
        );
      });
    });
  });

  test("a rewritten transcript is not re-reflected (no double counting)", async () => {
    await withIsolatedHome(async (env) => {
      writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])), "utf-8");
      const sessionPath = path.join(env.home, "sessions", "rewritten.jsonl");
      writeJsonlSession(sessionPath, [
        { role: "user", content: "First version of this session with enough content to reflect." },
        { role: "assistant", content: "// [cass: helpful b-old1] - fine" },
      ]);
      const config = createTestConfig({
        playbookPath: env.playbookPath,
        diaryDir: env.diaryDir,
        cassPath: "/__missing__/cass",
        validationEnabled: false,
      });
      await withEnv({ CASS_MEMORY_LLM: "none" }, async () => {
        await withLlmShim({ reflector: { deltas: [] } }, async (io) => {
          await orchestrateReflection(config, { session: sessionPath, io });
          writeJsonlSession(sessionPath, [
            { role: "user", content: "Completely different history after a compaction rewrite." },
            { role: "assistant", content: "// [cass: helpful b-old1] - fine" },
            { role: "user", content: "and one more turn" },
          ]);
          const outcome = await orchestrateReflection(config, {
            session: sessionPath,
            io,
            dryRun: true,
          });
          expect(outcome.sessionsProcessed).toBe(0);
          expect(feedbackDeltas(outcome.dryRunDeltas)).toEqual([]);
        });
      });
    });
  });

  test("--force re-reflects the whole transcript but grades only turns not graded before", async () => {
    await withIsolatedHome(async (env) => {
      writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])), "utf-8");
      const sessionPath = path.join(env.home, "sessions", "forced.jsonl");
      writeJsonlSession(sessionPath, [
        { role: "user", content: "OLDTURN a long enough request to be worth reflecting on." },
        { role: "assistant", content: "// [cass: helpful b-old1] - fine" },
      ]);
      const config = createTestConfig({
        playbookPath: env.playbookPath,
        diaryDir: env.diaryDir,
        cassPath: "/__missing__/cass",
        validationEnabled: false,
      });
      await withEnv({ CASS_MEMORY_LLM: "none" }, async () => {
        await withLlmShim(
          { reflector: { deltas: [{ type: "helpful", bulletId: "b-fromreflector" }] } },
          async (io) => {
            await orchestrateReflection(config, { session: sessionPath, io });
            const forced = await orchestrateReflection(config, {
              session: sessionPath,
              io,
              force: true,
              dryRun: true,
            });
            expect(forced.sessionsProcessed).toBe(1);
            // Neither the old inline feedback nor reflector feedback is re-counted.
            expect(feedbackDeltas(forced.dryRunDeltas)).toEqual([]);
          },
        );
      });
    });
  });

  test("failures are recorded and counted; a success clears them", async () => {
    await withIsolatedHome(async (env) => {
      writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])), "utf-8");
      const sessionPath = path.join(env.home, "sessions", "flaky.jsonl");
      writeJsonlSession(sessionPath, [
        { role: "user", content: "A session long enough to reach the reflector call path." },
        { role: "assistant", content: "Some answer text." },
      ]);
      const config = createTestConfig({
        playbookPath: env.playbookPath,
        diaryDir: env.diaryDir,
        cassPath: "/__missing__/cass",
        validationEnabled: false,
      });
      const readEntry = async () => {
        const log = new ProcessedLog(expandPath(getProcessedLogPath()));
        await log.load();
        return log.get(sessionPath);
      };
      await withEnv({ CASS_MEMORY_LLM: "none" }, async () => {
        await withLlmShim({ errors: { reflector: new Error("provider down") } }, async (io) => {
          await orchestrateReflection(config, { session: sessionPath, io });
          await orchestrateReflection(config, { session: sessionPath, io });
        });
        expect(await readEntry()).toMatchObject({ status: "failed", failures: 2 });
        expect((await readEntry())?.lastError).toContain("provider down");

        await withLlmShim({ reflector: { deltas: [] } }, async (io) => {
          const ok = await orchestrateReflection(config, { session: sessionPath, io });
          expect(ok.sessionsProcessed).toBe(1);
        });
        const entry = await readEntry();
        expect(entry?.status).toBeUndefined();
        expect(entry?.failures).toBeUndefined();
        expect(entry?.recordCount).toBe(2);
      });
    });
  });
});

describe("orchestrateReflection --force on a legacy entry (#85)", () => {
  test("a failed forced pass does not turn a processed legacy session into a retry", async () => {
    await withIsolatedHome(async (env) => {
      writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])), "utf-8");
      const sessionPath = path.join(env.home, "sessions", "legacy.jsonl");
      writeJsonlSession(sessionPath, [
        { role: "user", content: "Legacy session content long enough to reach the reflector." },
        { role: "assistant", content: "// [cass: helpful b-old1] - fine" },
      ]);
      const logPath = expandPath(getProcessedLogPath());
      await new ProcessedLog(logPath).append({ sessionPath, processedAt: now(), deltasGenerated: 0 });
      const config = createTestConfig({
        playbookPath: env.playbookPath,
        diaryDir: env.diaryDir,
        cassPath: "/__missing__/cass",
        validationEnabled: false,
      });
      await withEnv({ CASS_MEMORY_LLM: "none" }, async () => {
        await withLlmShim({ errors: { reflector: new Error("provider down") } }, async (io) => {
          const outcome = await orchestrateReflection(config, {
            session: sessionPath,
            io,
            force: true,
          });
          expect(outcome.errors).toHaveLength(1);
        });
      });
      const log = new ProcessedLog(logPath);
      await log.load();
      expect(log.has(sessionPath)).toBe(true);
      expect(log.get(sessionPath)?.status).toBeUndefined();
    });
  });
});

describe("orchestrateReflection project-scoped rules (#81)", () => {
  function makeGitRepo(dir: string): string {
    mkdirSync(path.join(dir, ".git"), { recursive: true });
    return realpathSync(dir);
  }

  test("workspace-scoped adds are pinned to the session's project root", async () => {
    await withIsolatedHome(async (env) => {
      writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])), "utf-8");
      const repo = makeGitRepo(path.join(env.home, "proj"));
      mkdirSync(path.join(repo, "pkg"), { recursive: true });
      const sessionPath = path.join(env.home, "sessions", "proj.jsonl");
      writeJsonlSession(sessionPath, [
        { role: "user", content: "Run the migrations for this project please, all of them." },
        { role: "assistant", content: "Ran make db-migrate successfully." },
      ]);
      // Claude Code stamps the session cwd on each record.
      writeFileSync(
        sessionPath,
        readFileSync(sessionPath, "utf-8")
          .trim()
          .split("\n")
          .map((l) => JSON.stringify({ ...JSON.parse(l), cwd: path.join(repo, "pkg") }))
          .join("\n") + "\n",
      );
      const config = createTestConfig({
        playbookPath: env.playbookPath,
        diaryDir: env.diaryDir,
        cassPath: "/__missing__/cass",
        validationEnabled: false,
        projectRuleRouting: "scoped",
      });
      const prompts: string[] = [];
      await withEnv({ CASS_MEMORY_LLM: "none" }, async () => {
        await withLlmShim(
          {
            reflector: (prompt: string) => {
              prompts.push(prompt);
              return {
                deltas: [
                  {
                    type: "add",
                    bullet: {
                      content: "Run database migrations with make db-migrate.",
                      category: "workflow",
                      scope: "workspace",
                    },
                  } as any,
                  {
                    type: "add",
                    bullet: {
                      content: "Prefer small focused commits in any repository.",
                      category: "git",
                    },
                  } as any,
                ],
              };
            },
          },
          async (io) => {
            const outcome = await orchestrateReflection(config, { session: sessionPath, io });
            expect(outcome.errors).toEqual([]);
          },
        );
      });
      expect(prompts.join("\n")).toContain(`This session ran in the project at ${path.join(repo, "pkg")}`);
      const saved = readPlaybook(env.playbookPath);
      const migrate = saved.bullets.find((b: any) => b.content.includes("db-migrate"));
      expect(migrate.scope).toBe("workspace");
      expect(migrate.workspace).toBe(repo);
      const commits = saved.bullets.find((b: any) => b.content.includes("focused commits"));
      expect(commits.scope).toBe("global");
      expect(commits.workspace).toBeUndefined();
    });
  });

  test('"repo" routing writes project rules to the project\'s .cass/playbook.yaml', async () => {
    await withIsolatedHome(async (env) => {
      writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])), "utf-8");
      const repo = makeGitRepo(path.join(env.home, "proj"));
      mkdirSync(path.join(repo, ".cass"), { recursive: true });
      const sessionPath = path.join(env.home, "sessions", "proj.jsonl");
      mkdirSync(path.dirname(sessionPath), { recursive: true });
      writeFileSync(
        sessionPath,
        [
          { role: "user", content: "Run the migrations for this project please.", cwd: repo },
          { role: "assistant", content: "Ran make db-migrate successfully.", cwd: repo },
        ]
          .map((l) => JSON.stringify(l))
          .join("\n") + "\n",
      );
      const config = createTestConfig({
        playbookPath: env.playbookPath,
        diaryDir: env.diaryDir,
        cassPath: "/__missing__/cass",
        validationEnabled: false,
        projectRuleRouting: "repo",
      });
      await withEnv({ CASS_MEMORY_LLM: "none" }, async () => {
        await withLlmShim(
          {
            reflector: {
              deltas: [
                {
                  type: "add",
                  bullet: {
                    content: "Run database migrations with make db-migrate.",
                    category: "workflow",
                    scope: "workspace",
                  },
                } as any,
              ],
            },
          },
          async (io) => {
            const outcome = await orchestrateReflection(config, { session: sessionPath, io });
            expect(outcome.errors).toEqual([]);
            expect(outcome.projectResults?.[0]?.playbookPath).toBe(
              path.join(repo, ".cass", "playbook.yaml"),
            );
          },
        );
      });
      const globalSaved = readPlaybook(env.playbookPath);
      expect((globalSaved.bullets || []).some((b: any) => b.content.includes("db-migrate"))).toBe(
        false,
      );
      const repoSaved = readPlaybook(path.join(repo, ".cass", "playbook.yaml"));
      const rule = repoSaved.bullets.find((b: any) => b.content.includes("db-migrate"));
      expect(rule.scope).toBe("workspace");
      expect(rule.workspace).toBeUndefined();
    });
  });

  test("a workspace-scoped add with no known project stays visible as a global rule", async () => {
    await withIsolatedHome(async (env) => {
      writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])), "utf-8");
      const sessionPath = path.join(env.home, "sessions", "nocwd.jsonl");
      writeJsonlSession(sessionPath, [
        { role: "user", content: "A session without any recorded working directory at all." },
        { role: "assistant", content: "Understood, proceeding." },
      ]);
      const config = createTestConfig({
        playbookPath: env.playbookPath,
        diaryDir: env.diaryDir,
        cassPath: "/__missing__/cass",
        validationEnabled: false,
      });
      await withEnv({ CASS_MEMORY_LLM: "none" }, async () => {
        await withLlmShim(
          {
            reflector: {
              deltas: [
                {
                  type: "add",
                  bullet: { content: "Use the project task runner.", category: "x", scope: "workspace" },
                } as any,
              ],
            },
          },
          async (io) => {
            await orchestrateReflection(config, { session: sessionPath, io });
          },
        );
      });
      const saved = readPlaybook(env.playbookPath);
      const rule = saved.bullets.find((b: any) => b.content.includes("task runner"));
      expect(rule.scope).toBe("global");
    });
  });
});
