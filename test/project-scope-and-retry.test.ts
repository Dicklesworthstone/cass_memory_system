/**
 * #81: workspace matching by project (git root, linked worktrees), repo
 *      playbook bullets, `playbook add --repo` registration.
 * #85: session eligibility (growth / bounded retry) and discovery ordering.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type CassRunner,
  extractSessionWorkspace,
  findUnprocessedSessions,
  formatSessionRecords,
} from "../src/cass.js";
import { bulletAppliesToWorkspace } from "../src/commands/context.js";
import {
  classifySessionForReflection,
  MAX_SESSION_RETRY_COOLDOWN_MS,
  nextRetryAtMs,
  ProcessedLog,
  sessionHasGrown,
} from "../src/tracking.js";
import type { ProcessedEntry } from "../src/types.js";
import {
  __clearWorkspaceCacheForTest,
  canonicalWorkspacePath,
  resolveProjectRoot,
  workspaceMatches,
} from "../src/workspace.js";
import { createBullet, createTestConfig } from "./helpers/factories.js";

/**
 * Lay out a main checkout at <root>/repo with a linked worktree at
 * <root>/wt/feature, exactly as `git worktree add` does on disk, plus a nested
 * separate repository and a submodule-style checkout.
 */
function makeLayout() {
  __clearWorkspaceCacheForTest();
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "cm-ws-")));
  const repo = path.join(root, "repo");
  mkdirSync(path.join(repo, ".git", "worktrees", "feature"), { recursive: true });
  mkdirSync(path.join(repo, "src", "deep"), { recursive: true });
  writeFileSync(path.join(repo, ".git", "worktrees", "feature", "commondir"), "../..\n");

  const wt = path.join(root, "wt", "feature");
  mkdirSync(path.join(wt, "src"), { recursive: true });
  writeFileSync(path.join(wt, ".git"), `gitdir: ${path.join(repo, ".git", "worktrees", "feature")}\n`);

  const nested = path.join(repo, "vendor", "other");
  mkdirSync(path.join(nested, ".git"), { recursive: true });

  const sub = path.join(repo, "modules", "sub");
  mkdirSync(path.join(repo, ".git", "modules", "sub"), { recursive: true });
  mkdirSync(sub, { recursive: true });
  writeFileSync(path.join(sub, ".git"), "gitdir: ../../.git/modules/sub\n");

  const plain = path.join(root, "plain", "dir");
  mkdirSync(plain, { recursive: true });
  return { root, repo, wt, nested, sub, plain };
}

describe("workspace matching (#81)", () => {
  test("a rule for the repo root applies in subdirectories and linked worktrees", () => {
    const { repo, wt } = makeLayout();
    expect(workspaceMatches(repo, repo)).toBe(true);
    expect(workspaceMatches(repo, path.join(repo, "src", "deep"))).toBe(true);
    expect(workspaceMatches(repo, wt)).toBe(true);
    expect(workspaceMatches(repo, path.join(wt, "src"))).toBe(true);
    // Learned inside a worktree, used in the main checkout.
    expect(workspaceMatches(wt, repo)).toBe(true);
  });

  test("a subdirectory rule stays within that subdirectory", () => {
    const { repo, wt } = makeLayout();
    const src = path.join(repo, "src");
    expect(workspaceMatches(src, path.join(repo, "src", "deep"))).toBe(true);
    expect(workspaceMatches(src, path.join(wt, "src"))).toBe(true);
    expect(workspaceMatches(src, repo)).toBe(false);
  });

  test("does not leak into unrelated dirs, nested repositories or submodules", () => {
    const { repo, nested, sub, plain, root } = makeLayout();
    expect(workspaceMatches(repo, plain)).toBe(false);
    expect(workspaceMatches(repo, nested)).toBe(false);
    expect(workspaceMatches(repo, sub)).toBe(false);
    expect(workspaceMatches(path.join(root, "plain"), plain)).toBe(true);
    expect(workspaceMatches("/", plain)).toBe(false);
    expect(workspaceMatches("", plain)).toBe(false);
  });

  test("project root resolves worktrees to the main checkout", () => {
    const { repo, wt, sub, plain } = makeLayout();
    expect(resolveProjectRoot(path.join(wt, "src"))).toBe(repo);
    expect(resolveProjectRoot(path.join(repo, "src", "deep"))).toBe(repo);
    expect(resolveProjectRoot(sub)).toBe(sub);
    expect(resolveProjectRoot(plain)).toBe(plain);
    expect(canonicalWorkspacePath(path.join(wt, "src"))).toBe(path.join(repo, "src"));
  });

  test("repo-playbook bullets without a workspace are scoped to that repository", () => {
    const { repo, wt, plain } = makeLayout();
    const repoRule = createBullet({ id: "b-repo1", scope: "workspace" } as any);
    const orphan = createBullet({ id: "b-orphan", scope: "workspace" } as any);
    const globalRule = createBullet({ id: "b-glob", scope: "global" } as any);
    const sources = { repoRoot: repo, repoBulletIds: new Set(["b-repo1"]) };
    expect(bulletAppliesToWorkspace(repoRule, path.join(repo, "src"), sources)).toBe(true);
    expect(bulletAppliesToWorkspace(repoRule, wt, sources)).toBe(true);
    expect(bulletAppliesToWorkspace(repoRule, plain, sources)).toBe(false);
    // Only bullets that came from the repo playbook get the implicit scope.
    expect(bulletAppliesToWorkspace(orphan, repo, sources)).toBe(false);
    expect(bulletAppliesToWorkspace(globalRule, plain, sources)).toBe(true);
    const pinned = createBullet({ id: "b-pin", scope: "workspace", workspace: repo } as any);
    expect(bulletAppliesToWorkspace(pinned, path.join(wt, "src"))).toBe(true);
  });
});

