import { describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyOutcomeFeedback, loadOutcomes, persistOutcomeRecord, prepareOutcome, type OutcomeRecord } from "../src/outcome.js";
import { loadPlaybook, savePlaybook } from "../src/playbook.js";
import type { TranscriptRuleEvidence } from "../src/types.js";
import { createTestBullet, createTestConfig, createTestPlaybook } from "./helpers/factories.js";
import { withTempCassHome } from "./helpers/temp.js";

async function withTempPlaybook(run: (playbookPath: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cass-outcome-"));
  try {
    await run(path.join(dir, "playbook.yaml"));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("applyOutcomeFeedback", () => {
  test("applies helpful feedback for success outcome", async () => {
    await withTempPlaybook(async (playbookPath) => {
      const bullet = createTestBullet({ id: "b-1" });
      await savePlaybook(
        {
          schema_version: 2,
          name: "pb",
          description: "",
          metadata: {
            createdAt: new Date().toISOString(),
            totalReflections: 0,
            totalSessionsProcessed: 0,
          },
          deprecatedPatterns: [],
          bullets: [bullet],
        },
        playbookPath,
      );

      const outcome: OutcomeRecord = {
        sessionId: "/tmp/session.jsonl",
        outcome: "success",
        rulesUsed: ["b-1"],
        recordedAt: new Date().toISOString(),
        path: playbookPath,
      };

      const result = await applyOutcomeFeedback(outcome, createTestConfig({ playbookPath }));
      expect(result.applied).toBe(1);
      const content = await fs.readFile(playbookPath, "utf-8");
      expect(content).toContain("feedbackEvents");
    });
  });

  test("is idempotent when re-applying the same outcome record", async () => {
    await withTempPlaybook(async (playbookPath) => {
      const bullet = createTestBullet({ id: "b-idem" });
      await savePlaybook(
        {
          schema_version: 2,
          name: "pb",
          description: "",
          metadata: {
            createdAt: new Date().toISOString(),
            totalReflections: 0,
            totalSessionsProcessed: 0,
          },
          deprecatedPatterns: [],
          bullets: [bullet],
        },
        playbookPath,
      );

      const recordedAt = new Date().toISOString();
      const outcome: OutcomeRecord = {
        sessionId: "/tmp/session-idempotent",
        outcome: "success",
        rulesUsed: ["b-idem"],
        recordedAt,
        path: playbookPath,
      };

      const cfg = createTestConfig({ playbookPath });
      const first = await applyOutcomeFeedback(outcome, cfg);
      expect(first.applied).toBe(1);

      const second = await applyOutcomeFeedback(outcome, cfg);
      expect(second.applied).toBe(0);
    });
  });

  test("uses context log to fill missing rulesUsed", async () => {
    await withTempPlaybook(async (playbookPath) => {
      const bullet = createTestBullet({ id: "b-ctx" });
      await savePlaybook(
        {
          schema_version: 2,
          name: "pb",
          description: "",
          metadata: {
            createdAt: new Date().toISOString(),
            totalReflections: 0,
            totalSessionsProcessed: 0,
          },
          deprecatedPatterns: [],
          bullets: [bullet],
        },
        playbookPath,
      );

      // Write context log to repo-local .cass to be discovered by applyOutcomeFeedback
      const prevCwd = process.cwd();
      const tempRepo = path.dirname(playbookPath);
      process.chdir(tempRepo);

      // applyOutcomeFeedback resolves repo-local .cass/ via git root, so create a tiny git repo.
      const gitInit = Bun.spawn(["git", "init"], {
        cwd: tempRepo,
        stdout: "ignore",
        stderr: "ignore",
      });
      const gitExit = await gitInit.exited;
      if (gitExit !== 0) {
        throw new Error("git init failed in temp test repo");
      }

      const cassDir = path.join(tempRepo, ".cass");
      await fs.mkdir(cassDir, { recursive: true });
      const contextLogPath = path.join(cassDir, "context-log.jsonl");
      await fs.writeFile(
        contextLogPath,
        JSON.stringify({
          task: "test",
          ruleIds: ["b-ctx"],
          antiPatternIds: [],
          session: "/tmp/session-context",
          timestamp: new Date().toISOString(),
          source: "test",
        }) + "\n",
      );

      const outcome: OutcomeRecord = {
        sessionId: "/tmp/session-context",
        outcome: "success",
        rulesUsed: [],
        recordedAt: new Date().toISOString(),
        path: playbookPath,
      };

      const cfg = createTestConfig({ playbookPath });
      try {
        const result = await applyOutcomeFeedback(outcome, cfg);
        expect(result.applied).toBe(1);
      } finally {
        process.chdir(prevCwd);
      }
    });
  });
});

describe("durable outcome identity and ownership", () => {
  test("prepared outcomes honor the caller's scoring and sanitization configuration", async () => {
    await withTempCassHome(async env => {
      const config = createTestConfig({ playbookPath: path.join(env.cassMemoryDir, "playbook.yaml") });
      config.scoring.minFeedbackForActive = 1;
      config.sanitization.extraPatterns = ["PRIVATE_POLICY_VALUE"];
      await savePlaybook(createTestPlaybook([createTestBullet({ id: "b-policy" })]), config.playbookPath);
      const record = await prepareOutcome({
        sessionId: "policy", outcome: "success", rulesUsed: ["b-policy"], workspace: env.home,
        notes: "PRIVATE_POLICY_VALUE",
      }, config);
      expect(record.notes).not.toContain("PRIVATE_POLICY_VALUE");
      await persistOutcomeRecord(record, config);
      expect((await applyOutcomeFeedback(record, config)).applied).toBe(1);
      const bullet = (await loadPlaybook(config.playbookPath)).bullets[0];
      expect(bullet.helpfulCount).toBe(1);
      expect(bullet.maturity).toBe("established");
    });
  });

  for (const owner of ["global", "repository"] as const) {
    test(`${owner} playbook symlinks retain attribution after an atomic curation save`, async () => {
      await withTempCassHome(async env => {
        const workspace = path.join(env.home, "project");
        await fs.mkdir(workspace);
        if (owner === "repository") {
          const initialized = Bun.spawn(["git", "init", "-q", workspace], { stdout: "ignore", stderr: "pipe" });
          expect(await initialized.exited).toBe(0);
          await fs.mkdir(path.join(workspace, ".cass"));
        }
        const config = createTestConfig({ playbookPath: path.join(env.cassMemoryDir, "playbook.yaml") });
        const logicalPath = owner === "global" ? config.playbookPath : path.join(workspace, ".cass", "playbook.yaml");
        const originalPath = path.join(env.home, "original-playbook.yaml");
        await savePlaybook(createTestPlaybook([createTestBullet({ id: "b-linked" })]), originalPath);
        await fs.symlink(originalPath, logicalPath);
        const record = await prepareOutcome({
          sessionId: "linked", outcome: "success", rulesUsed: ["b-linked"], workspace,
        }, config);
        expect(record.ruleTargets).toEqual([{ ruleId: "b-linked", playbookPath: logicalPath }]);
        // Normal curation saves atomically at the configured address, replacing
        // the final symlink. The old target must not receive later feedback.
        await savePlaybook(await loadPlaybook(logicalPath), logicalPath);
        expect((await fs.lstat(logicalPath)).isSymbolicLink()).toBe(false);
        await persistOutcomeRecord(record, config);
        expect((await applyOutcomeFeedback(record, config)).applied).toBe(1);
        expect((await applyOutcomeFeedback(record, config)).applied).toBe(0);
        expect((await loadPlaybook(logicalPath)).bullets[0].helpfulCount).toBe(1);
        expect((await loadPlaybook(originalPath)).bullets[0].helpfulCount).toBe(0);
      });
    });
  }

  test("different events at the same timestamp count once each across log and feedback replay", async () => {
    await withTempCassHome(async env => {
      const config = createTestConfig({ playbookPath: path.join(env.cassMemoryDir, "playbook.yaml") });
      await savePlaybook(createTestPlaybook([createTestBullet({ id: "b-stable" })]), config.playbookPath);
      const first = await prepareOutcome({
        sessionId: "same-session", outcome: "success", rulesUsed: ["b-stable"], workspace: env.home,
      }, config);
      const second = { ...first, id: `${first.id}-second` };
      await Promise.all([
        persistOutcomeRecord(first, config),
        persistOutcomeRecord(first, config),
        persistOutcomeRecord(second, config),
      ]);
      const records = await loadOutcomes(config, 100, env.home);
      expect(records).toHaveLength(2);
      expect(new Set(records.map(record => record.id)).size).toBe(2);
      expect((await applyOutcomeFeedback([first, second, first], config)).applied).toBe(2);
      expect((await applyOutcomeFeedback(records, config)).applied).toBe(0);
      const bullet = (await loadPlaybook(config.playbookPath)).bullets[0];
      expect(bullet.helpfulCount).toBe(2);
      expect(bullet.feedbackEvents.map(event => event.outcomeId).sort()).toEqual([first.id!, second.id!].sort());
    });
  });

  test("an outcome ID cannot be reused with a different verdict or destination", async () => {
    await withTempCassHome(async env => {
      const config = createTestConfig({ playbookPath: path.join(env.cassMemoryDir, "playbook.yaml") });
      const record = await prepareOutcome({ sessionId: "s", outcome: "success", workspace: env.home }, config);
      await persistOutcomeRecord(record, config);
      const before = await fs.readFile(record.path, "utf8");
      await expect(persistOutcomeRecord({ ...record, outcome: "failure" }, config)).rejects.toThrow("different event");
      expect(await fs.readFile(record.path, "utf8")).toBe(before);
    });
  });

  test("recovery preserves a truncated log tail and appends a separately readable event", async () => {
    await withTempCassHome(async env => {
      const config = createTestConfig({ playbookPath: path.join(env.cassMemoryDir, "playbook.yaml") });
      const record = await prepareOutcome({ sessionId: "s", outcome: "success", workspace: env.home }, config);
      const tail = '{"id":"interrupted';
      await fs.writeFile(record.path, tail);
      await persistOutcomeRecord(record, config);
      await persistOutcomeRecord(record, config);
      const lines = (await fs.readFile(record.path, "utf8")).split("\n");
      expect(lines).toHaveLength(3);
      expect(lines[0]).toBe(tail);
      expect(JSON.parse(lines[1])).toEqual(JSON.parse(JSON.stringify(record)));
      expect(lines[2]).toBe("");
      expect((await loadOutcomes(config, 100, env.home)).map(value => value.id)).toEqual([record.id]);
    });
  });

  for (const failedFlush of ["file", ...(process.platform === "win32" ? [] : ["directory"])]) {
    test(`reflushes a visible outcome after an uncertain ${failedFlush} flush without appending it again`, async () => {
      await withTempCassHome(async env => {
        const config = createTestConfig({ playbookPath: path.join(env.cassMemoryDir, "playbook.yaml") });
        const record = await prepareOutcome({ sessionId: "uncertain", outcome: "success", workspace: env.home }, config);
        const originalOpen = fs.open.bind(fs);
        const restoreHandles: Array<() => void> = [];
        let recordOpened = false;
        let failing = true;
        let flushes = 0;
        const openSpy = spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
          const handle = await originalOpen(...args);
          if (String(args[0]) === record.path) recordOpened = true;
          if (recordOpened && String(args[0]) === (failedFlush === "file" ? record.path : path.dirname(record.path))) {
            const sync = handle.sync.bind(handle);
            const syncSpy = spyOn(handle, "sync").mockImplementation(async () => {
              flushes++;
              if (failing) throw new Error(`injected outcome ${failedFlush} flush failure`);
              await sync();
            });
            restoreHandles.push(() => syncSpy.mockRestore());
          }
          return handle;
        });
        try {
          await expect(persistOutcomeRecord(record, config)).rejects.toThrow("flush failure");
          const visible = await fs.readFile(record.path, "utf8");
          expect(JSON.parse(visible.trim()).id).toBe(record.id);
          await expect(persistOutcomeRecord(record, config)).rejects.toThrow("flush failure");
          expect(await fs.readFile(record.path, "utf8")).toBe(visible);
          failing = false;
          expect((await persistOutcomeRecord(record, config)).id).toBe(record.id);
          expect(flushes).toBeGreaterThanOrEqual(3);
          expect(await fs.readFile(record.path, "utf8")).toBe(visible);
          expect((await loadOutcomes(config, 100, env.home)).map(value => value.id)).toEqual([record.id]);
        } finally {
          openSpy.mockRestore();
          for (const restore of restoreHandles) restore();
        }
      });
    });
  }

  test.skipIf(process.platform === "win32")("retries a newly created outcome directory whose ancestor flush failed", async () => {
    await withTempCassHome(async env => {
      const config = createTestConfig({ playbookPath: path.join(env.cassMemoryDir, "playbook.yaml") });
      const record = await prepareOutcome({ sessionId: "new-directory", outcome: "success", workspace: env.home }, config);
      await fs.rename(env.cassMemoryDir, `${env.cassMemoryDir}.held`);
      const originalOpen = fs.open.bind(fs);
      const restoreHandles: Array<() => void> = [];
      let failing = true;
      let flushes = 0;
      const openSpy = spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        const handle = await originalOpen(...args);
        if (String(args[0]) === env.home) {
          const sync = handle.sync.bind(handle);
          const syncSpy = spyOn(handle, "sync").mockImplementation(async () => {
            flushes++;
            if (failing) throw new Error("injected outcome ancestor flush failure");
            await sync();
          });
          restoreHandles.push(() => syncSpy.mockRestore());
        }
        return handle;
      });
      try {
        await expect(persistOutcomeRecord(record, config)).rejects.toThrow("ancestor flush failure");
        expect((await fs.stat(env.cassMemoryDir)).isDirectory()).toBe(true);
        await expect(fs.stat(record.path)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(persistOutcomeRecord(record, config)).rejects.toThrow("ancestor flush failure");
        failing = false;
        await persistOutcomeRecord(record, config);
        expect(flushes).toBe(3);
        expect((await loadOutcomes(config, 100, env.home)).map(value => value.id)).toEqual([record.id]);
      } finally {
        openSpy.mockRestore();
        for (const restore of restoreHandles) restore();
      }
    });
  });

  test("context enrichment cannot select another plain workspace from a shared global log", async () => {
    await withTempCassHome(async env => {
      const firstWorkspace = path.join(env.home, "first");
      const secondWorkspace = path.join(env.home, "second");
      await fs.mkdir(firstWorkspace);
      await fs.mkdir(secondWorkspace);
      const config = createTestConfig({ playbookPath: path.join(env.cassMemoryDir, "playbook.yaml") });
      await savePlaybook(createTestPlaybook([
        createTestBullet({ id: "b-first" }), createTestBullet({ id: "b-second" }),
      ]), config.playbookPath);
      const contextPath = path.join(env.cassMemoryDir, "context-log.jsonl");
      await fs.writeFile(contextPath, [
        { session: "shared", workspace: secondWorkspace, ruleIds: ["b-second"], timestamp: "2026-01-01T00:00:00Z" },
        { session: "shared", workspace: firstWorkspace, ruleIds: ["b-first"], timestamp: "2026-01-02T00:00:00Z" },
      ].map(value => JSON.stringify(value)).join("\n") + "\n");
      const record = await prepareOutcome({ sessionId: "shared", outcome: "success", workspace: secondWorkspace }, config);
      expect(record.rulesUsed).toEqual(["b-second"]);
      expect(record.autoGraded).toBe(true);
      // A newer context request must not change the already-prepared event.
      await fs.appendFile(contextPath, JSON.stringify({
        session: "shared", workspace: secondWorkspace, ruleIds: ["b-first"], timestamp: "2026-01-03T00:00:00Z",
      }) + "\n");
      await applyOutcomeFeedback(record, config);
      expect((await loadPlaybook(config.playbookPath)).bullets.map(bullet => bullet.helpfulCount)).toEqual([0, 1]);
    });
  });

  test("an unresolved ID cannot credit a rule created after the outcome", async () => {
    await withTempCassHome(async env => {
      const config = createTestConfig({ playbookPath: path.join(env.cassMemoryDir, "playbook.yaml") });
      const record = await prepareOutcome({
        sessionId: "s", outcome: "success", rulesUsed: ["b-later"], workspace: env.home,
      }, config);
      await savePlaybook(createTestPlaybook([createTestBullet({ id: "b-later" })]), config.playbookPath);
      expect(await applyOutcomeFeedback(record, config)).toEqual({ applied: 0, missing: ["b-later"] });
      expect((await loadPlaybook(config.playbookPath)).bullets[0].helpfulCount).toBe(0);
    });
  });

  test("a temporarily unavailable recorded owner rejects and can be retried", async () => {
    await withTempCassHome(async env => {
      const config = createTestConfig({ playbookPath: path.join(env.cassMemoryDir, "playbook.yaml") });
      await savePlaybook(createTestPlaybook([createTestBullet({ id: "b-recover" })]), config.playbookPath);
      const record = await prepareOutcome({
        sessionId: "s", outcome: "success", rulesUsed: ["b-recover"], workspace: env.home,
      }, config);
      const held = path.join(env.cassMemoryDir, "held-playbook.yaml");
      await fs.rename(config.playbookPath, held);
      await expect(applyOutcomeFeedback(record, config)).rejects.toThrow("unavailable");
      await fs.rename(held, config.playbookPath);
      expect((await applyOutcomeFeedback(record, config)).applied).toBe(1);
      expect((await applyOutcomeFeedback(record, config)).applied).toBe(0);
    });
  });

  test("a stored target outside the recorded workspace cannot mutate another playbook", async () => {
    await withTempCassHome(async env => {
      const config = createTestConfig({ playbookPath: path.join(env.cassMemoryDir, "playbook.yaml") });
      const foreignPath = path.join(env.home, "unrelated.yaml");
      await savePlaybook(createTestPlaybook([createTestBullet({ id: "b-foreign" })]), foreignPath);
      const record = await prepareOutcome({
        sessionId: "s", outcome: "success", rulesUsed: ["b-foreign"], workspace: env.home,
      }, config);
      record.ruleTargets = [{ ruleId: "b-foreign", playbookPath: foreignPath }];
      await expect(applyOutcomeFeedback(record, config)).rejects.toThrow("does not belong");
      expect((await loadPlaybook(foreignPath)).bullets[0].helpfulCount).toBe(0);
    });
  });
});

