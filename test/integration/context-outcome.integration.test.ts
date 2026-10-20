import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateContextResult } from "../../src/commands/context.js";
import { applyOutcomeFeedback, type OutcomeRecord, recordOutcome } from "../../src/outcome.js";
import { createEmptyPlaybook, loadPlaybook, savePlaybook } from "../../src/playbook.js";
import { createTestBullet, createTestConfig } from "../helpers/factories.js";

async function withTempEnv(run: (ctx: { home: string; repo: string }) => Promise<void>) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cass-home-"));
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "cass-repo-"));
  const prevHome = process.env.HOME;
  const prevCwd = process.cwd();
  try {
    process.env.HOME = home;
    // Initialize git repo so resolveRepoDir() can find .cass directory
    execSync("git init", { cwd: repo, stdio: "pipe" });
    process.chdir(repo);
    await run({ home, repo });
  } finally {
    process.env.HOME = prevHome;
    process.chdir(prevCwd);
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(repo, { recursive: true, force: true });
  }
}

describe("Integration: context logging + outcome feedback", () => {
  test("context logs rules and outcome backfills missing rulesUsed", async () => {
    await withTempEnv(async ({ home, repo }) => {
      // 1) Prepare global playbook with one bullet
      const playbookPath = path.join(home, ".cass-memory", "playbook.yaml");
      await fs.mkdir(path.dirname(playbookPath), { recursive: true });
      const pb = createEmptyPlaybook("test");
      pb.bullets.push({
        id: "b-int-1",
        scope: "global",
        category: "testing",
        content: "Always hydrate context",
        source: "learned",
        type: "rule",
        isNegative: false,
        kind: "workflow_rule",
        state: "active",
        maturity: "candidate",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        helpfulCount: 0,
        harmfulCount: 0,
        feedbackEvents: [],
        confidenceDecayHalfLifeDays: 90,
        deprecated: false,
        pinned: false,
        sourceSessions: [],
        sourceAgents: [],
        tags: [],
      });
      await savePlaybook(pb, playbookPath);

      // 2) Ensure repo .cass exists for context log
      await fs.mkdir(path.join(repo, ".cass"), { recursive: true });

      // 3) Run context with logging enabled
      const sessionId = "sess-int-1";
      const { result } = await generateContextResult("hydrate context", {
        json: true,
        logContext: true,
        session: sessionId,
      });

      expect(result.relevantBullets.length).toBeGreaterThan(0);
      const logPath = path.join(repo, ".cass", "context-log.jsonl");
      const logContent = await fs.readFile(logPath, "utf-8");
      expect(logContent).toContain("b-int-1");

      // 4) Apply outcome with empty rulesUsed; should backfill from context log
      const outcome: OutcomeRecord = {
        sessionId,
        outcome: "success",
        rulesUsed: [],
        recordedAt: new Date().toISOString(),
        path: "in-memory",
      };

      const feedbackResult = await applyOutcomeFeedback(outcome, {
        // Minimal config override to point to the playbook we created
        ...require("../../src/config.js").DEFAULT_CONFIG,
        playbookPath,
      });

      expect(feedbackResult.applied).toBe(1);
    });
  });

  test("a linked-worktree outcome reads the main playbook's context log and updates its rule", async () => {
    await withTempEnv(async ({ home, repo }) => {
      const runGit = (...args: string[]) => {
        const result = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
        if (result.exitCode !== 0) throw new Error(result.stderr.toString());
      };
      runGit("-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
        "commit", "--allow-empty", "--quiet", "-m", "fixture");
      const linked = path.join(home, "linked-worktree");
      runGit("-C", repo, "worktree", "add", "--detach", "--quiet", linked);
      const playbookPath = path.join(home, ".cass-memory", "playbook.yaml");
      const repoPlaybookPath = path.join(repo, ".cass", "playbook.yaml");
      const config = createTestConfig({ playbookPath, cassPath: "/__missing__/cass", semanticSearchEnabled: false });
      const global = createEmptyPlaybook();
      global.bullets.push(createTestBullet({ id: "shared-rule", content: "Run unrelated global checks" }));
      const local = createEmptyPlaybook();
      local.bullets.push(createTestBullet({
        id: "shared-rule", content: "Run migration checks before deployment", scope: "workspace",
      }));
      await savePlaybook(global, playbookPath);
      await savePlaybook(local, repoPlaybookPath);
      await fs.writeFile(path.join(home, ".cass-memory", "config.json"), JSON.stringify(config));
      process.chdir(linked);

      const { result } = await generateContextResult("Run migration checks before deployment", {
        logContext: true, session: "worktree-session", history: 0,
      });
      expect(result.relevantBullets.map(b => b.content)).toEqual(["Run migration checks before deployment"]);
      const log = await fs.readFile(path.join(repo, ".cass", "context-log.jsonl"), "utf8");
      expect(JSON.parse(log).session).toBe("worktree-session");
      const outcome = await recordOutcome({ sessionId: "worktree-session", outcome: "success", rulesUsed: [] }, config);
      expect((await applyOutcomeFeedback(outcome, config)).applied).toBe(1);
      const updated = (await loadPlaybook(repoPlaybookPath)).bullets[0];
      expect(updated.helpfulCount).toBe(1);
      expect(updated.feedbackEvents[0].sessionPath).toBe("worktree-session");
      expect((await loadPlaybook(playbookPath)).bullets[0].helpfulCount).toBe(0);
      expect((await applyOutcomeFeedback(outcome, config)).applied).toBe(0);
    });
  });

  test("a corrupt repository playbook cannot redirect outcome feedback to a shadowed global ID", async () => {
    await withTempEnv(async ({ home, repo }) => {
      const playbookPath = path.join(home, ".cass-memory", "playbook.yaml");
      const repoPlaybookPath = path.join(repo, ".cass", "playbook.yaml");
      const config = createTestConfig({ playbookPath });
      const global = createEmptyPlaybook();
      global.bullets.push(createTestBullet({ id: "shared-rule", content: "Run unrelated global checks" }));
      await savePlaybook(global, playbookPath);
      await fs.mkdir(path.dirname(repoPlaybookPath), { recursive: true });
      const corrupt = "bullets: [unterminated";
      await fs.writeFile(repoPlaybookPath, corrupt);
      const beforeGlobal = await fs.readFile(playbookPath, "utf8");
      const outcome: OutcomeRecord = {
        sessionId: "corrupt-repo-session", outcome: "success", rulesUsed: ["shared-rule"],
        recordedAt: new Date().toISOString(), path: "in-memory",
      };

      await expect(applyOutcomeFeedback(outcome, config)).rejects.toThrow();
      expect(await fs.readFile(repoPlaybookPath, "utf8")).toBe(corrupt);
      expect(await fs.readFile(playbookPath, "utf8")).toBe(beforeGlobal);
    });
  });
});
