import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyOutcomeFeedback, OutcomeRecord } from "../src/outcome.js";
import { createTestBullet, createTestConfig } from "./helpers/factories.js";
import { savePlaybook } from "../src/playbook.js";

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
        { schema_version: 2, name: "pb", description: "", metadata: { createdAt: new Date().toISOString(), totalReflections: 0, totalSessionsProcessed: 0 }, deprecatedPatterns: [], bullets: [bullet] },
        playbookPath
      );

      const outcome: OutcomeRecord = {
        sessionId: "/tmp/session.jsonl",
        outcome: "success",
        rulesUsed: ["b-1"],
        recordedAt: new Date().toISOString(),
        path: playbookPath
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
        { schema_version: 2, name: "pb", description: "", metadata: { createdAt: new Date().toISOString(), totalReflections: 0, totalSessionsProcessed: 0 }, deprecatedPatterns: [], bullets: [bullet] },
        playbookPath
      );

      const recordedAt = new Date().toISOString();
      const outcome: OutcomeRecord = {
        sessionId: "/tmp/session-idempotent",
        outcome: "success",
        rulesUsed: ["b-idem"],
        recordedAt,
        path: playbookPath
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
        { schema_version: 2, name: "pb", description: "", metadata: { createdAt: new Date().toISOString(), totalReflections: 0, totalSessionsProcessed: 0 }, deprecatedPatterns: [], bullets: [bullet] },
        playbookPath
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
          source: "test"
        }) + "\n"
      );

      const outcome: OutcomeRecord = {
        sessionId: "/tmp/session-context",
        outcome: "success",
        rulesUsed: [],
        recordedAt: new Date().toISOString(),
        path: playbookPath
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