describe("cm playbook add --repo is a registered option (#81)", () => {
  test("the CLI accepts --repo", async () => {
    const proc = Bun.spawnSync(
      ["bun", "run", path.join(import.meta.dir, "..", "src", "cm.ts"), "playbook", "add", "--help"],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(proc.stdout.toString()).toContain("--repo");
  });
});

describe("session eligibility (#85)", () => {
  const policy = { maxFailures: 3, cooldownMs: 60 * 60 * 1000 };
  const base: ProcessedEntry = {
    sessionPath: "/s.jsonl",
    processedAt: "2026-09-01T00:00:00.000Z",
    deltasGenerated: 0,
  };

  test("new, unchanged, grown and legacy sessions", () => {
    expect(classifySessionForReflection(undefined, {}, policy)).toBe("new");
    const done = { ...base, recordCount: 10, messageCount: 5, sizeBytes: 100 };
    expect(classifySessionForReflection(done, { messageCount: 5, sizeBytes: 100 }, policy)).toBe(
      "skip",
    );
    expect(classifySessionForReflection(done, { messageCount: 6 }, policy)).toBe("grown");
    expect(classifySessionForReflection(done, { sizeBytes: 101 }, policy)).toBe("grown");
    // No watermark (older log, or `onboard mark-done`): never re-reflected.
    expect(classifySessionForReflection(base, { messageCount: 99, sizeBytes: 1e9 }, policy)).toBe(
      "skip",
    );
    expect(
      sessionHasGrown(
        { ...done, endedAt: "2026-09-01T00:00:00.000Z" },
        { endedAt: "2026-09-02T00:00:00.000Z" },
      ),
    ).toBe(true);
  });

  test("failed sessions retry until the limit, then back off exponentially", () => {
    const now = Date.parse("2026-09-10T12:00:00.000Z");
    const failedAt = new Date(now - 30 * 60 * 1000).toISOString(); // 30 min ago
    const f = (failures: number): ProcessedEntry => ({
      ...base,
      status: "failed",
      failures,
      lastFailureAt: failedAt,
    });
    expect(classifySessionForReflection(f(1), {}, policy, now)).toBe("retry");
    expect(classifySessionForReflection(f(2), {}, policy, now)).toBe("retry");
    expect(classifySessionForReflection(f(3), {}, policy, now)).toBe("skip");
    expect(classifySessionForReflection(f(3), {}, policy, now + 31 * 60 * 1000)).toBe("retry");
    // One more failure doubles the cooldown.
    expect(nextRetryAtMs(f(4), policy) - Date.parse(failedAt)).toBe(2 * policy.cooldownMs);
    expect(nextRetryAtMs(f(60), policy) - Date.parse(failedAt)).toBe(MAX_SESSION_RETRY_COOLDOWN_MS);
  });

  test("the processed log keeps watermark and retry fields; failed entries are not processed", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cm-plog-"));
    const logPath = path.join(dir, "global.processed.log");
    const log = new ProcessedLog(logPath);
    await log.appendBatch([
      {
        ...base,
        sessionPath: "/a.jsonl",
        recordCount: 7,
        lastRecordHash: "abc",
        messageCount: 3,
        sizeBytes: 42,
      },
      {
        ...base,
        sessionPath: "/b.jsonl",
        status: "failed",
        failures: 2,
        lastFailureAt: "2026-09-01T00:00:00.000Z",
        lastError: "boom",
      },
    ]);
    const reloaded = new ProcessedLog(logPath);
    await reloaded.load();
    expect(reloaded.get("/a.jsonl")).toMatchObject({
      recordCount: 7,
      lastRecordHash: "abc",
      messageCount: 3,
      sizeBytes: 42,
    });
    expect(reloaded.has("/a.jsonl")).toBe(true);
    expect(reloaded.has("/b.jsonl")).toBe(false);
    expect(reloaded.get("/b.jsonl")).toMatchObject({ status: "failed", failures: 2 });
    expect([...reloaded.getProcessedPaths()]).toEqual(["/a.jsonl"]);
  });
});

