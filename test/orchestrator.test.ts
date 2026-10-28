/**
 * Unit tests for `src/orchestrator.ts`.
 *
 * These tests run in-process (for Bun coverage) and avoid network/LLM calls by:
 * - Setting `CASS_MEMORY_LLM=none` (fast diary generation, no LLM)
 * - Using LLMIO injection to inject deterministic deltas (no env vars needed)
 * - Setting `config.validationEnabled=false` to bypass validator/evidence calls
 * - Pointing `config.cassPath` at a non-existent binary so `cassExport` uses fallback parsing
 */
import { describe, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import yaml from "yaml";

import { recordFeedback } from "../src/commands/mark.js";
import { withLock } from "../src/lock.js";
import type { LLMIO } from "../src/llm.js";
import { orchestrateReflection, type ReflectionOptions } from "../src/orchestrator.js";
import { prepareOutcome } from "../src/outcome.js";
import { reflectionCommitPendingPath } from "../src/reflection-commit.js";
import { slugifyProjectDir, tagCmSubprocessPrompt } from "../src/subprocess-tag.js";
import { getProcessedLogPath, ProcessedLog } from "../src/tracking.js";
import type { Config, PlaybookBullet, PlaybookDelta, ProcessedEntry } from "../src/types.js";
import { expandPath, jaccardSimilarity, now } from "../src/utils.js";
import { createBullet, createTestConfig, createTestFeedbackEvent, createTestPlaybook } from "./helpers/factories.js";
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
  lines: Array<{ role: string; content: string; cwd?: string }>,
): void {
  mkdirSync(path.dirname(sessionPath), { recursive: true });
  const body = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  writeFileSync(sessionPath, body, "utf-8");
}

function readPlaybook(playbookPath: string): any {
  return yaml.parse(readFileSync(playbookPath, "utf-8"));
}

async function withMergeReflection(
  globalRules: PlaybookBullet[],
  repoRules: PlaybookBullet[] | undefined,
  deltas: PlaybookDelta[],
  check: (result: {
    global: PlaybookBullet[];
    repo: PlaybookBullet[];
    repoRoot: string;
    outcome: Awaited<ReturnType<typeof orchestrateReflection>>;
  }) => void,
): Promise<void> {
  await withIsolatedHome(async (env) => {
    const repoRoot = path.join(env.home, "project");
    const repoPath = path.join(repoRoot, ".cass", "playbook.yaml");
    // A stable token lets fixtures refer to the actual isolated repository.
    const bindWorkspace = (bullet: PlaybookBullet) => ({
      ...bullet,
      ...(bullet.workspace === "$project" ? { workspace: repoRoot } : {}),
    });
    writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook(globalRules.map(bindWorkspace))));
    if (repoRules) {
      mkdirSync(path.dirname(repoPath), { recursive: true });
      expect(Bun.spawnSync(["git", "init", "--quiet", repoRoot]).exitCode).toBe(0);
      writeFileSync(repoPath, yaml.stringify(createTestPlaybook(repoRules.map(bindWorkspace))));
      process.chdir(repoRoot);
    }
    const sessionPath = path.join(env.home, "sessions", "merge.jsonl");
    const workspace = repoRules ? repoRoot : globalRules.find(b => b.scope === "workspace" && b.workspace)?.workspace;
    writeJsonlSession(sessionPath, [
      { role: "user", content: "Consolidate the relevant rules while preserving their applicability and useful instructions.", cwd: workspace },
      { role: "assistant", content: "The existing project and language rules must remain available in their original contexts.", cwd: workspace },
    ]);
    const config = createTestConfig({
      playbookPath: env.playbookPath,
      diaryDir: env.diaryDir,
      cassPath: "/__missing__/cass",
      validationEnabled: false,
    });
    // These are user-level policies; a session outside the launch cwd reloads
    // them before applying any project-specific overrides.
    writeFileSync(env.configPath, JSON.stringify(config));
    await withEnv({ CASS_MEMORY_LLM: "none" }, async () => {
      await withLlmShim({ reflector: { deltas } }, async (io) => {
        const outcome = await orchestrateReflection(config, { session: sessionPath, io });
        expect(outcome.errors).toEqual([]);
        check({
          global: readPlaybook(env.playbookPath).bullets,
          repo: repoRules ? readPlaybook(repoPath).bullets : [],
          repoRoot,
          outcome,
        });
      });
    });
  });
}