describe("ambiguous outcome rule IDs", () => {
  for (const owner of ["global", "repository"] as const) {
    test(`preflights an ambiguous ${owner} rule before changing any requested playbook`, async () => {
      await withTempCassHome(async env => {
        const workspace = path.join(env.home, "project");
        const initialized = Bun.spawnSync(["git", "init", "--quiet", "--initial-branch=main", workspace]);
        expect(initialized.exitCode).toBe(0);
        const globalPath = env.playbookPath;
        const repoPath = path.join(workspace, ".cass", "playbook.yaml");
        const ambiguousPath = owner === "global" ? globalPath : repoPath;
        const otherPath = owner === "global" ? repoPath : globalPath;
        const config = createTestConfig({ playbookPath: globalPath });
        const ambiguous = createTestPlaybook([
          createTestBullet({
            id: "b-ambiguous", content: "Preserve the first distinct legacy instruction.",
            helpfulCount: 1, sourceSessions: ["earlier-session"],
            feedbackEvents: [{ type: "helpful", timestamp: "2026-10-28T12:00:00Z", sessionPath: "earlier-session" }],
          }),
          createTestBullet({ id: "b-ambiguous", content: "Preserve the second distinct legacy instruction." }),
          createTestBullet({ id: "b-neighbor", content: "This unique rule shares the ambiguous playbook." }),
        ]);
        await savePlaybook(ambiguous, ambiguousPath);
        await savePlaybook(createTestPlaybook([createTestBullet({ id: "b-independent" })]), otherPath);
        const record = await prepareOutcome({
          sessionId: "ambiguous-outcome", outcome: "success", workspace,
          // The other destination appears first, so per-file validation alone
          // would apply it before discovering the later ambiguous ID.
          rulesUsed: ["b-independent", "b-neighbor", "b-ambiguous"],
        }, config);
        await persistOutcomeRecord(record, config);
        const blockedPath = path.join(path.dirname(ambiguousPath), "blocked.log");
        await fs.writeFile(blockedPath, JSON.stringify({
          id: "b-blocked", content: "Retain blocked state.", reason: "unsafe", forgottenAt: "2026-10-28T12:00:00Z",
        }) + "\n");
        const paths = [globalPath, repoPath, blockedPath, record.path];
        const before = await Promise.all(paths.map(file => fs.readFile(file)));

        await expect(applyOutcomeFeedback(record, config)).rejects.toThrow(/ambiguous.*id/i);
        expect(await Promise.all(paths.map(file => fs.readFile(file)))).toEqual(before);

        // A deliberate ID correction makes the same persisted event retryable;
        // no rule or its existing feedback was dropped to resolve the ambiguity.
        const corrected = await loadPlaybook(ambiguousPath);
        corrected.bullets[1].id = "b-resolved-second-rule";
        await savePlaybook(corrected, ambiguousPath);
        expect(await applyOutcomeFeedback(record, config)).toEqual({ applied: 3, missing: [] });
        expect(await applyOutcomeFeedback(record, config)).toEqual({ applied: 0, missing: [] });
        const updated = await loadPlaybook(ambiguousPath);
        expect(updated.bullets.map(bullet => bullet.helpfulCount)).toEqual([2, 0, 1]);
        expect(updated.bullets[0].feedbackEvents[0]).toEqual(ambiguous.bullets[0].feedbackEvents[0]);
        expect(updated.bullets[1]).toEqual(corrected.bullets[1]);
        expect((await loadPlaybook(otherPath)).bullets[0].helpfulCount).toBe(1);
        expect(await fs.readFile(blockedPath)).toEqual(before[2]);
        expect(await fs.readFile(record.path)).toEqual(before[3]);
      });
    });
  }

  test("a unique repository override ignores shadowed global duplicates and preserves unrelated duplicates", async () => {
    await withTempCassHome(async env => {
      const workspace = path.join(env.home, "project");
      const initialized = Bun.spawnSync(["git", "init", "--quiet", "--initial-branch=main", workspace]);
      expect(initialized.exitCode).toBe(0);
      const config = createTestConfig({ playbookPath: env.playbookPath });
      await savePlaybook(createTestPlaybook([
        createTestBullet({ id: "b-shadowed", content: "First preserved global instruction." }),
        createTestBullet({ id: "b-shadowed", content: "Second preserved global instruction." }),
      ]), config.playbookPath);
      const repoPath = path.join(workspace, ".cass", "playbook.yaml");
      await savePlaybook(createTestPlaybook([
        createTestBullet({ id: "b-shadowed", content: "The unique repository override receives this feedback." }),
        createTestBullet({ id: "b-unrelated", content: "First unrelated repository instruction." }),
        createTestBullet({ id: "b-unrelated", content: "Second unrelated repository instruction." }),
      ]), repoPath);
      const globalBefore = await fs.readFile(config.playbookPath);
      const repoBefore = await loadPlaybook(repoPath);
      const record = await prepareOutcome({
        sessionId: "repository-override", outcome: "success", rulesUsed: ["b-shadowed"], workspace,
      }, config);
      expect(record.ruleTargets).toEqual([{ ruleId: "b-shadowed", playbookPath: repoPath }]);
      expect(await applyOutcomeFeedback(record, config)).toEqual({ applied: 1, missing: [] });
      const updated = await loadPlaybook(repoPath);
      expect(updated.bullets[0].helpfulCount).toBe(1);
      expect(updated.bullets.slice(1)).toEqual(repoBefore.bullets.slice(1));
      expect(await fs.readFile(config.playbookPath)).toEqual(globalBefore);
    });
  });

  test("repository-only batches acquire locks in the same code-unit order as reflection", async () => {
    await withTempCassHome(async env => {
      const config = createTestConfig({ playbookPath: env.playbookPath });
      await savePlaybook(createTestPlaybook([]), config.playbookPath);
      const records: OutcomeRecord[] = [];
      const targets: string[] = [];
      for (const name of ["alpha", "Zulu"]) {
        const workspace = path.join(env.home, name);
        const initialized = Bun.spawnSync(["git", "init", "--quiet", "--initial-branch=main", workspace]);
        expect(initialized.exitCode).toBe(0);
        const target = path.join(workspace, ".cass", "playbook.yaml");
        targets.push(target);
        await savePlaybook(createTestPlaybook([createTestBullet({ id: "b-lock-order" })]), target);
        records.push(await prepareOutcome({
          sessionId: name, outcome: "success", rulesUsed: ["b-lock-order"], workspace,
        }, config));
      }
      const acquired: string[] = [];
      const targetLocks = new Set(targets.map(target => `${target}.lock.d`));
      const realMkdir = fs.mkdir.bind(fs);
      const mkdirSpy = spyOn(fs, "mkdir").mockImplementation(((...args: Parameters<typeof fs.mkdir>) => {
        if (targetLocks.has(String(args[0]))) acquired.push(String(args[0]));
        return realMkdir(...args);
      }) as typeof fs.mkdir);
      try {
        expect(await applyOutcomeFeedback(records, config)).toEqual({ applied: 2, missing: [] });
      } finally {
        mkdirSpy.mockRestore();
      }
      expect(acquired).toEqual(targets.sort().map(target => `${target}.lock.d`));
    });
  });

  test("an oversized destination batch fails before acquiring locks or changing any file", async () => {
    await withTempCassHome(async env => {
      const config = createTestConfig({ playbookPath: env.playbookPath });
      await savePlaybook(createTestPlaybook([createTestBullet({ id: "b-bounded" })]), config.playbookPath);
      const original = await fs.readFile(config.playbookPath);
      const prepared = await prepareOutcome({
        sessionId: "bounded", outcome: "success", rulesUsed: ["b-bounded"], workspace: env.home,
      }, config);
      const records: OutcomeRecord[] = [];
      const targets: string[] = [];
      for (let index = 0; index < 65; index++) {
        // Final symlinks are distinct atomic replacement destinations even
        // though their current content belongs to the same allowed owner.
        const target = path.join(env.home, `linked-book-${index}.yaml`);
        await fs.symlink(config.playbookPath, target);
        targets.push(target);
        records.push({ ...prepared, id: `${prepared.id}-${index}`,
          ruleTargets: [{ ruleId: "b-bounded", playbookPath: target }] });
      }
      let lockAttempts = 0;
      const realMkdir = fs.mkdir.bind(fs);
      const mkdirSpy = spyOn(fs, "mkdir").mockImplementation(((...args: Parameters<typeof fs.mkdir>) => {
        if (String(args[0]).endsWith(".lock.d")) lockAttempts++;
        return realMkdir(...args);
      }) as typeof fs.mkdir);
      try {
        await expect(applyOutcomeFeedback(records, config)).rejects.toThrow(/64.*destinations.*[Rr]educe/);
      } finally {
        mkdirSpy.mockRestore();
      }
      expect(lockAttempts).toBe(0);
      expect(await fs.readFile(config.playbookPath)).toEqual(original);
      expect(await Promise.all(targets.map(async target => (await fs.lstat(target)).isSymbolicLink())))
        .toEqual(targets.map(() => true));
    });
  });
});