describe("discovery with eligibility (#85)", () => {
  const timeline = JSON.stringify({
    groups: {
      "2026-09-01 10:00": [
        { source_path: "/old-failing.jsonl", agent: "claude_code", started_at: 1000, message_count: 4 },
        { source_path: "/grown.jsonl", agent: "claude_code", started_at: 2000, message_count: 9 },
        { source_path: "/fresh.jsonl", agent: "claude_code", started_at: 3000, message_count: 2 },
        { source_path: "/done.jsonl", agent: "claude_code", started_at: 4000, message_count: 2 },
      ],
    },
  });
  const runner: CassRunner = {
    execFile: async (_file: string, args: string[]) => {
      if (args[0] === "timeline") return { stdout: timeline, stderr: "" };
      throw new Error(`unexpected ${args[0]}`);
    },
    spawnSync: () => ({ status: 0, stdout: "", stderr: "" }),
  } as unknown as CassRunner;

  test("due sessions fill the batch before retries; skipped ones are dropped", async () => {
    const kinds: Record<string, "new" | "grown" | "retry" | "skip"> = {
      "/old-failing.jsonl": "retry",
      "/grown.jsonl": "grown",
      "/fresh.jsonl": "new",
      "/done.jsonl": "skip",
    };
    const seen: Array<{ path: string; messageCount?: number }> = [];
    const all = await findUnprocessedSessions(
      new Set(),
      {
        maxSessions: 10,
        classify: (s) => {
          seen.push({ path: s.path, messageCount: s.messageCount });
          return kinds[s.path]!;
        },
      },
      "cass",
      runner,
    );
    expect(all.map((s) => s.path)).toEqual(["/grown.jsonl", "/fresh.jsonl", "/old-failing.jsonl"]);
    expect(seen.find((s) => s.path === "/grown.jsonl")?.messageCount).toBe(9);

    const batch = await findUnprocessedSessions(
      new Set(),
      { maxSessions: 2, classify: (s) => kinds[s.path]! },
      "cass",
      runner,
    );
    expect(batch.map((s) => s.path)).toEqual(["/grown.jsonl", "/fresh.jsonl"]);
  });
});

describe("session record helpers", () => {
  test("extractSessionWorkspace reads Claude Code cwd and Codex session_meta", () => {
    expect(extractSessionWorkspace([{ type: "mode" }, { type: "user", cwd: "/work/repo" }])).toBe(
      "/work/repo",
    );
    expect(
      extractSessionWorkspace([{ type: "session_meta", payload: { cwd: "/work/codex" } }]),
    ).toBe("/work/codex");
    expect(extractSessionWorkspace([{ cwd: "relative/dir" }, { role: "user" }])).toBeUndefined();
    expect(extractSessionWorkspace([])).toBeUndefined();
  });

  test("formatSessionRecords renders and sanitizes a record slice", () => {
    const config = createTestConfig();
    const text = formatSessionRecords(
      [
        { role: "user", content: "hello there" },
        { type: "user", message: { role: "user", content: [{ type: "text", text: "block text" }] } },
      ],
      config,
    );
    expect(text).toContain("hello there");
    expect(text).toContain("block text");
    expect(formatSessionRecords([{ type: "mode" }], config)).toBe("");
  });
});