describe("orchestrator merge applicability and retention", () => {
  test("a new workspace replacement retains the original project scope", async () => {
    const sources = [
      createBullet({ content: "Run the database migration check.", scope: "workspace", workspace: "/projects/alpha" }),
      createBullet({ content: "Check schema migration compatibility.", scope: "workspace", workspace: "/projects/alpha" }),
    ];
    const content = "Validate database migrations against the project schema.";
    await withMergeReflection(sources, undefined, [{ type: "merge", bulletIds: sources.map(b => b.id), mergedContent: content }], ({ global }) => {
      const replacement = global.find(b => b.content === content)!;
      expect(replacement).toBeDefined();
      expect(replacement.scope).toBe("workspace");
      expect(replacement.workspace).toBe("/projects/alpha");
      for (const source of sources) {
        expect(global.find(b => b.id === source.id)?.replacedBy).toBe(replacement.id);
      }
    });
  });

  test("identical replacement text in another language is not reused", async () => {
    const content = "Validate dependencies before release.";
    const otherLanguage = createBullet({ content, scope: "language", scopeKey: "typescript" });
    const sources = [
      createBullet({ content: "Audit Python dependencies.", scope: "language", scopeKey: "python" }),
      createBullet({ content: "Review package versions.", scope: "language", scopeKey: "python" }),
    ];
    await withMergeReflection([otherLanguage, ...sources], undefined, [{ type: "merge", bulletIds: sources.map(b => b.id), mergedContent: content }], ({ global }) => {
      const replacement = global.find(b => b.content === content && b.scopeKey === "python")!;
      expect(replacement).toBeDefined();
      expect(replacement.id).not.toBe(otherLanguage.id);
      expect(global.find(b => b.id === otherLanguage.id)?.deprecated).toBe(false);
      expect(global.find(b => b.id === sources[0].id)?.replacedBy).toBe(replacement.id);
    });
  });

  test.each(["different workspaces", "global and workspace", "different selectors", "retired source", "missing source", "duplicate source"])("rejects %s without retiring any additional source", async (kind) => {
    const first = createBullet({ content: "Review migration scripts.", scope: "workspace", workspace: "/projects/alpha" });
    const second = createBullet({ content: "Check migration compatibility.", scope: "workspace", workspace: "/projects/alpha" });
    if (kind === "different workspaces") second.workspace = "/projects/beta";
    if (kind === "global and workspace") second.scope = "global";
    if (kind === "different selectors") {
      first.scope = second.scope = "language";
      first.scopeKey = "python";
      second.scopeKey = "typescript";
    }
    if (kind === "retired source") second.state = "retired";
    const ids = kind === "missing source" ? [first.id, "b-missing"] : kind === "duplicate source" ? [first.id, first.id] : [first.id, second.id];
    await withMergeReflection([first, second], undefined, [{ type: "merge", bulletIds: ids, mergedContent: "Validate migrations before release." }], ({ global, outcome }) => {
      expect(global).toHaveLength(2);
      expect(global.find(b => b.id === first.id)?.deprecated).toBe(false);
      expect(global.find(b => b.id === second.id)?.deprecated).toBe(false);
      expect(outcome.globalResult?.decisionLog?.some(entry => entry.action === "rejected" && entry.reason.includes("merge"))).toBe(true);
    });
  });

  test("keeps unresolved workspace rules in the global playbook separate", async () => {
    const sources = [
      createBullet({
        content: "Review migration scripts.", scope: "workspace", workspace: undefined,
        state: "active", sourceSessions: ["/sessions/project-a.jsonl"],
      }),
      createBullet({
        content: "Check migration compatibility.", scope: "workspace", workspace: undefined,
        state: "active", sourceSessions: ["/sessions/project-b.jsonl"],
      }),
    ];
    await withMergeReflection(sources, undefined, [{
      type: "merge", bulletIds: sources.map(b => b.id),
      mergedContent: "Validate migrations before release.",
    }], ({ global, outcome }) => {
      expect(global).toHaveLength(2);
      for (const source of sources) {
        const saved = global.find(b => b.id === source.id)!;
        expect(saved).toBeDefined();
        expect(saved.state).toBe("active");
        expect(saved.deprecated).toBe(false);
        expect(saved.replacedBy).toBeUndefined();
        expect(saved.scope).toBe("workspace");
        expect(saved.workspace).toBeUndefined();
        expect(saved.sourceSessions).toEqual(source.sourceSessions);
      }
      expect(outcome.globalResult?.decisionLog?.some(entry =>
        entry.action === "rejected" && entry.reason.includes("same applicability"),
      )).toBe(true);
    });
  });

  test("opposing high-overlap guidance is not selected as the replacement", async () => {
    const opposing = createBullet({ content: "Never commit generated dependency lockfiles alongside package manifests, version updates, checksum records, release metadata, deployment configuration, build settings, reproducibility notes, and integration test fixtures." });
    const sources = [
      createBullet({ content: "Track dependency lockfiles in git." }),
      createBullet({ content: "Commit lockfiles with dependency changes." }),
    ];
    const content = "Always commit generated dependency lockfiles alongside package manifests, version updates, checksum records, release metadata, deployment configuration, build settings, reproducibility notes, and integration test fixtures.";
    expect(jaccardSimilarity(content, opposing.content)).toBeGreaterThan(0.85);
    await withMergeReflection([opposing, ...sources], undefined, [{ type: "merge", bulletIds: sources.map(b => b.id), mergedContent: content }], ({ global }) => {
      const replacement = global.find(b => b.content === content)!;
      expect(replacement).toBeDefined();
      expect(global.find(b => b.id === sources[0].id)?.replacedBy).toBe(replacement.id);
      expect(global.find(b => b.id === opposing.id)?.deprecated).toBe(false);
    });
  });

  test("a replacement at the harmful threshold cannot retire healthy sources", async () => {
    const content = "Validate database migrations against the current schema.";
    const harmful = createBullet({
      content,
      harmfulCount: 3,
      feedbackEvents: [0, 1, 2].map(index => createTestFeedbackEvent("harmful", {
        timestamp: now(),
        sessionPath: `/sessions/harmful-${index}.jsonl`,
      })),
    });
    const sources = [
      createBullet({ content: "Review SQL migration files." }),
      createBullet({ content: "Check compatibility before deploying." }),
    ];
    await withMergeReflection([harmful, ...sources], undefined, [{
      type: "merge", bulletIds: sources.map(b => b.id), mergedContent: content,
    }], ({ global }) => {
      expect(global.find(b => b.id === harmful.id)?.deprecated).toBe(true);
      for (const source of sources) {
        const saved = global.find(b => b.id === source.id)!;
        expect(saved.deprecated).toBe(false);
        expect(saved.state).not.toBe("retired");
        expect(saved.replacedBy).toBeUndefined();
      }
    });
  });

  test("identical text in an anti-pattern cannot replace ordinary rules", async () => {
    const content = "Validate database migrations against the current schema.";
    const antiPattern = createBullet({ content, type: "anti-pattern", isNegative: true, kind: "anti_pattern" });
    const sources = [
      createBullet({ content: "Review SQL migration files." }),
      createBullet({ content: "Check compatibility before deploying." }),
    ];
    await withMergeReflection([antiPattern, ...sources], undefined, [{
      type: "merge", bulletIds: sources.map(b => b.id), mergedContent: content,
    }], ({ global }) => {
      const replacement = global.find(b => b.content === content && b.type === "rule" && !b.isNegative);
      expect(replacement).toBeDefined();
      expect(replacement?.deprecated).toBe(false);
      expect(replacement?.id).not.toBe(antiPattern.id);
      for (const source of sources) {
        expect(global.find(b => b.id === source.id)?.replacedBy).toBe(replacement?.id);
      }
      expect(global.find(b => b.id === antiPattern.id)?.deprecated).toBe(false);
    });
  });

  for (const layer of ["global", "repository"] as const) {
    test(`reusing a ${layer} replacement persists combined provenance and tags`, async () => {
      const scope = layer === "global" ? "global" : "workspace";
      const content = "Validate database migrations against the current schema.";
      const replacement = createBullet({
        content, scope, sourceSessions: ["/sessions/original.jsonl"], sourceAgents: ["gemini"], tags: ["original", "shared"],
      });
      const sources = [
        createBullet({
          content: "Review SQL migration files.", scope,
          sourceSessions: ["/sessions/original.jsonl", "/sessions/first.jsonl"],
          sourceAgents: ["claude"], tags: ["migration", "shared"],
        }),
        createBullet({
          content: "Check compatibility before deploying.", scope,
          sourceSessions: ["/sessions/second.jsonl"], sourceAgents: ["codex", "claude"], tags: ["schema"],
        }),
      ];
      const rules = [replacement, ...sources];
      await withMergeReflection(layer === "global" ? rules : [], layer === "repository" ? rules : undefined, [{
        type: "merge", bulletIds: sources.map(b => b.id), mergedContent: content,
      }], ({ global, repo }) => {
        const savedRules = layer === "global" ? global : repo;
        expect(savedRules).toHaveLength(3);
        const saved = savedRules.find(b => b.id === replacement.id)!;
        expect(saved.deprecated).toBe(false);
        expect(saved.sourceSessions.sort()).toEqual(["/sessions/first.jsonl", "/sessions/original.jsonl", "/sessions/second.jsonl"]);
        expect(saved.sourceAgents.sort()).toEqual(["claude", "codex", "gemini"]);
        expect(saved.tags.sort()).toEqual(["migration", "original", "schema", "shared"]);
        for (const source of sources) {
          expect(savedRules.find(b => b.id === source.id)?.replacedBy).toBe(saved.id);
        }
      });
    });
  }

  test("repository-only merges stay portable in the repository playbook", async () => {
    const sources = [
      createBullet({ content: "Run the database migration check.", scope: "workspace" }),
      createBullet({ content: "Check schema migration compatibility.", scope: "workspace" }),
    ];
    const content = "Validate database migrations against the project schema.";
    await withMergeReflection([], sources, [{ type: "merge", bulletIds: sources.map(b => b.id), mergedContent: content }], ({ global, repo }) => {
      expect(global).toHaveLength(0);
      const replacement = repo.find(b => b.content === content)!;
      expect(replacement).toBeDefined();
      expect(replacement.scope).toBe("workspace");
      expect(replacement.workspace).toBeUndefined();
      expect(repo.find(b => b.id === sources[0].id)?.replacedBy).toBe(replacement.id);
    });
  });

  test("cross-layer merges materialize the repository scope on a global replacement", async () => {
    const globalSource = createBullet({ content: "Run the database migration check.", scope: "workspace", workspace: "$project" });
    const repoSource = createBullet({ content: "Check schema migration compatibility.", scope: "workspace" });
    const content = "Validate database migrations against the project schema.";
    await withMergeReflection([globalSource], [repoSource], [{ type: "merge", bulletIds: [globalSource.id, repoSource.id], mergedContent: content }], ({ global, repo, repoRoot }) => {
      const replacement = global.find(b => b.content === content)!;
      expect(replacement).toBeDefined();
      expect(replacement.scope).toBe("workspace");
      expect(replacement.workspace).toBe(repoRoot);
      expect(global.find(b => b.id === globalSource.id)?.replacedBy).toBe(replacement.id);
      expect(repo.find(b => b.id === repoSource.id)?.replacedBy).toBe(replacement.id);
    });
  });

  test("a later merge rechecks sources retired by an earlier merge", async () => {
    const sources = [
      createBullet({ content: "Review migration scripts." }),
      createBullet({ content: "Check schema compatibility." }),
      createBullet({ content: "Run deployment smoke tests." }),
    ];
    await withMergeReflection(sources, undefined, [
      { type: "merge", bulletIds: [sources[0].id, sources[1].id], mergedContent: "Validate database migrations." },
      { type: "merge", bulletIds: [sources[1].id, sources[2].id], mergedContent: "Exercise deployment behavior." },
    ], ({ global }) => {
      expect(global.find(b => b.id === sources[2].id)?.deprecated).toBe(false);
      expect(global.some(b => b.content === "Exercise deployment behavior.")).toBe(false);
      expect(global.some(b => b.content === "Validate database migrations.")).toBe(true);
    });
  });
});

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

  test("a hook-started reflect waits for a reflect in progress instead of failing", async () => {
    // Two agent sessions that end together each start `cm reflect --session`;
    // the second used to give up on the reflection lock after ~2 s.
    await withIsolatedHome(async (env) => {
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
      // CASS_MEMORY_HOME / XDG_DATA_HOME would point the lock at real cm state.
      await withEnv(
        {
          CASS_MEMORY_LLM: "none",
          CM_HOOK_ACTIVE: "1",
          CASS_MEMORY_HOME: undefined,
          XDG_DATA_HOME: undefined,
        },
        async () => {
          const lockPath = `${expandPath(getProcessedLogPath(undefined))}.orchestrator`;
          expect(lockPath.startsWith(env.home)).toBe(true);
          let released = false;
          const inProgress = withLock(lockPath, async () => {
            await new Promise((resolve) => setTimeout(resolve, 3500));
            released = true;
          });
          await new Promise((resolve) => setTimeout(resolve, 100));
          await withLlmShim({ reflector: { deltas: [] } }, async (io) => {
            const outcome = await orchestrateReflection(config, { session: sessionPath, io });
            expect(released).toBe(true);
            expect(outcome.errors).toEqual([]);
            expect(outcome.sessionsProcessed).toBe(1);
          });
          await inProgress;
        },
      );
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
      writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([
        createBullet({ id: "b-ccc333", content: "Verify exporter output against the integration tests." }),
      ])), "utf-8");

      const sessionPath = path.join(env.home, "sessions", "real-work.jsonl");
      writeJsonlSession(sessionPath, [
        {
          role: "user",
          content:
            "Following b-ccc333 I refactored the exporter, then debugged why reflect grades everything.",
        },
        {
          role: "assistant",
          content: "Applied b-ccc333, the refactor is done and the whole suite is green now.",
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
            expect(outcome.failedSessions).toEqual([{
              sessionPath,
              error: expect.stringContaining("runReflector timed out"),
              proposedDeltas: [],
            }]);

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

describe("orchestrateReflection incomplete session safety (#99)", () => {
  for (const dryRun of [false, true]) {
    test(`retains later-pass proposals without applying or grading them${dryRun ? " in dry-run" : ""}`, async () => {
      await withIsolatedHome(async env => {
        const bullet = createBullet({ id: "b-abc111", content: "Inspect the command exit status before accepting a result." });
        writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([bullet])));
        const before = readFileSync(env.playbookPath, "utf-8");
        const sessionPath = path.join(env.home, "sessions", "incomplete.jsonl");
        writeJsonlSession(sessionPath, [
          { role: "user", content: "Investigate why this scheduled reflection reported success after processing failed." },
          { role: "assistant", content: "// [cass: helpful b-abc111] - checking the exit status exposed the failure" },
        ]);
        const config = createTestConfig({
          playbookPath: env.playbookPath, diaryDir: env.diaryDir, cassPath: "/__missing__/cass",
          validationEnabled: false, semanticSearchEnabled: false, embeddingModel: "none",
        });
        let calls = 0;
        await withEnv({ CASS_MEMORY_LLM: "none" }, () => withLlmShim({
          reflector: () => {
            if (++calls > 1) throw new Error("invalid_api_key: later reflection pass failed");
            return { deltas: [{ type: "add", bullet: {
              content: "Review incomplete reflection proposals before applying them.", category: "testing",
            } }] };
          },
        }, async io => {
          const result = await orchestrateReflection(config, { session: sessionPath, dryRun, io });
          expect(calls).toBeGreaterThan(1);
          expect(result.sessionsProcessed).toBe(0);
          expect(result.deltasGenerated).toBe(0);
          expect(result.errors).toHaveLength(1);
          expect(result.failedSessions).toEqual([{
            sessionPath,
            error: expect.stringContaining("later reflection pass failed"),
            proposedDeltas: [expect.objectContaining({ type: "add", sourceSession: sessionPath })],
          }]);
          expect(result.globalResult).toBeUndefined();
          if (dryRun) expect(result.dryRunDeltas).toEqual([]);
          expect(readFileSync(env.playbookPath, "utf-8")).toBe(before);
          const ledger = new ProcessedLog(expandPath(getProcessedLogPath()));
          await ledger.load();
          expect(ledger.has(sessionPath)).toBe(false);
          if (dryRun) expect(ledger.get(sessionPath)).toBeUndefined();
          else {
            expect(ledger.get(sessionPath)).toMatchObject({ status: "failed", failures: 1 });
            expect(ledger.get(sessionPath)?.recordCount).toBeUndefined();
          }
        }));
      });
    });
  }

  test("a failed continuation retains its watermark and retries without double feedback or counters", async () => {
    await withIsolatedHome(async env => {
      const oldRule = createBullet({ id: "b-old111", content: "Check parser diagnostics before rewriting token handling." });
      const newRule = createBullet({ id: "b-new222", content: "Validate new transport frames against their declared lengths." });
      writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([oldRule, newRule])));
      const sessionPath = path.join(env.home, "sessions", "continuation-fails.jsonl");
      writeJsonlSession(sessionPath, [
        { role: "user", content: "OLDTURN investigate the parser failure and inspect its diagnostics before changing code." },
        { role: "assistant", content: "// [cass: helpful b-old111] - the original diagnostics identified the parser defect" },
      ]);
      const config = createTestConfig({
        playbookPath: env.playbookPath, diaryDir: env.diaryDir, cassPath: "/__missing__/cass",
        validationEnabled: false, semanticSearchEnabled: false, embeddingModel: "none",
      });
      const readEntry = async () => {
        const ledger = new ProcessedLog(expandPath(getProcessedLogPath()));
        await ledger.load();
        return ledger.get(sessionPath);
      };
      const proposal = { type: "add" as const, bullet: {
        content: "Reject transport frames whose payload length differs from the declared header.", category: "testing",
      } };
      await withEnv({ CASS_MEMORY_LLM: "none" }, async () => {
        await withLlmShim({ reflector: { deltas: [] } }, async io => {
          expect((await orchestrateReflection(config, { session: sessionPath, io })).errors).toEqual([]);
        });
        const prior = (await readEntry())!;
        expect(prior.recordCount).toBe(2);
        const before = readFileSync(env.playbookPath, "utf-8");
        appendJsonl(sessionPath, [
          { role: "user", content: "NEWTURN now inspect the incoming transport frame and validate its header length." },
          { role: "assistant", content: "// [cass: helpful b-new222] - the new header check found truncated payloads" },
        ]);
        let failCalls = 0;
        await withLlmShim({ reflector: prompt => {
          expect(prompt).not.toContain("OLDTURN");
          if (++failCalls > 1) throw new Error("invalid_api_key: continuation pass failed");
          return { deltas: [proposal] };
        } }, async io => {
          const failed = await orchestrateReflection(config, { session: sessionPath, io });
          expect(failed.errors).toHaveLength(1);
          expect(failed.sessionsProcessed).toBe(0);
          expect(failed.deltasGenerated).toBe(0);
          expect(failed.failedSessions?.[0]?.proposedDeltas).toHaveLength(1);
        });
        expect(readFileSync(env.playbookPath, "utf-8")).toBe(before);
        expect(await readEntry()).toMatchObject({
          status: "failed", failures: 1, recordCount: prior.recordCount,
          lastRecordHash: prior.lastRecordHash, processedAt: prior.processedAt,
        });

        let retryCalls = 0;
        await withLlmShim({ reflector: prompt => {
          expect(prompt).not.toContain("OLDTURN");
          return { deltas: ++retryCalls === 1 ? [proposal] : [] };
        } }, async io => {
          const recovered = await orchestrateReflection(config, { session: sessionPath, io });
          expect(recovered.errors).toEqual([]);
          expect(recovered.failedSessions).toBeUndefined();
          expect(recovered.sessionsProcessed).toBe(1);
          expect((await readEntry())?.recordCount).toBe(4);
          expect((await readEntry())?.status).toBeUndefined();
          const saved = readPlaybook(env.playbookPath);
          expect(saved.bullets.filter((b: PlaybookBullet) => b.content === proposal.bullet.content)).toHaveLength(1);
          for (const id of [oldRule.id, newRule.id]) {
            const rule = saved.bullets.find((b: PlaybookBullet) => b.id === id);
            expect(rule.helpfulCount).toBe(1);
            expect(rule.feedbackEvents).toHaveLength(1);
          }
          expect(saved.metadata.totalReflections).toBe(2);
          expect(saved.metadata.totalSessionsProcessed).toBe(2);
          const stable = readFileSync(env.playbookPath, "utf-8");
          const rerun = await orchestrateReflection(config, { session: sessionPath, io });
          expect(rerun.errors).toEqual([]);
          expect(rerun.sessionsProcessed).toBe(0);
          expect(readFileSync(env.playbookPath, "utf-8")).toBe(stable);
          expect(retryCalls).toBe(2);
        });
      });
    });
  });

  test("a mixed batch commits complete sessions and retains failed proposals separately", async () => {
    await withWorkspaceReflection(async f => {
      f.config.maxReflectorIterations = 3;
      writeFileSync(f.env.configPath, JSON.stringify(f.config));
      const failedPath = f.session("later-pass-fails", f.alpha, "// [cass: helpful b-aaa111] - alpha check passed");
      const healthyPath = f.session("complete-session", f.beta, "// [cass: helpful b-aaa111] - beta check passed");
      f.discover([{ path: failedPath, workspace: f.alpha }, { path: healthyPath, workspace: f.beta }]);
      const before = readFileSync(f.alphaPath, "utf-8");
      const counts = new Map<string, number>();
      const result = await f.run(prompt => {
        const failed = prompt.includes("ALPHA_ONLY");
        const key = failed ? failedPath : healthyPath;
        const count = (counts.get(key) ?? 0) + 1;
        counts.set(key, count);
        if (failed && count > 1) throw new Error("invalid_api_key: alpha continuation failed");
        return { deltas: count > 1 ? [] : [{ type: "add", bullet: {
          content: failed ? "Inspect the alpha journal before replaying database migrations." : "Validate beta archive checksums before extracting deployment bundles.",
          category: "testing", scope: "workspace",
        } }] };
      });
      expect(result.errors).toHaveLength(1);
      expect(result.sessionsProcessed).toBe(1);
      expect(result.deltasGenerated).toBe(2); // completed rule plus its inline feedback
      expect(result.failedSessions).toHaveLength(1);
      expect(result.failedSessions?.[0]?.sessionPath).toBe(failedPath);
      expect(result.failedSessions?.[0]?.proposedDeltas).toHaveLength(1);
      expect(readFileSync(f.alphaPath, "utf-8")).toBe(before);
      const beta = readPlaybook(f.betaPath);
      expect(beta.bullets.some((b: PlaybookBullet) => b.content.includes("beta archive"))).toBe(true);
      expect(beta.bullets.find((b: PlaybookBullet) => b.id === "b-aaa111").helpfulCount).toBe(1);
      expect(readPlaybook(f.env.playbookPath).metadata.totalSessionsProcessed).toBe(1);
      const ledger = new ProcessedLog(expandPath(getProcessedLogPath()));
      await ledger.load();
      expect(ledger.get(failedPath)).toMatchObject({ status: "failed", failures: 1 });
      expect(ledger.get(failedPath)?.recordCount).toBeUndefined();
      expect(ledger.has(healthyPath)).toBe(true);
    });
  });

  test("a failure after grading discards the session's entire staged change set", async () => {
    await withWorkspaceReflection(async f => {
      const sessionPath = f.session("post-grading-failure", f.beta,
        "All tests passed. // [cass: helpful b-aaa111] - integration checks worked\nUsed b-bbb222 to verify deployment readiness successfully.");
      const globalBefore = readFileSync(f.env.playbookPath, "utf-8");
      const repoBefore = readFileSync(f.betaPath, "utf-8");
      const result = await f.run({ deltas: [{ type: "add", bullet: {
        content: "Check binary package signatures before promoting a beta release.", category: "testing", scope: "workspace",
      } }] }, {
        session: sessionPath,
        onProgress: event => {
          if (event.phase === "session_done") throw new Error("progress consumer failed after grading");
        },
      });
      expect(result.errors).toHaveLength(1);
      expect(result.sessionsProcessed).toBe(0);
      expect(result.deltasGenerated).toBe(0);
      expect(result.failedSessions?.[0]?.proposedDeltas).toHaveLength(1);
      expect(readFileSync(f.env.playbookPath, "utf-8")).toBe(globalBefore);
      expect(readFileSync(f.betaPath, "utf-8")).toBe(repoBefore);
      const ledger = new ProcessedLog(expandPath(getProcessedLogPath()));
      await ledger.load();
      expect(ledger.get(sessionPath)).toMatchObject({ status: "failed", failures: 1 });
      expect(ledger.get(sessionPath)?.recordCount).toBeUndefined();
      expect(ledger.getPendingOutcomeEntries()).toEqual([]);
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
    mkdirSync(dir, { recursive: true });
    expect(Bun.spawnSync(["git", "init", "--quiet", dir]).exitCode).toBe(0);
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
      writeFileSync(env.configPath, JSON.stringify(config));
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
      writeFileSync(env.configPath, JSON.stringify(config));
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

interface WorkspaceReflectionFixture {
  env: TestEnv;
  config: Config;
  alpha: string;
  beta: string;
  alphaPath: string;
  betaPath: string;
  session: (name: string, workspace: string | undefined, feedback: string, request?: string) => string;
  discover: (sessions: Array<{ path: string; workspace?: string }>) => void;
  run: (reflector?: LlmShimConfig["reflector"], options?: Omit<ReflectionOptions, "io">) => Promise<Awaited<ReturnType<typeof orchestrateReflection>>>;
}

async function withWorkspaceReflection(check: (fixture: WorkspaceReflectionFixture) => Promise<void>): Promise<void> {
  await withIsolatedHome(async env => {
    const alpha = path.join(env.home, "alpha");
    const beta = path.join(env.home, "beta");
    const alphaPath = path.join(alpha, ".cass", "playbook.yaml");
    const betaPath = path.join(beta, ".cass", "playbook.yaml");
    for (const project of [alpha, beta]) {
      mkdirSync(path.join(project, ".cass"), { recursive: true });
      expect(Bun.spawnSync(["git", "init", "--quiet", project]).exitCode).toBe(0);
      const label = project === alpha ? "ALPHA_ONLY" : "BETA_ONLY";
      writeFileSync(path.join(project, ".cass", "playbook.yaml"), yaml.stringify(createTestPlaybook([
        createBullet({ id: "b-aaa111", content: `${label}: run the project's integration checks.`, scope: "workspace" }),
        createBullet({ id: "b-bbb222", content: `${label}: require deployment review before release.`, scope: "workspace" }),
      ])));
    }
    writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])));
    const timelinePath = path.join(env.home, "timeline.json");
    const cassPath = path.join(env.home, "cass-fixture.ts");
    writeFileSync(cassPath, `#!${process.execPath}\nconst command = process.argv[2];
if (command === "timeline") console.log(await Bun.file(${JSON.stringify(timelinePath)}).text());
else if (command === "search") console.log("[]");
else process.exit(1);
`);
    chmodSync(cassPath, 0o755);
    const config = createTestConfig({
      playbookPath: env.playbookPath, diaryDir: env.diaryDir, cassPath,
      validationEnabled: false, semanticSearchEnabled: false,
      maxReflectorIterations: 1, projectRuleRouting: "repo",
    });
    writeFileSync(env.configPath, JSON.stringify(config));
    process.chdir(alpha);
    const session = (name: string, workspace: string | undefined, feedback: string,
      request = "Investigate the project-specific regression and record the relevant findings carefully.") => {
      const sessionPath = path.join(env.home, "sessions", `${name}.jsonl`);
      writeJsonlSession(sessionPath, [
        { role: "user", content: request, cwd: workspace },
        { role: "assistant", content: feedback, cwd: workspace },
      ]);
      return sessionPath;
    };
    const discover = (sessions: Array<{ path: string; workspace?: string }>) => {
      writeFileSync(timelinePath, JSON.stringify({ groups: {
        [now().slice(0, 10)]: sessions.map(entry => ({
          source_path: entry.path, workspace: entry.workspace, agent: "claude_code",
          message_count: 2, started_at: now(), ended_at: now(),
        })),
      } }));
    };
    discover([]);
    const run: WorkspaceReflectionFixture["run"] = async (reflector = { deltas: [] }, options = {}) =>
      withEnv({ CASS_MEMORY_LLM: "none", CASS_PATH: undefined }, () =>
        orchestrateReflection(config, { maxSessions: 20, ...options, io: {
          generateObject: async <T>(request: any) => ({
            object: (typeof reflector === "function" ? reflector(request.prompt, request) : reflector) as T,
          }),
        } }));
    await check({ env, config, alpha, beta, alphaPath, betaPath, session, discover, run });
  });
}

describe("orchestrateReflection session workspace ownership", () => {
  test("automatic discovery uses B's snapshot and inline feedback owners while launched in A", async () => {
    await withWorkspaceReflection(async f => {
      const beta = readPlaybook(f.betaPath);
      beta.bullets.push(createBullet({ id: "b-ccc333", content: "BETA_ONLY: validate migration fixtures.", scope: "workspace" }));
      writeFileSync(f.betaPath, yaml.stringify(beta));
      const alphaBefore = readFileSync(f.alphaPath, "utf-8");
      const first = f.session("beta-first", f.beta,
        "// [cass: helpful b-aaa111] - useful check\n// [cass: harmful b-bbb222] - wrong release context\n// [cass: helpful b-ccc333] - correct fixture");
      f.discover([{ path: first }]);
      const prompts: string[] = [];
      const result = await f.run(prompt => { prompts.push(prompt); return { deltas: [] }; });
      expect(result.errors).toEqual([]);
      expect(result.sessionsProcessed).toBe(1);
      expect(result.repoResult?.applied).toBe(3);
      expect(result.projectResults?.map(project => project.playbookPath)).toEqual([f.betaPath]);
      expect(prompts.join("\n")).toContain("BETA_ONLY");
      expect(prompts.join("\n")).not.toContain("ALPHA_ONLY");
      expect(readPlaybook(f.betaPath).bullets.map((b: PlaybookBullet) => [b.id, b.helpfulCount, b.harmfulCount])).toEqual([
        ["b-aaa111", 1, 0], ["b-bbb222", 0, 1], ["b-ccc333", 1, 0],
      ]);
      expect(readFileSync(f.alphaPath, "utf-8")).toBe(alphaBefore);
      expect(readPlaybook(f.env.playbookPath).bullets).toEqual([]);
      const second = f.session("beta-second", f.beta, "// [cass: harmful b-bbb222] - still the wrong release context");
      f.discover([{ path: second }]);
      expect((await f.run()).errors).toEqual([]);
      expect(readPlaybook(f.betaPath).bullets.find((b: PlaybookBullet) => b.id === "b-bbb222").deprecated).toBe(true);
      expect(readFileSync(f.alphaPath, "utf-8")).toBe(alphaBefore);
      expect((await f.run()).sessionsProcessed).toBe(0);
      const log = new ProcessedLog(getProcessedLogPath());
      await log.load();
      expect(log.get(first)?.recordCount).toBe(2);
      expect(log.get(second)?.recordCount).toBe(2);
    });
  });

  test("a mixed-project batch keeps colliding IDs and aggregate counts separate", async () => {
    await withWorkspaceReflection(async f => {
      const alpha = f.session("alpha", f.alpha, "// [cass: helpful b-aaa111] - appropriate for alpha");
      const beta = f.session("beta", f.beta, "// [cass: harmful b-aaa111] - inappropriate for beta");
      f.discover([{ path: alpha }, { path: beta }]);
      const result = await f.run();
      expect(result.errors).toEqual([]);
      expect(result.sessionsProcessed).toBe(2);
      expect(result.repoResult?.applied).toBe(2);
      expect(result.projectResults?.map(project => project.playbookPath).sort()).toEqual([f.alphaPath, f.betaPath].sort());
      expect(readPlaybook(f.alphaPath).bullets[0].helpfulCount).toBe(1);
      expect(readPlaybook(f.alphaPath).bullets[0].harmfulCount).toBe(0);
      expect(readPlaybook(f.betaPath).bullets[0].helpfulCount).toBe(0);
      expect(readPlaybook(f.betaPath).bullets[0].harmfulCount).toBe(1);
      expect(readPlaybook(f.alphaPath).bullets[0].feedbackEvents[0].sessionPath).toBe(alpha);
      expect(readPlaybook(f.betaPath).bullets[0].feedbackEvents[0].sessionPath).toBe(beta);
      expect(readPlaybook(f.env.playbookPath).metadata.totalSessionsProcessed).toBe(2);
    });
  });

  test("all model delta kinds use the real session owner and ignore forged sourceSession", async () => {
    await withWorkspaceReflection(async f => {
      for (const [file, label] of [[f.alphaPath, "ALPHA_ONLY"], [f.betaPath, "BETA_ONLY"]]) {
        writeFileSync(file!, yaml.stringify(createTestPlaybook([
          createBullet({ id: "b-aaa111", content: `${label} integration test command.`, scope: "workspace" }),
          createBullet({ id: "b-bbb222", content: `${label} review gate.`, scope: "workspace" }),
          createBullet({ id: "b-ccc333", content: `${label} old migration command.`, scope: "workspace" }),
          createBullet({ id: "b-ddd444", content: `${label} legacy deployment process.`, scope: "workspace" }),
          createBullet({ id: "b-eee555", content: `${label} verify schema changes.`, scope: "workspace" }),
          createBullet({ id: "b-fff666", content: `${label} inspect migration compatibility.`, scope: "workspace" }),
        ])));
      }
      const alphaBefore = readFileSync(f.alphaPath, "utf-8");
      const session = f.session("beta-model", f.beta, "The investigation found several reusable project-specific lessons.");
      f.discover([{ path: session }]);
      const forged = path.join(f.alpha, "unrelated.jsonl");
      const merged = "Validate BETA_ONLY migrations against the deployment database schema.";
      const result = await f.run({ deltas: [
        { type: "helpful", bulletId: "b-aaa111", sourceSession: forged },
        { type: "harmful", bulletId: "b-bbb222", sourceSession: forged, reason: "wrong_context" },
        { type: "replace", bulletId: "b-ccc333", newContent: "BETA_ONLY: use make migrate-check.", reason: "Updated command" },
        { type: "deprecate", bulletId: "b-ddd444", reason: "Replaced deployment process" },
        { type: "merge", bulletIds: ["b-eee555", "b-fff666"], mergedContent: merged },
        { type: "add", bullet: { content: "BETA_ONLY: run the smoke-test target before release.", category: "testing", scope: "workspace" }, sourceSession: forged },
      ] });
      expect(result.errors).toEqual([]);
      const rules = readPlaybook(f.betaPath).bullets as PlaybookBullet[];
      expect(rules.find(b => b.id === "b-aaa111")?.helpfulCount).toBe(1);
      expect(rules.find(b => b.id === "b-bbb222")?.harmfulCount).toBe(1);
      expect(rules.find(b => b.id === "b-ccc333")?.content).toBe("BETA_ONLY: use make migrate-check.");
      expect(rules.find(b => b.id === "b-ddd444")?.deprecated).toBe(true);
      const replacement = rules.find(b => b.content === merged)!;
      expect(replacement).toBeDefined();
      expect(rules.find(b => b.id === "b-eee555")?.replacedBy).toBe(replacement.id);
      expect(rules.find(b => b.id === "b-fff666")?.replacedBy).toBe(replacement.id);
      expect(rules.find(b => b.content.includes("smoke-test"))?.sourceSessions).toEqual([session]);
      expect(rules.find(b => b.id === "b-aaa111")?.feedbackEvents[0]?.sessionPath).toBe(session);
      expect(rules.find(b => b.id === "b-bbb222")?.feedbackEvents[0]?.sessionPath).toBe(session);
      expect(readFileSync(f.alphaPath, "utf-8")).toBe(alphaBefore);
      expect(readPlaybook(f.env.playbookPath).bullets).toEqual([]);
    });
  });

  test("another project's global scoped rules are absent from prompts and cannot be changed or merged", async () => {
    await withWorkspaceReflection(async f => {
      const rules = [
        createBullet({ id: "b-ccc333", content: "ALPHA_SCOPED: require deployment approval.", scope: "workspace", workspace: f.alpha,
          harmfulCount: 2, feedbackEvents: [0, 1].map(index => createTestFeedbackEvent("harmful", { sessionPath: `old-${index}` })) }),
        createBullet({ id: "b-ddd444", content: "ALPHA_SCOPED: retain the old migration tooling.", scope: "workspace", workspace: f.alpha }),
      ];
      writeFileSync(f.env.playbookPath, yaml.stringify(createTestPlaybook(rules)));
      const before = readPlaybook(f.env.playbookPath).bullets;
      const session = f.session("beta-scopes", f.beta, "Review the available deployment guidance carefully.");
      f.discover([{ path: session }]);
      const prompts: string[] = [];
      const result = await f.run(prompt => {
        prompts.push(prompt);
        return { deltas: [
          { type: "helpful", bulletId: "b-aaa111" },
          { type: "replace", bulletId: "b-ccc333", newContent: "Discard approval requirements." },
          { type: "deprecate", bulletId: "b-ddd444", reason: "Not useful here" },
          { type: "merge", bulletIds: ["b-bbb222", "b-ccc333"], mergedContent: "Use a shared deployment procedure." },
        ] };
      });
      expect(result.errors).toEqual([]);
      expect(prompts.join("\n")).toContain("BETA_ONLY");
      expect(prompts.join("\n")).not.toContain("ALPHA_SCOPED");
      expect(prompts.join("\n")).not.toContain("ALPHA_ONLY");
      expect(readPlaybook(f.env.playbookPath).bullets).toEqual(before);
      expect(readPlaybook(f.betaPath).bullets[0].helpfulCount).toBe(1);
      expect(readPlaybook(f.betaPath).bullets[1].deprecated).toBe(false);
      expect(result.globalResult?.decisionLog?.filter(entry => entry.action === "rejected")).toHaveLength(3);
    });
  });

  test("B's routing and scoring apply with both B and run sanitization protections", async () => {
    await withWorkspaceReflection(async f => {
      f.config.sanitization.extraPatterns = ["RUN_ONLY_SECRET"];
      writeFileSync(path.join(f.beta, ".cass", "config.json"), JSON.stringify({
        projectRuleRouting: "scoped",
        sanitization: { extraPatterns: ["BETA_ONLY_SECRET"] },
        scoring: { harmfulMultiplier: 1, minFeedbackForActive: 1, minHelpfulForProven: 1 },
      }));
      const session = f.session("beta-policy", f.beta,
        "// [cass: helpful b-aaa111] - useful\n// [cass: harmful b-bbb222] - wrong context",
        "Investigate this project while protecting RUN_ONLY_SECRET and BETA_ONLY_SECRET in all summaries.");
      f.discover([{ path: session }]);
      const prompts: string[] = [];
      const result = await f.run(prompt => {
        prompts.push(prompt);
        return { deltas: [{ type: "add", bullet: {
          content: "Use the beta-specific release checklist.", category: "workflow", scope: "workspace",
        } }] };
      });
      expect(result.errors).toEqual([]);
      expect(readPlaybook(f.betaPath).bullets[0].maturity).toBe("proven");
      expect(readPlaybook(f.betaPath).bullets[1].deprecated).toBe(false);
      expect(readPlaybook(f.betaPath).bullets).toHaveLength(2);
      const added = readPlaybook(f.env.playbookPath).bullets.find((b: PlaybookBullet) => b.content.includes("beta-specific"));
      expect(added?.scope).toBe("workspace");
      expect(added?.workspace).toBe(f.beta);
      const diaryText = readdirSync(f.env.diaryDir).filter(name => name.endsWith(".json"))
        .map(name => readFileSync(path.join(f.env.diaryDir, name), "utf-8")).join("\n");
      for (const text of [prompts.join("\n"), diaryText]) {
        expect(text).not.toContain("RUN_ONLY_SECRET");
        expect(text).not.toContain("BETA_ONLY_SECRET");
        expect(text).toContain("[REDACTED]");
      }
    });
  });

  test.each([false, true])("linked worktree uses its policy and honors a local override: %s", async local => {
    await withWorkspaceReflection(async f => {
      expect(Bun.spawnSync(["git", "-C", f.beta, "-c", "user.name=Test", "-c", "user.email=test@example.com",
        "commit", "--quiet", "--allow-empty", "-m", "fixture"]).exitCode).toBe(0);
      const linked = path.join(f.env.home, "beta-linked");
      expect(Bun.spawnSync(["git", "-C", f.beta, "worktree", "add", "--quiet", "-b", "reflection-linked", linked]).exitCode).toBe(0);
      const linkedPath = path.join(linked, ".cass", "playbook.yaml");
      mkdirSync(path.dirname(linkedPath), { recursive: true });
      writeFileSync(path.join(linked, ".cass", "config.json"), JSON.stringify({
        scoring: { minFeedbackForActive: 1, minHelpfulForProven: 1 },
      }));
      if (local) writeFileSync(linkedPath, yaml.stringify(createTestPlaybook([
        createBullet({ id: "b-aaa111", content: "LINKED_ONLY: run branch fixture tests.", scope: "workspace" }),
      ])));
      const mainBefore = readFileSync(f.betaPath, "utf-8");
      const alphaBefore = readFileSync(f.alphaPath, "utf-8");
      const session = f.session("linked", linked, "// [cass: helpful b-aaa111] - useful in this worktree");
      f.discover([{ path: session }]);
      const prompts: string[] = [];
      const result = await f.run(prompt => { prompts.push(prompt); return { deltas: [] }; });
      expect(result.errors).toEqual([]);
      const ownerPath = local ? linkedPath : f.betaPath;
      expect(result.projectResults?.[0]?.playbookPath).toBe(ownerPath);
      expect(readPlaybook(ownerPath).bullets[0].helpfulCount).toBe(1);
      expect(readPlaybook(ownerPath).bullets[0].maturity).toBe("proven");
      expect(prompts.join("\n")).toContain(local ? "LINKED_ONLY" : "BETA_ONLY");
      expect(prompts.join("\n")).not.toContain("ALPHA_ONLY");
      expect(readFileSync(f.alphaPath, "utf-8")).toBe(alphaBefore);
      if (local) expect(readFileSync(f.betaPath, "utf-8")).toBe(mainBefore);
      else expect(existsSync(linkedPath)).toBe(false);
    });
  });

  test("a blocked mixed batch leaves both owners unchanged before publication and retries exactly once", async () => {
    await withWorkspaceReflection(async f => {
      const alpha = f.session("alpha-retry", f.alpha, "// [cass: helpful b-aaa111] - alpha check passed");
      const beta = f.session("beta-retry", f.beta, "// [cass: helpful b-aaa111] - beta check passed");
      f.discover([{ path: alpha }, { path: beta }]);
      const paths = [f.env.playbookPath, f.alphaPath, f.betaPath];
      const before = paths.map(file => readFileSync(file, "utf8"));
      await withLock(f.betaPath, async () => {
        await expect(f.run()).rejects.toThrow("lock");
      });
      const log = new ProcessedLog(getProcessedLogPath());
      await log.load();
      expect(log.has(alpha)).toBe(false);
      expect(log.has(beta)).toBe(false);
      // A lock failure while staging cannot publish any portion of the run.
      // Only a published commit may leave recoverable partial live writes.
      expect(paths.map(file => readFileSync(file, "utf8"))).toEqual(before);
      expect(existsSync(reflectionCommitPendingPath(f.env.playbookPath))).toBe(false);
      expect(readPlaybook(f.alphaPath).bullets[0].helpfulCount).toBe(0);
      expect(readPlaybook(f.betaPath).bullets[0].helpfulCount).toBe(0);
      const result = await f.run();
      expect(result.errors).toEqual([]);
      expect(result.sessionsProcessed).toBe(2);
      expect(readPlaybook(f.alphaPath).bullets[0].helpfulCount).toBe(1);
      expect(readPlaybook(f.betaPath).bullets[0].helpfulCount).toBe(1);
      await log.load();
      expect(log.has(alpha)).toBe(true);
      expect(log.has(beta)).toBe(true);
      expect(readPlaybook(f.env.playbookPath).metadata.totalReflections).toBe(1);
      expect(readPlaybook(f.env.playbookPath).metadata.totalSessionsProcessed).toBe(2);
    });
  });

  test("a repository symlink replaced during reflection keeps the logical playbook owner", async () => {
    await withWorkspaceReflection(async f => {
      const detached = path.join(f.env.home, "detached-beta.yaml");
      renameSync(f.betaPath, detached);
      symlinkSync(detached, f.betaPath);
      const session = f.session("beta-symlink", f.beta, "// [cass: helpful b-aaa111] - verified beta guidance");
      f.discover([{ path: session }]);
      const result = await f.run(() => {
        const next = path.join(f.beta, ".cass", "next-playbook.yaml");
        const playbook = readPlaybook(detached);
        playbook.bullets[0].content = "CURRENT_BETA: use the verified integration command.";
        writeFileSync(next, yaml.stringify(playbook));
        renameSync(next, f.betaPath);
        return { deltas: [] };
      });
      expect(result.errors).toEqual([]);
      expect(result.projectResults?.[0]?.playbookPath).toBe(f.betaPath);
      expect(readPlaybook(f.betaPath).bullets[0].content).toContain("CURRENT_BETA");
      expect(readPlaybook(f.betaPath).bullets[0].helpfulCount).toBe(1);
      expect(readPlaybook(detached).bullets[0].helpfulCount).toBe(0);
      expect(readPlaybook(f.alphaPath).bullets[0].helpfulCount).toBe(0);
    });
  });

  test("automatic sessions with no workspace cannot borrow the launch repository", async () => {
    await withWorkspaceReflection(async f => {
      const before = readFileSync(f.alphaPath, "utf-8");
      const session = f.session("unknown", undefined, "// [cass: helpful b-aaa111] - unknown project context");
      f.discover([{ path: session }]);
      const prompts: string[] = [];
      const result = await f.run(prompt => {
        prompts.push(prompt);
        return { deltas: [{ type: "add", bullet: { content: "Verify assumptions before changing behavior.", category: "debugging", scope: "workspace" } }] };
      });
      expect(result.errors).toEqual([]);
      expect(prompts.join("\n")).not.toContain("ALPHA_ONLY");
      expect(readFileSync(f.alphaPath, "utf-8")).toBe(before);
      expect(result.repoResult).toBeUndefined();
      expect(readPlaybook(f.env.playbookPath).bullets[0].scope).toBe("global");
      expect(result.globalResult?.decisionLog?.some(entry => entry.action === "rejected" && entry.bulletId === "b-aaa111")).toBe(true);
    });
  });

  test("an automatic workspace filter cannot turn a sibling slug match into rule ownership", async () => {
    await withWorkspaceReflection(async f => {
      // The legacy discovery filter accepts /<requested-slug>-... as a
      // possible subdirectory. A sibling name has the same ambiguous form.
      const sibling = `${f.alpha}-old`;
      renameSync(f.beta, sibling);
      const siblingPath = path.join(sibling, ".cass", "playbook.yaml");
      const alphaBefore = readFileSync(f.alphaPath, "utf-8");
      const siblingBefore = readFileSync(siblingPath, "utf-8");
      const session = path.join(f.env.home, ".claude", "projects", slugifyProjectDir(sibling), "legacy.jsonl");
      writeJsonlSession(session, [
        { role: "user", content: "Investigate the old project's release process and record which checks were useful." },
        { role: "assistant", content: "// [cass: helpful b-aaa111] - this legacy transcript has no recorded working directory" },
      ]);
      f.discover([{ path: session }]);
      const prompts: string[] = [];
      const result = await f.run(prompt => { prompts.push(prompt); return { deltas: [] }; }, { workspace: f.alpha });
      // Prove real discovery selected it; the ownership check must protect
      // both repositories even though the filter let the transcript through.
      expect(result.sessionsProcessed).toBe(1);
      expect(result.errors).toEqual([]);
      expect(result.autoOutcome?.inlineFeedbackDeltas).toBe(1);
      expect(result.repoResult).toBeUndefined();
      expect(prompts.join("\n")).not.toContain("ALPHA_ONLY");
      expect(prompts.join("\n")).not.toContain("BETA_ONLY");
      expect(readFileSync(f.alphaPath, "utf-8")).toBe(alphaBefore);
      expect(readFileSync(siblingPath, "utf-8")).toBe(siblingBefore);
      expect(result.globalResult?.decisionLog?.some(entry => entry.action === "rejected" && entry.bulletId === "b-aaa111")).toBe(true);
      const log = new ProcessedLog(getProcessedLogPath(f.alpha));
      await log.load();
      expect(log.get(session)?.recordCount).toBe(2);
    });
  });

  test("an explicit session without metadata can use the requested workspace fallback", async () => {
    await withWorkspaceReflection(async f => {
      const before = readFileSync(f.alphaPath, "utf-8");
      const session = f.session("explicit-unknown", undefined, "// [cass: helpful b-aaa111] - the caller explicitly selected beta");
      const prompts: string[] = [];
      const result = await f.run(prompt => { prompts.push(prompt); return { deltas: [] }; }, {
        session, workspace: f.beta,
      });
      expect(result.errors).toEqual([]);
      expect(result.sessionsProcessed).toBe(1);
      expect(result.repoResult?.applied).toBe(1);
      expect(result.projectResults?.[0]?.playbookPath).toBe(f.betaPath);
      expect(prompts.join("\n")).toContain("BETA_ONLY");
      expect(prompts.join("\n")).not.toContain("ALPHA_ONLY");
      expect(readFileSync(f.alphaPath, "utf-8")).toBe(before);
      expect(readPlaybook(f.betaPath).bullets[0].helpfulCount).toBe(1);
    });
  });
});

function prepareDurableReflection(f: WorkspaceReflectionFixture) {
  writeFileSync(f.env.playbookPath, yaml.stringify(createTestPlaybook([createBullet({
    id: "b-global1", content: "Keep independent feedback attached to its original session.",
    helpfulCount: 0, feedbackEvents: [],
  })])));
  const sessions = [f.alpha, f.beta].map((workspace, index) => f.session(
    `durable-${index}`, workspace,
    "The work is complete and all tests passed. Perfect, thanks!\n" +
      "// [cass: helpful b-aaa111] - the integration check helped\n" +
      "// [cass: helpful b-global1] - preserve the session evidence",
    "Following b-bbb222, investigate the release process and verify the resulting changes carefully.",
  ));
  f.discover(sessions.map(session => ({ path: session })));
  const contents = [
    "Use immutable checksum manifests to track archived exports.",
    "Require independent smoke tests before shipping database schema migrations.",
  ];
  let calls = 0;
  const reflector: LlmShimConfig["reflector"] = (prompt: string) => {
    calls++;
    const index = prompt.includes("ALPHA_ONLY") ? 0 : 1;
    return { deltas: [{
      type: "add", bullet: { content: contents[index]!, category: "testing" },
      reason: "Preserve this validated session proposal across an interrupted commit.",
      sourceSession: sessions[index]!,
    }] };
  };
  const logPath = expandPath(getProcessedLogPath());
  const pendingPath = reflectionCommitPendingPath(f.env.playbookPath);
  const outcomePaths = [f.alphaPath, f.betaPath].map(file => path.join(path.dirname(file), "outcomes.jsonl"));
  const snapshot = () => [f.env.playbookPath, f.alphaPath, f.betaPath, logPath, pendingPath, ...outcomePaths]
    .map(file => [file, existsSync(file) ? readFileSync(file, "utf8") : null]);
  return { sessions, contents, reflector, calls: () => calls, logPath, pendingPath, outcomePaths, snapshot };
}

describe("orchestrateReflection interrupted commit recovery", () => {
  test.each(["first playbook", "later repository", "ledger append", "pending cleanup"])(
    "recovers after %s without repeating model work, feedback, counters, or outcomes",
    async (boundary) => {
      await withWorkspaceReflection(async f => {
        const fixture = prepareDurableReflection(f);
        const failureMessage = `injected interruption at ${boundary}`;
        let interruptions = 0;
        const fail = () => { interruptions++; throw new Error(failureMessage); };
        let restoreFault: () => void;
        if (boundary === "ledger append") {
          const fault = spyOn(ProcessedLog.prototype, "appendCommittedBatch").mockImplementation(async () => fail());
          restoreFault = () => fault.mockRestore();
        } else if (boundary === "pending cleanup") {
          const realUnlink = fs.unlink.bind(fs);
          const fault = spyOn(fs, "unlink").mockImplementation(async file => {
            if (String(file) === fixture.pendingPath) fail();
            return realUnlink(file);
          });
          restoreFault = () => fault.mockRestore();
        } else {
          const target = boundary === "first playbook" ? f.env.playbookPath : f.betaPath;
          const realRename = fs.rename.bind(fs);
          const fault = spyOn(fs, "rename").mockImplementation(async (from, to) => {
            if (String(to) === target) fail();
            return realRename(from, to);
          });
          restoreFault = () => fault.mockRestore();
        }
        try {
          await expect(f.run(fixture.reflector)).rejects.toThrow(failureMessage);
        } finally {
          restoreFault();
        }
        expect(interruptions).toBe(1);
        expect(fixture.calls()).toBe(2);
        expect(existsSync(fixture.pendingPath)).toBe(true);
        expect(fixture.outcomePaths.map(file => existsSync(file))).toEqual([false, false]);

        const manualMark = boundary !== "first playbook";
        if (manualMark) {
          expect(readPlaybook(f.env.playbookPath).bullets.find((b: PlaybookBullet) => b.id === "b-global1").helpfulCount).toBe(2);
          await recordFeedback("b-global1", {
            helpful: true, reason: "A real mark made after the interrupted commit.",
            session: "manual-after-interruption", workspace: f.alpha,
          });
        }
        if (boundary === "later repository") {
          expect(readPlaybook(f.alphaPath).bullets[0].helpfulCount).toBe(1);
          expect(readPlaybook(f.betaPath).bullets[0].helpfulCount).toBe(0);
        }
        const beforeDryRun = fixture.snapshot();
        let unexpectedCalls = 0;
        const neverReflect = () => {
          unexpectedCalls++;
          throw new Error("Recovery must use the frozen proposals without calling the provider.");
        };
        await expect(f.run(neverReflect, { dryRun: true })).rejects.toThrow(/pending|commit|recovery/i);
        expect(fixture.snapshot()).toEqual(beforeDryRun);
        expect(unexpectedCalls).toBe(0);

        // A pending run owns its original ledger, even if the next caller
        // explicitly selects a different workspace and ledger namespace.
        const recovered = await f.run(neverReflect, boundary === "ledger append" ? { workspace: f.beta } : {});
        expect(recovered.errors).toEqual([]);
        expect(recovered.sessionsProcessed).toBe(0);
        expect(recovered.recoveredCommits).toEqual([expect.objectContaining({
          id: expect.any(String), sessionsProcessed: 2,
        })]);
        expect(unexpectedCalls).toBe(0);
        expect(fixture.calls()).toBe(2);
        expect(existsSync(fixture.pendingPath)).toBe(false);
        expect(recovered.autoOutcome?.outcomesRecorded).toBe(2);
        expect(recovered.autoOutcome?.feedbackApplied).toBe(2);

        const global = readPlaybook(f.env.playbookPath);
        expect(global.metadata.totalReflections).toBe(1);
        expect(global.metadata.totalSessionsProcessed).toBe(2);
        expect(global.bullets.filter((b: PlaybookBullet) => fixture.contents.includes(b.content))).toHaveLength(2);
        const shared = global.bullets.find((b: PlaybookBullet) => b.id === "b-global1");
        expect(shared.helpfulCount).toBe(manualMark ? 3 : 2);
        expect(shared.feedbackEvents.map((event: { sessionPath?: string }) => event.sessionPath).sort()).toEqual(
          [...fixture.sessions, ...(manualMark ? ["manual-after-interruption"] : [])].sort(),
        );
        const log = new ProcessedLog(fixture.logPath);
        await log.load();
        for (const [index, file] of [f.alphaPath, f.betaPath].entries()) {
          const rules = readPlaybook(file).bullets as PlaybookBullet[];
          expect(rules.find(b => b.id === "b-aaa111")?.helpfulCount).toBe(1);
          expect(rules.find(b => b.id === "b-aaa111")?.feedbackEvents).toHaveLength(1);
          expect(rules.find(b => b.id === "b-bbb222")?.helpfulCount).toBe(1);
          expect(rules.find(b => b.id === "b-bbb222")?.feedbackEvents).toHaveLength(1);
          expect(log.has(fixture.sessions[index]!)).toBe(true);
          expect(log.get(fixture.sessions[index]!)).toMatchObject({ recordCount: 2, pendingOutcomes: [] });
          const records = readFileSync(fixture.outcomePaths[index]!, "utf8").trim().split("\n").map(line => JSON.parse(line));
          expect(records).toHaveLength(1);
          expect(records[0]).toMatchObject({ sessionId: fixture.sessions[index], rulesUsed: ["b-bbb222"] });
        }
        if (boundary === "ledger append") {
          const otherLog = new ProcessedLog(getProcessedLogPath(f.beta));
          await otherLog.load();
          expect(fixture.sessions.some(session => otherLog.has(session))).toBe(false);
        }
        const afterRecovery = fixture.snapshot();
        const again = await f.run(neverReflect);
        expect(again.errors).toEqual([]);
        expect(again.sessionsProcessed).toBe(0);
        expect(unexpectedCalls).toBe(0);
        expect(fixture.snapshot()).toEqual(afterRecovery);
      });
    },
  );

  test("refuses a changed unapplied playbook before overwriting any current learned state", async () => {
    await withWorkspaceReflection(async f => {
      const fixture = prepareDurableReflection(f);
      const originalGlobal = readFileSync(f.env.playbookPath, "utf8");
      const originalAlpha = readFileSync(f.alphaPath, "utf8");
      const realRename = fs.rename.bind(fs);
      const fault = spyOn(fs, "rename").mockImplementation(async (from, to) => {
        if (String(to) === f.env.playbookPath) throw new Error("injected first replacement failure");
        return realRename(from, to);
      });
      try {
        await expect(f.run(fixture.reflector)).rejects.toThrow("injected first replacement failure");
      } finally {
        fault.mockRestore();
      }
      expect(existsSync(fixture.pendingPath)).toBe(true);
      await recordFeedback("b-aaa111", { helpful: true, session: "newer-manual-mark", workspace: f.beta });
      const beforeRecovery = fixture.snapshot();
      let unexpectedCalls = 0;
      await expect(f.run(() => {
        unexpectedCalls++;
        throw new Error("Conflicting recovery must stop before calling the provider.");
      })).rejects.toThrow(/changed|conflict|modified/i);
      expect(unexpectedCalls).toBe(0);
      expect(fixture.calls()).toBe(2);
      expect(fixture.snapshot()).toEqual(beforeRecovery);
      expect(readFileSync(f.env.playbookPath, "utf8")).toBe(originalGlobal);
      expect(readFileSync(f.alphaPath, "utf8")).toBe(originalAlpha);
      expect(readPlaybook(f.betaPath).bullets[0].helpfulCount).toBe(1);
      expect(readPlaybook(f.betaPath).bullets[0].feedbackEvents[0].sessionPath).toBe("newer-manual-mark");
      const log = new ProcessedLog(fixture.logPath);
      await log.load();
      expect(fixture.sessions.some(session => log.has(session))).toBe(false);
    });
  });
});

interface QueuedOutcomeFixture {
  env: TestEnv;
  config: Config;
  io: LLMIO;
  sessionPath: string;
  logPath: string;
  outcomePath: string;
  repoPath?: string;
  entry: () => Promise<ProcessedEntry>;
  reflectorCalls: () => number;
}

async function withQueuedAutoOutcome(
  check: (fixture: QueuedOutcomeFixture) => Promise<void>,
  options: { repoRule?: boolean; inlineFeedback?: boolean } = {},
): Promise<void> {
  await withIsolatedHome(async (env) => {
    const rules = [createBullet({
      id: "b-global1", content: "Validate exporter output with deterministic tests.",
      helpfulCount: 0, feedbackEvents: [],
    })];
    if (options.inlineFeedback) rules.push(createBullet({
      id: "b-inline1", content: "Keep the fixture data small and explicit.",
      helpfulCount: 0, feedbackEvents: [],
    }));
    writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook(rules)));
    let repoPath: string | undefined;
    if (options.repoRule) {
      const repoRoot = path.join(env.home, "original-project");
      repoPath = path.join(repoRoot, ".cass", "playbook.yaml");
      mkdirSync(path.dirname(repoPath), { recursive: true });
      expect(Bun.spawnSync(["git", "init", "--quiet", repoRoot]).exitCode).toBe(0);
      writeFileSync(repoPath, yaml.stringify(createTestPlaybook([createBullet({
        id: "b-repo222", content: "Check the project exporter schema before release.",
        helpfulCount: 0, feedbackEvents: [],
      })])));
      process.chdir(repoRoot);
    }
    const sessionPath = path.join(env.home, "sessions", "recoverable.jsonl");
    writeJsonlSession(sessionPath, [
      { role: "user", content: `Following b-global1${options.repoRule ? " and b-repo222" : ""}, refactor the exporter and verify the output with deterministic tests.` },
      { role: "assistant", content: `The work is complete and all tests passed. Perfect, thanks!${options.inlineFeedback ? "\n// [cass: helpful b-inline1] - the fixture rule helped" : ""}` },
    ]);
    const config = createTestConfig({
      playbookPath: env.playbookPath, diaryDir: env.diaryDir,
      cassPath: "/__missing__/cass", validationEnabled: false, semanticSearchEnabled: false,
    });
    const outcomePath = path.join(repoPath ? path.dirname(repoPath) : path.dirname(env.playbookPath), "outcomes.jsonl");
    // A directory at the log path causes a deterministic real I/O error.
    // Renaming it later repairs storage without deleting any fixture data.
    mkdirSync(outcomePath);
    const logPath = expandPath(getProcessedLogPath());
    const entry = async () => {
      const log = new ProcessedLog(logPath);
      await log.load();
      const saved = log.get(sessionPath);
      expect(saved).toBeDefined();
      return saved!;
    };
    let calls = 0;
    await withEnv({ CASS_MEMORY_LLM: "none" }, async () => {
      await withLlmShim({ reflector: () => { calls++; return { deltas: [] }; } }, async (io) => {
        const first = await orchestrateReflection(config, { session: sessionPath, io });
        expect(first.sessionsProcessed).toBe(1);
        expect(first.errors).toHaveLength(1);
        expect(first.errors[0]).toContain("Auto-outcome recovery failed");
        expect((await entry()).pendingOutcomes).toHaveLength(1);
        await check({ env, config, io, sessionPath, logPath, outcomePath, repoPath, entry, reflectorCalls: () => calls });
      });
    });
  });
}

describe("orchestrateReflection durable outcome recovery", () => {
  test.each(["same workspace", "recorded project"])("uses the %s policy and current sanitization protections during recovery", async (owner) => {
    await withIsolatedHome(async (env) => {
      writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([createBullet({
        id: "b-global1", content: "Check the exporter with deterministic fixtures.",
        helpfulCount: 0, feedbackEvents: [], maturity: "candidate",
      })])));
      let workspace = env.home;
      if (owner === "recorded project") {
        workspace = path.join(env.home, "recorded-project");
        mkdirSync(path.join(workspace, ".cass"), { recursive: true });
        expect(Bun.spawnSync(["git", "init", "--quiet", workspace]).exitCode).toBe(0);
        writeFileSync(path.join(workspace, ".cass", "config.json"), JSON.stringify({
          scoring: { minFeedbackForActive: 1, minHelpfulForProven: 99 },
          sanitization: { extraPatterns: ["TARGET_PRIVATE"] },
        }));
      }
      const defaults = createTestConfig();
      const config = createTestConfig({
        playbookPath: env.playbookPath, diaryDir: env.diaryDir, cassPath: "/__missing__/cass",
        scoring: { ...defaults.scoring, minFeedbackForActive: owner === "same workspace" ? 1 : 99, minHelpfulForProven: 99 },
        sanitization: { ...defaults.sanitization, enabled: true, extraPatterns: ["RUN_PRIVATE"] },
      });
      const sessionPath = path.join(env.home, "already-processed.jsonl");
      // This record was legitimately prepared under an earlier less strict
      // policy. Recovery must apply the protections configured now.
      const prepared = await prepareOutcome({
        sessionId: sessionPath, workspace, outcome: "success", rulesUsed: ["b-global1"],
        task: "RUN_PRIVATE TARGET_PRIVATE",
      }, { ...config, sanitization: { ...defaults.sanitization, enabled: false, extraPatterns: [] } });
      const logPath = expandPath(getProcessedLogPath());
      await new ProcessedLog(logPath).append({
        sessionPath, processedAt: prepared.recordedAt, deltasGenerated: 0,
        pendingOutcomes: [prepared],
      });

      const result = await orchestrateReflection(config, { session: sessionPath });
      expect(result.errors).toEqual([]);
      expect(result.autoOutcome?.feedbackApplied).toBe(1);
      expect(readPlaybook(env.playbookPath).bullets[0].maturity).toBe("established");
      const recorded = JSON.parse(readFileSync(prepared.path, "utf8").trim());
      expect(recorded.task).not.toContain("RUN_PRIVATE");
      if (owner === "recorded project") expect(recorded.task).not.toContain("TARGET_PRIVATE");
      expect(process.cwd()).toBe(env.home);
    });
  });

  test("replays a failed outcome after repair without repeating reflection or inline feedback, and leaves dry runs unchanged", async () => {
    await withQueuedAutoOutcome(async ({ env, config, io, sessionPath, logPath, outcomePath, entry, reflectorCalls }) => {
      const pending = (await entry()).pendingOutcomes![0]!;
      expect(pending.id).toBeDefined();
      expect(pending.ruleTargets).toEqual([{ ruleId: "b-global1", playbookPath: env.playbookPath }]);
      expect(readPlaybook(env.playbookPath).bullets.find((b: PlaybookBullet) => b.id === "b-inline1").helpfulCount).toBe(1);
      const beforeLog = readFileSync(logPath, "utf8");
      const beforePlaybook = readFileSync(env.playbookPath, "utf8");
      renameSync(outcomePath, `${outcomePath}.blocked-directory`);

      const dryRun = await orchestrateReflection(config, { session: sessionPath, io, dryRun: true });
      expect(dryRun.errors).toEqual([]);
      expect(readFileSync(logPath, "utf8")).toBe(beforeLog);
      expect(readFileSync(env.playbookPath, "utf8")).toBe(beforePlaybook);
      expect(existsSync(outcomePath)).toBe(false);

      const recovered = await orchestrateReflection(config, { session: sessionPath, io });
      expect(recovered.errors).toEqual([]);
      expect(recovered.sessionsProcessed).toBe(0);
      expect(recovered.autoOutcome?.feedbackApplied).toBe(1);
      expect(reflectorCalls()).toBe(1);
      expect((await entry()).pendingOutcomes).toEqual([]);
      const records = readFileSync(outcomePath, "utf8").trim().split("\n").map(line => JSON.parse(line));
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ id: pending.id, recordedAt: pending.recordedAt });
      const saved = readPlaybook(env.playbookPath);
      expect(saved.bullets.find((b: PlaybookBullet) => b.id === "b-global1").helpfulCount).toBe(1);
      expect(saved.bullets.find((b: PlaybookBullet) => b.id === "b-inline1").helpfulCount).toBe(1);

      const again = await orchestrateReflection(config, { session: sessionPath, io });
      expect(again.errors).toEqual([]);
      expect(again.autoOutcome).toBeUndefined();
      expect(readFileSync(outcomePath, "utf8").trim().split("\n")).toHaveLength(1);
    }, { inlineFeedback: true });
  });

  test("retries an interrupted acknowledgement without duplicating the persisted record or feedback", async () => {
    await withQueuedAutoOutcome(async ({ env, config, io, sessionPath, logPath, outcomePath, entry, reflectorCalls }) => {
      const original = (await entry()).pendingOutcomes;
      renameSync(outcomePath, `${outcomePath}.blocked-directory`);
      const interrupted = await withLock(logPath, () => orchestrateReflection(config, { session: sessionPath, io }));
      expect(interrupted.errors.some(message => message.includes("acknowledgement failed"))).toBe(true);
      expect((await entry()).pendingOutcomes).toEqual(original);
      expect(readPlaybook(env.playbookPath).bullets[0].helpfulCount).toBe(1);

      const retried = await orchestrateReflection(config, { session: sessionPath, io });
      expect(retried.errors).toEqual([]);
      expect(retried.autoOutcome?.feedbackApplied).toBe(0);
      expect((await entry()).pendingOutcomes).toEqual([]);
      expect(readPlaybook(env.playbookPath).bullets[0].helpfulCount).toBe(1);
      expect(readFileSync(outcomePath, "utf8").trim().split("\n")).toHaveLength(1);
      expect(reflectorCalls()).toBe(1);
    });
  });

  test("recovers feedback after one playbook saved and a second playbook was temporarily locked", async () => {
    await withQueuedAutoOutcome(async ({ env, config, io, sessionPath, outcomePath, repoPath, entry, reflectorCalls }) => {
      renameSync(outcomePath, `${outcomePath}.blocked-directory`);
      const interrupted = await withLock(repoPath!, () => orchestrateReflection(config, { session: sessionPath, io }));
      expect(interrupted.errors.some(message => message.includes("Auto-outcome recovery failed"))).toBe(true);
      expect(readPlaybook(env.playbookPath).bullets[0].helpfulCount).toBe(1);
      expect(readPlaybook(repoPath!).bullets[0].helpfulCount).toBe(0);
      expect((await entry()).pendingOutcomes).toHaveLength(1);

      const recovered = await orchestrateReflection(config, { session: sessionPath, io });
      expect(recovered.errors).toEqual([]);
      expect(recovered.autoOutcome?.feedbackApplied).toBe(1);
      expect(readPlaybook(env.playbookPath).bullets[0].helpfulCount).toBe(1);
      expect(readPlaybook(repoPath!).bullets[0].helpfulCount).toBe(1);
      expect((await entry()).pendingOutcomes).toEqual([]);
      expect(readFileSync(outcomePath, "utf8").trim().split("\n")).toHaveLength(1);
      expect(reflectorCalls()).toBe(1);
    }, { repoRule: true });
  });

  test("preserves old pending work when the transcript grows and queues the new segment separately", async () => {
    await withQueuedAutoOutcome(async ({ env, config, io, sessionPath, outcomePath, entry, reflectorCalls }) => {
      const firstId = (await entry()).pendingOutcomes![0]!.id;
      appendJsonl(sessionPath, [
        { role: "user", content: "Apply b-global1 again to validate the new exporter format added in this continuation." },
        { role: "assistant", content: "The new format is complete and all tests passed. Perfect!" },
      ]);
      const grown = await orchestrateReflection(config, { session: sessionPath, io });
      expect(grown.sessionsProcessed).toBe(1);
      expect(grown.errors).toHaveLength(2);
      const queued = await entry();
      expect(queued.recordCount).toBe(4);
      expect(queued.pendingOutcomes).toHaveLength(2);
      expect(queued.pendingOutcomes![0]!.id).toBe(firstId);
      expect(queued.pendingOutcomes![1]!.id).not.toBe(firstId);

      renameSync(outcomePath, `${outcomePath}.blocked-directory`);
      const recovered = await orchestrateReflection(config, { session: sessionPath, io });
      expect(recovered.errors).toEqual([]);
      expect(recovered.autoOutcome?.feedbackApplied).toBe(2);
      expect(readPlaybook(env.playbookPath).bullets[0].helpfulCount).toBe(2);
      expect((await entry()).pendingOutcomes).toEqual([]);
      expect(readFileSync(outcomePath, "utf8").trim().split("\n")).toHaveLength(2);
      expect(reflectorCalls()).toBe(2);
    });
  });

  test.each(["rewritten transcript", "failed reflection", "short continuation", "self-call continuation"])("retains pending outcomes through a %s", async (kind) => {
    await withQueuedAutoOutcome(async ({ env, config, io, sessionPath, entry }) => {
      const original = (await entry()).pendingOutcomes;
      if (kind === "rewritten transcript") {
        writeJsonlSession(sessionPath, [{ role: "user", content: "A compacted replacement for the already reflected transcript." }]);
      } else {
        appendJsonl(sessionPath, [{
          role: "user",
          content: kind === "short continuation" ? "ok"
            : kind === "self-call continuation" ? tagCmSubprocessPrompt("Reflect on the previous session and its rules.")
            : "Continue the exporter refactoring with another substantial task that must reach reflection.",
        }]);
      }
      const result = kind === "failed reflection"
        ? await withLlmShim({ errors: { reflector: new Error("temporary provider failure") } }, failedIo =>
          orchestrateReflection(config, { session: sessionPath, io: failedIo }))
        : await orchestrateReflection(config, { session: sessionPath, io });
      expect(result.errors.some(message => message.includes("Auto-outcome recovery failed"))).toBe(true);
      expect((await entry()).pendingOutcomes).toEqual(original);
      if (kind === "failed reflection") expect((await entry()).status).toBe("failed");
      expect(readPlaybook(env.playbookPath).bullets[0].helpfulCount).toBe(0);
    });
  });

  test("recovers an unchanged legacy entry before the no-eligible-session return", async () => {
    await withQueuedAutoOutcome(async ({ config, io, sessionPath, logPath, outcomePath, entry, reflectorCalls }) => {
      const saved = await entry();
      await new ProcessedLog(logPath).append({ ...saved, recordCount: undefined, lastRecordHash: undefined });
      renameSync(outcomePath, `${outcomePath}.blocked-directory`);
      const recovered = await orchestrateReflection(config, { session: sessionPath, io });
      expect(recovered.sessionsProcessed).toBe(0);
      expect(recovered.errors).toEqual([]);
      expect(recovered.autoOutcome?.feedbackApplied).toBe(1);
      expect((await entry()).pendingOutcomes).toEqual([]);
      expect(reflectorCalls()).toBe(1);
    });
  });

  test("replays against the original repository after the caller changes working directory", async () => {
    await withQueuedAutoOutcome(async ({ env, config, io, sessionPath, outcomePath, repoPath, entry }) => {
      const otherRoot = path.join(env.home, "other-project");
      const otherPlaybook = path.join(otherRoot, ".cass", "playbook.yaml");
      mkdirSync(path.dirname(otherPlaybook), { recursive: true });
      expect(Bun.spawnSync(["git", "init", "--quiet", otherRoot]).exitCode).toBe(0);
      writeFileSync(otherPlaybook, yaml.stringify(createTestPlaybook([createBullet({
        id: "b-repo222", content: "An unrelated rule with the same ID in another project.",
        helpfulCount: 0, feedbackEvents: [],
      })])));
      renameSync(outcomePath, `${outcomePath}.blocked-directory`);
      process.chdir(otherRoot);

      const recovered = await orchestrateReflection(config, { session: sessionPath, io });
      expect(recovered.errors).toEqual([]);
      expect(readPlaybook(repoPath!).bullets[0].helpfulCount).toBe(1);
      expect(readPlaybook(otherPlaybook).bullets[0].helpfulCount).toBe(0);
      expect(existsSync(path.join(otherRoot, ".cass", "outcomes.jsonl"))).toBe(false);
      expect((await entry()).pendingOutcomes).toEqual([]);
    }, { repoRule: true });
  });

  test("preparation failure stops before curation and before advancing the watermark", async () => {
    await withIsolatedHome(async (env) => {
      writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([createBullet({
        id: "b-global1", content: "Validate exporter output with deterministic tests.",
        helpfulCount: 0, feedbackEvents: [],
      })])));
      const sessionPath = path.join(env.home, "sessions", "prepare-fails.jsonl");
      writeJsonlSession(sessionPath, [
        { role: "user", content: "Following b-global1, refactor the exporter and validate the output carefully." },
        { role: "assistant", content: "The work is complete and all tests passed. Perfect!" },
      ]);
      mkdirSync(path.join(env.home, ".cass-memory", "context-log.jsonl"));
      const config = createTestConfig({
        playbookPath: env.playbookPath, diaryDir: env.diaryDir,
        cassPath: "/__missing__/cass", validationEnabled: false,
      });
      const before = readFileSync(env.playbookPath, "utf8");
      await withEnv({ CASS_MEMORY_LLM: "none" }, async () => {
        await withLlmShim({ reflector: { deltas: [{ type: "helpful", bulletId: "b-global1", sourceSession: sessionPath }] } }, async (io) => {
          const result = await orchestrateReflection(config, { session: sessionPath, io });
          expect(result.errors.some(message => message.includes("Auto-outcome preparation failed"))).toBe(true);
          expect(result.sessionsProcessed).toBe(0);
          expect(readFileSync(env.playbookPath, "utf8")).toBe(before);
          const processed = new ProcessedLog(expandPath(getProcessedLogPath()));
          await processed.load();
          expect(processed.has(sessionPath)).toBe(false);
        });
      });
    });
  });
});