describe("automatic transcript evidence consumption", () => {
  const key = (digit: string) => `te1:${digit.repeat(64)}`;
  const evidence = (ruleId: string, ...digits: string[]): TranscriptRuleEvidence => ({
    ruleId, recordKeys: digits.map(key),
  });

  async function withEvidencePlaybook(run: (fixture: {
    config: ReturnType<typeof createTestConfig>;
    prepare: (entries: TranscriptRuleEvidence[], outcome?: "success" | "failure") => Promise<OutcomeRecord>;
    read: () => ReturnType<typeof loadPlaybook>;
    workspace: string;
  }) => Promise<void>) {
    await withTempCassHome(async env => {
      const config = createTestConfig({ playbookPath: path.join(env.cassMemoryDir, "playbook.yaml") });
      await savePlaybook(createTestPlaybook([
        createTestBullet({ id: "b-evidence1" }), createTestBullet({ id: "b-evidence2" }),
      ]), config.playbookPath);
      const prepare = (entries: TranscriptRuleEvidence[], outcome: "success" | "failure" = "success") =>
        prepareOutcome({
          sessionId: path.join(env.home, "session.jsonl"), workspace: env.home, outcome,
          rulesUsed: ["b-evidence1", "b-evidence2"], autoGraded: true, transcriptEvidence: entries,
        }, config);
      await run({ config, prepare, read: () => loadPlaybook(config.playbookPath), workspace: env.home });
    });
  }

  test("separately prepared automatic outcomes consume identical source evidence once", async () => {
    await withEvidencePlaybook(async ({ config, prepare, read, workspace }) => {
      const entries = [evidence("b-evidence1", "1"), evidence("b-evidence2", "2")];
      const first = await prepare(entries);
      const second = await prepare(entries);
      expect(first.id).not.toBe(second.id);
      await persistOutcomeRecord(first, config);
      await persistOutcomeRecord(second, config);
      expect((await applyOutcomeFeedback(first, config)).applied).toBe(2);
      expect((await applyOutcomeFeedback(second, config)).applied).toBe(0);
      const loaded = await loadOutcomes(config, 100, workspace);
      expect(loaded).toHaveLength(2);
      expect(loaded.every(record => record.transcriptEvidence?.length === 2)).toBe(true);
      expect((await applyOutcomeFeedback(loaded, config)).applied).toBe(0);
      expect((await read()).bullets.map(bullet => bullet.helpfulCount)).toEqual([1, 1]);
      expect((await read()).bullets[0].feedbackEvents[0].transcriptEvidenceKeys).toEqual([key("1")]);
    });
  });

  test("reflushes already-consumed evidence for a new outcome without rewriting feedback", async () => {
    await withEvidencePlaybook(async ({ config, prepare, read }) => {
      const first = await prepare([evidence("b-evidence1", "1")]);
      const repeated = await prepare([evidence("b-evidence1", "1")]);
      expect(repeated.id).not.toBe(first.id);
      expect((await applyOutcomeFeedback(first, config)).applied).toBe(1);
      const before = await fs.readFile(config.playbookPath, "utf8");
      const originalOpen = fs.open.bind(fs);
      const restoreHandles: Array<() => void> = [];
      let failing = true;
      let flushes = 0;
      const openSpy = spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        const handle = await originalOpen(...args);
        if (String(args[0]) === config.playbookPath) {
          const sync = handle.sync.bind(handle);
          const syncSpy = spyOn(handle, "sync").mockImplementation(async () => {
            flushes++;
            if (failing) throw new Error("injected consumed-evidence flush failure");
            await sync();
          });
          restoreHandles.push(() => syncSpy.mockRestore());
        }
        return handle;
      });
      try {
        await expect(applyOutcomeFeedback(repeated, config)).rejects.toThrow("consumed-evidence flush failure");
        expect(await fs.readFile(config.playbookPath, "utf8")).toBe(before);
        failing = false;
        expect((await applyOutcomeFeedback(repeated, config)).applied).toBe(0);
        expect(flushes).toBe(2);
        expect(await fs.readFile(config.playbookPath, "utf8")).toBe(before);
        const bullet = (await read()).bullets[0];
        expect(bullet.helpfulCount).toBe(1);
        expect(bullet.feedbackEvents.map(event => event.outcomeId)).toEqual([first.id!]);
      } finally {
        openSpy.mockRestore();
        for (const restore of restoreHandles) restore();
      }
    });
  });

  test.each([false, true])("partial overlaps consume only new keys in either order (reverse=%s)", async reverse => {
    await withEvidencePlaybook(async ({ config, prepare, read }) => {
      const first = await prepare([evidence("b-evidence1", "1", "2")]);
      const second = await prepare([evidence("b-evidence1", "2", "3")]);
      const ordered = reverse ? [second, first] : [first, second];
      expect((await applyOutcomeFeedback(ordered, config)).applied).toBe(2);
      expect((await applyOutcomeFeedback([...ordered].reverse(), config)).applied).toBe(0);
      const [bullet, unrelated] = (await read()).bullets;
      expect(bullet.helpfulCount).toBe(2);
      expect(unrelated.helpfulCount).toBe(0);
      expect(bullet.feedbackEvents.flatMap(event => event.transcriptEvidenceKeys ?? []).sort())
        .toEqual([key("1"), key("2"), key("3")]);
      expect(bullet.feedbackEvents.map(event => event.transcriptEvidenceKeys?.length)).toEqual([2, 1]);
    });
  });

  test("overlapping full and incremental histories cannot credit an unrelated old rule again", async () => {
    await withEvidencePlaybook(async ({ config, prepare, read }) => {
      const prefix = await prepare([evidence("b-evidence1", "1")]);
      const whole = await prepare([evidence("b-evidence1", "1"), evidence("b-evidence2", "2")]);
      const suffix = await prepare([evidence("b-evidence2", "2")]);
      expect((await applyOutcomeFeedback(prefix, config)).applied).toBe(1);
      expect((await applyOutcomeFeedback(whole, config)).applied).toBe(1);
      expect((await applyOutcomeFeedback(suffix, config)).applied).toBe(0);
      expect((await read()).bullets.map(bullet => bullet.helpfulCount)).toEqual([1, 1]);
    });
  });

  test("new appended evidence counts while a changed verdict cannot reuse old evidence", async () => {
    await withEvidencePlaybook(async ({ config, prepare, read }) => {
      const initial = await prepare([evidence("b-evidence1", "1")]);
      const reclassified = await prepare([evidence("b-evidence1", "1")], "failure");
      const appended = await prepare([evidence("b-evidence1", "2")]);
      expect((await applyOutcomeFeedback(initial, config)).applied).toBe(1);
      expect((await applyOutcomeFeedback(reclassified, config)).applied).toBe(0);
      expect((await applyOutcomeFeedback(appended, config)).applied).toBe(1);
      const bullet = (await read()).bullets[0];
      expect(bullet.helpfulCount).toBe(2);
      expect(bullet.harmfulCount).toBe(0);
    });
  });

  test("concurrent outcomes consume shared keys atomically", async () => {
    await withEvidencePlaybook(async ({ config, prepare, read }) => {
      const entries = [evidence("b-evidence1", "1")];
      const records = await Promise.all([prepare(entries), prepare(entries)]);
      const results = await Promise.all(records.map(record => applyOutcomeFeedback(record, config)));
      expect(results.reduce((total, result) => total + result.applied, 0)).toBe(1);
      expect((await read()).bullets[0].helpfulCount).toBe(1);
      expect((await read()).bullets[0].feedbackEvents).toHaveLength(1);
    });
  });

  test("an explicit empty evidence set abstains instead of falling back to all rules", async () => {
    await withEvidencePlaybook(async ({ config, prepare, read }) => {
      expect((await applyOutcomeFeedback(await prepare([]), config)).applied).toBe(0);
      expect((await read()).bullets.map(bullet => bullet.helpfulCount)).toEqual([0, 0]);
    });
  });

  test("a prepared UUID cannot be repurposed to consume different transcript records", async () => {
    await withEvidencePlaybook(async ({ config, prepare }) => {
      const record = await prepare([evidence("b-evidence1", "1")]);
      await persistOutcomeRecord(record, config);
      const before = await fs.readFile(record.path, "utf8");
      await expect(persistOutcomeRecord({
        ...record, transcriptEvidence: [evidence("b-evidence1", "2")],
      }, config)).rejects.toThrow("different event");
      expect(await fs.readFile(record.path, "utf8")).toBe(before);
    });
  });

  test("legacy feedback without source keys does not invent record provenance", async () => {
    await withEvidencePlaybook(async ({ config, prepare, read }) => {
      const record = await prepare([evidence("b-evidence1", "1")]);
      const legacy = { ...record, id: "legacy-automatic-event", transcriptEvidence: undefined, rulesUsed: ["b-evidence1"] };
      expect((await applyOutcomeFeedback(legacy, config)).applied).toBe(1);
      expect((await applyOutcomeFeedback(record, config)).applied).toBe(1);
      expect((await applyOutcomeFeedback(record, config)).applied).toBe(0);
      const bullet = (await read()).bullets[0];
      expect(bullet.helpfulCount).toBe(2);
      expect(bullet.feedbackEvents[0].transcriptEvidenceKeys).toBeUndefined();
      expect(bullet.feedbackEvents[1].transcriptEvidenceKeys).toEqual([key("1")]);
    });
  });

  test("context-enriched manual outcomes remain separate events without transcript evidence", async () => {
    await withTempCassHome(async env => {
      const config = createTestConfig({ playbookPath: path.join(env.cassMemoryDir, "playbook.yaml") });
      await savePlaybook(createTestPlaybook([createTestBullet({ id: "b-evidence1" })]), config.playbookPath);
      await fs.writeFile(path.join(env.cassMemoryDir, "context-log.jsonl"), JSON.stringify({
        session: "manual", workspace: env.home, ruleIds: ["b-evidence1"], timestamp: new Date().toISOString(),
      }) + "\n");
      const first = await prepareOutcome({ sessionId: "manual", outcome: "success", workspace: env.home }, config);
      const second = await prepareOutcome({ sessionId: "manual", outcome: "success", workspace: env.home }, config);
      expect(first.autoGraded).toBe(true);
      expect(first.transcriptEvidence).toBeUndefined();
      expect(first.id).not.toBe(second.id);
      expect((await applyOutcomeFeedback([first, second], config)).applied).toBe(2);
      expect((await loadPlaybook(config.playbookPath)).bullets[0].helpfulCount).toBe(2);
    });
  });
});
