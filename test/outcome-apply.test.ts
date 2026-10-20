import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyOutcomeFeedback, loadOutcomes, persistOutcomeRecord, prepareOutcome, type OutcomeRecord } from "../src/outcome.js";
import { loadPlaybook, savePlaybook } from "../src/playbook.js";
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
