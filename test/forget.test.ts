/**
 * Unit tests for forget command
 *
 * Tests:
 * - Forget a bullet (deprecate + add to blocked log)
 * - Forget with invert flag (creates anti-pattern)
 * - Error handling for missing reason
 * - Error handling for non-existent bullet
 * - JSON output format
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import { join } from "node:path";
import yaml from "yaml";
import { forgetCommand } from "../src/commands/forget.js";
import type { Playbook, PlaybookBullet } from "../src/types.js";
import { withTempCassHome } from "./helpers/temp.js";

// Test helper to create a bullet
function createTestBullet(overrides: Partial<PlaybookBullet> = {}): PlaybookBullet {
  return {
    id: overrides.id || "b-test123",
    content: "Test bullet content",
    category: "testing",
    kind: "workflow_rule",
    type: "rule",
    isNegative: false,
    scope: "global",
    source: "learned",
    tags: [],
    state: "active",
    maturity: "candidate",
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    sourceSessions: [],
    sourceAgents: [],
    helpfulCount: 0,
    harmfulCount: 0,
    feedbackEvents: [],
    deprecated: false,
    pinned: false,
    ...overrides,
    confidenceDecayHalfLifeDays: overrides.confidenceDecayHalfLifeDays ?? 90,
  };
}

// Test helper to create a playbook
function createTestPlaybook(bullets: PlaybookBullet[] = []): Playbook {
  return {
    schema_version: 2,
    name: "test-playbook",
    description: "Test playbook",
    metadata: {
      createdAt: "2025-01-01T00:00:00Z",
      totalReflections: 0,
      totalSessionsProcessed: 0,
    },
    deprecatedPatterns: [],
    bullets,
  };
}

describe("forget command - Unit Tests", () => {
  for (const owner of ["global", "repo"] as const) {
    for (const invert of [false, true]) {
      test(`rejects duplicate IDs in the ${owner} playbook without changing rules or blocklists (invert=${invert})`, async () => {
        await withTempCassHome(async (env) => {
          const repo = join(env.home, "repo");
          const repoDir = join(repo, ".cass");
          await fs.mkdir(repoDir, { recursive: true });
          expect(Bun.spawnSync(["git", "init", "--quiet", "--initial-branch=main", repo]).exitCode).toBe(0);
          const repoPath = join(repoDir, "playbook.yaml");
          const id = "b-legacy-duplicate";
          const learned = {
            ...createTestBullet({
              id,
              content: "Keep the recovery snapshot until verification finishes.",
              helpfulCount: 1,
              feedbackEvents: [{ type: "helpful" as const, timestamp: "2025-01-02T00:00:00Z" }],
            }),
            legacyEvidence: { sessions: ["session-a"], confidence: 0.9 },
          };
          const duplicates = createTestPlaybook([
            learned,
            createTestBullet({ id, content: "Verify every restored account before accepting writes." }),
          ]);
          const globalOriginal = yaml.stringify(owner === "global" ? duplicates : createTestPlaybook([
            createTestBullet({ id, content: "Do not fall back to the global rule." }),
          ]));
          const repoOriginal = yaml.stringify(owner === "repo" ? duplicates : createTestPlaybook());
          writeFileSync(env.playbookPath, globalOriginal);
          writeFileSync(repoPath, repoOriginal);
          writeFileSync(env.configPath, JSON.stringify({ playbookPath: env.playbookPath, diaryDir: env.diaryDir }));
          const blocked = `${JSON.stringify({ id: "b-already-blocked", content: "Never discard an unverified backup.", reason: "Keep existing decisions", forgottenAt: "2025-01-01T00:00:00Z" })}\n`;
          const globalBlocked = join(env.cassMemoryDir, "blocked.log");
          const repoBlocked = join(repoDir, "blocked.log");
          writeFileSync(globalBlocked, blocked);
          writeFileSync(repoBlocked, blocked);
          const cwd = process.cwd();
          const log = console.log;
          const exitCode = process.exitCode;
          const output: string[] = [];
          try {
            process.chdir(repo);
            process.exitCode = 0;
            console.log = (...args) => { output.push(args.join(" ")); };
            await forgetCommand(id, { reason: "Retire one rule", invert, json: true });
            expect(process.exitCode).not.toBe(0);
            const response = JSON.parse(output.join(""));
            expect(response.success).toBe(false);
            expect(JSON.stringify(response)).toContain("Ambiguous bullet ID");
            expect(JSON.stringify(response)).toContain(owner === "global" ? env.playbookPath : repoPath);
          } finally {
            console.log = log;
            process.exitCode = exitCode;
            process.chdir(cwd);
          }
          expect(readFileSync(env.playbookPath, "utf8")).toBe(globalOriginal);
          expect(readFileSync(repoPath, "utf8")).toBe(repoOriginal);
          expect(readFileSync(globalBlocked, "utf8")).toBe(blocked);
          expect(readFileSync(repoBlocked, "utf8")).toBe(blocked);
        });
      });
    }
  }

  test("a unique repository override remains forgettable when the global ID is duplicated", async () => {
    await withTempCassHome(async (env) => {
      const repo = join(env.home, "repo");
      const repoDir = join(repo, ".cass");
      await fs.mkdir(repoDir, { recursive: true });
      expect(Bun.spawnSync(["git", "init", "--quiet", "--initial-branch=main", repo]).exitCode).toBe(0);
      const id = "b-scoped-override";
      const globalOriginal = yaml.stringify(createTestPlaybook([
        createTestBullet({ id, content: "Keep global rule one." }),
        createTestBullet({ id, content: "Keep global rule two." }),
      ]));
      const repoPath = join(repoDir, "playbook.yaml");
      writeFileSync(env.playbookPath, globalOriginal);
      writeFileSync(repoPath, yaml.stringify(createTestPlaybook([
        createTestBullet({ id, content: "Retire only this repository override." }),
      ])));
      writeFileSync(env.configPath, JSON.stringify({ playbookPath: env.playbookPath, diaryDir: env.diaryDir }));
      const cwd = process.cwd();
      const exitCode = process.exitCode;
      try {
        process.chdir(repo);
        process.exitCode = 0;
        await forgetCommand(id, { reason: "Repository policy changed", json: true });
        expect(process.exitCode).toBe(0);
      } finally {
        process.exitCode = exitCode;
        process.chdir(cwd);
      }
      expect(readFileSync(env.playbookPath, "utf8")).toBe(globalOriginal);
      expect(yaml.parse(readFileSync(repoPath, "utf8")).bullets[0].deprecated).toBe(true);
      expect(JSON.parse(readFileSync(join(repoDir, "blocked.log"), "utf8")).content)
        .toBe("Retire only this repository override.");
      expect(existsSync(join(env.cassMemoryDir, "blocked.log"))).toBe(false);
    });
  });

  for (const localPlaybook of [false, true]) {
    test(`forgets the retrieved worktree owner without changing a same-ID global rule (local=${localPlaybook})`, async () => {
      await withTempCassHome(async (env) => {
        const repo = join(env.home, "repo");
        const repoDir = join(repo, ".cass");
        const worktree = join(env.home, "linked");
        const worktreeDir = join(worktree, ".cass");
        await fs.mkdir(repoDir, { recursive: true });
        expect(Bun.spawnSync(["git", "init", "--quiet", "--initial-branch=main", repo]).exitCode).toBe(0);
        expect(Bun.spawnSync(["git", "-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--quiet", "--allow-empty", "-m", "Initialize worktree fixture"]).exitCode).toBe(0);
        expect(Bun.spawnSync(["git", "-C", repo, "worktree", "add", "--quiet", "--detach", worktree]).exitCode).toBe(0);
        const id = "b-worktree-owner";
        const repoPath = join(repoDir, "playbook.yaml");
        const worktreePath = join(worktreeDir, "playbook.yaml");
        const globalOriginal = yaml.stringify(createTestPlaybook([
          createTestBullet({ id, content: "Keep the global policy." }),
        ]));
        const repoOriginal = yaml.stringify(createTestPlaybook([
          createTestBullet({ id, content: "The main worktree owns this policy." }),
        ]));
        writeFileSync(env.playbookPath, globalOriginal);
        writeFileSync(repoPath, repoOriginal);
        if (localPlaybook) {
          await fs.mkdir(worktreeDir, { recursive: true });
          writeFileSync(worktreePath, yaml.stringify(createTestPlaybook([
            createTestBullet({ id, content: "The linked worktree overrides this policy." }),
          ])));
        }
        writeFileSync(env.configPath, JSON.stringify({ playbookPath: env.playbookPath, diaryDir: env.diaryDir }));
        const cwd = process.cwd();
        const exitCode = process.exitCode;
        try {
          process.chdir(worktree);
          process.exitCode = 0;
          await forgetCommand(id, { reason: "Retire the retrieved rule", json: true });
          expect(process.exitCode).toBe(0);
        } finally {
          process.exitCode = exitCode;
          process.chdir(cwd);
        }
        const target = localPlaybook ? worktreePath : repoPath;
        const blockedPath = join(localPlaybook ? worktreeDir : repoDir, "blocked.log");
        const updated = yaml.parse(readFileSync(target, "utf8")) as Playbook;
        expect(updated.bullets[0].deprecated).toBe(true);
        expect(JSON.parse(readFileSync(blockedPath, "utf8")).content).toBe(updated.bullets[0].content);
        expect(readFileSync(env.playbookPath, "utf8")).toBe(globalOriginal);
        expect(existsSync(join(env.cassMemoryDir, "blocked.log"))).toBe(false);
        expect(existsSync(join(localPlaybook ? repoDir : worktreeDir, "blocked.log"))).toBe(false);
        if (localPlaybook) expect(readFileSync(repoPath, "utf8")).toBe(repoOriginal);
        else expect(existsSync(worktreePath)).toBe(false);
      });
    });
  }

  for (const code of ["EIO", "EACCES"]) {
    test(`aborts on ${code} probing repository rules instead of forgetting a same-ID global rule`, async () => {
      await withTempCassHome(async (env) => {
        const repo = join(env.home, "repo");
        const repoDir = join(repo, ".cass");
        await fs.mkdir(repoDir, { recursive: true });
        const initialized = Bun.spawnSync(["git", "init", "--quiet", "--initial-branch=main", repo]);
        expect(initialized.exitCode).toBe(0);
        const repoPath = join(repoDir, "playbook.yaml");
        const id = "b-colliding-rule";
        const globalOriginal = yaml.stringify(createTestPlaybook([
          createTestBullet({ id, content: "Preserve the global recovery procedure." }),
        ]));
        const repoOriginal = yaml.stringify(createTestPlaybook([
          createTestBullet({ id, content: "Preserve the repository recovery procedure." }),
        ]));
        writeFileSync(env.playbookPath, globalOriginal);
        writeFileSync(repoPath, repoOriginal);
        writeFileSync(env.configPath, JSON.stringify({ playbookPath: env.playbookPath, diaryDir: env.diaryDir }));
        const cwd = process.cwd();
        const access = fs.access;
        let faults = 0;
        try {
          process.chdir(repo);
          fs.access = async (...args: Parameters<typeof fs.access>) => {
            if (String(args[0]) === repoPath) {
              faults++;
              throw Object.assign(new Error(`storage probe failed: ${code}`), { code });
            }
            return access(...args);
          };
          await expect(forgetCommand(id, { reason: "Retire the repository rule", json: true }))
            .rejects.toThrow(`storage probe failed: ${code}`);
        } finally {
          fs.access = access;
          process.chdir(cwd);
        }
        expect(faults).toBeGreaterThan(0);
        expect(readFileSync(env.playbookPath, "utf8")).toBe(globalOriginal);
        expect(readFileSync(repoPath, "utf8")).toBe(repoOriginal);
        expect(existsSync(join(env.cassMemoryDir, "blocked.log"))).toBe(false);
        expect(existsSync(join(repoDir, "blocked.log"))).toBe(false);
      });
    });
  }

  test("requires reason flag", async () => {
    await withTempCassHome(async (env) => {
      const bullet = createTestBullet({ id: "b-forget1" });
      const playbook = createTestPlaybook([bullet]);
      writeFileSync(env.playbookPath, yaml.stringify(playbook));

      // Create config
      writeFileSync(
        env.configPath,
        JSON.stringify({
          playbookPath: env.playbookPath,
          diaryDir: env.diaryDir,
        }),
      );

      process.exitCode = 0;

      await forgetCommand("b-forget1", { reason: undefined });

      expect(process.exitCode).toBe(2);
    });
  });

  test("forgets bullet and adds to blocked log", async () => {
    await withTempCassHome(async (env) => {
      const bullet = createTestBullet({ id: "b-forget2", content: "Use var for all variables" });
      const playbook = createTestPlaybook([bullet]);
      writeFileSync(env.playbookPath, yaml.stringify(playbook));

      // Create config
      writeFileSync(
        env.configPath,
        JSON.stringify({
          playbookPath: env.playbookPath,
          diaryDir: env.diaryDir,
        }),
      );

      process.exitCode = 0;

      await forgetCommand("b-forget2", { reason: "var is deprecated in modern JS" });

      expect(process.exitCode).toBe(0);

      // Check playbook - bullet should be deprecated
      const updatedPlaybook = yaml.parse(readFileSync(env.playbookPath, "utf-8")) as Playbook;
      const deprecatedBullet = updatedPlaybook.bullets.find((b) => b.id === "b-forget2");
      expect(deprecatedBullet).toBeDefined();
      expect(deprecatedBullet?.deprecated).toBe(true);
      expect(deprecatedBullet?.deprecationReason).toBe("var is deprecated in modern JS");

      // Check blocked log - entry should exist
      const blockedLogPath = join(env.cassMemoryDir, "blocked.log");
      expect(existsSync(blockedLogPath)).toBe(true);
      const blockedLog = readFileSync(blockedLogPath, "utf-8");
      const entry = JSON.parse(blockedLog.trim());
      expect(entry.id).toBe("b-forget2");
      expect(entry.reason).toBe("var is deprecated in modern JS");
    });
  });

  test("forgets bullet with invert flag creates anti-pattern", async () => {
    await withTempCassHome(async (env) => {
      const bullet = createTestBullet({
        id: "b-forget3",
        content: "Always use synchronous file operations",
        category: "performance",
        tags: ["io"],
      });
      const playbook = createTestPlaybook([bullet]);
      writeFileSync(env.playbookPath, yaml.stringify(playbook));

      // Create config
      writeFileSync(
        env.configPath,
        JSON.stringify({
          playbookPath: env.playbookPath,
          diaryDir: env.diaryDir,
        }),
      );

      process.exitCode = 0;

      await forgetCommand("b-forget3", {
        reason: "Synchronous operations block the event loop",
        invert: true,
      });

      expect(process.exitCode).toBe(0);

      // Check playbook
      const updatedPlaybook = yaml.parse(readFileSync(env.playbookPath, "utf-8")) as Playbook;

      // Original should be deprecated
      const original = updatedPlaybook.bullets.find((b) => b.id === "b-forget3");
      expect(original?.deprecated).toBe(true);

      // Anti-pattern should be created
      const antiPattern = updatedPlaybook.bullets.find((b) => b.isNegative === true);
      expect(antiPattern).toBeDefined();
      expect(antiPattern?.content).toContain("AVOID:");
      expect(antiPattern?.content).toContain("Always use synchronous file operations");
      expect(antiPattern?.tags).toContain("inverted");
      expect(antiPattern?.category).toBe("performance");
    });
  });

  test("returns error for non-existent bullet", async () => {
    await withTempCassHome(async (env) => {
      const playbook = createTestPlaybook([]);
      writeFileSync(env.playbookPath, yaml.stringify(playbook));

      // Create config
      writeFileSync(
        env.configPath,
        JSON.stringify({
          playbookPath: env.playbookPath,
          diaryDir: env.diaryDir,
        }),
      );

      process.exitCode = 0;

      await forgetCommand("b-nonexistent", { reason: "Testing" });

      expect(process.exitCode).toBe(2);
    });
  });

  test("JSON output includes bulletId and action", async () => {
    await withTempCassHome(async (env) => {
      const bullet = createTestBullet({ id: "b-forget-json" });
      const playbook = createTestPlaybook([bullet]);
      writeFileSync(env.playbookPath, yaml.stringify(playbook));

      // Create config
      writeFileSync(
        env.configPath,
        JSON.stringify({
          playbookPath: env.playbookPath,
          diaryDir: env.diaryDir,
        }),
      );

      process.exitCode = 0;

      // Capture console.log output
      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (...args) => logs.push(args.join(" "));

      await forgetCommand("b-forget-json", { reason: "Test reason", json: true });

      console.log = originalLog;

      expect(process.exitCode).toBe(0);

      // Parse JSON output - standard envelope with data payload
      const output = JSON.parse(logs.join("")) as { success: boolean; command: string; data: any };
      expect(output.success).toBe(true);
      expect(output.command).toBe("forget");
      expect(output.data.bulletId).toBe("b-forget-json");
      expect(output.data.action).toBe("forgotten");
    });
  });
});
