import { describe, it, expect, afterEach } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import yaml from "yaml";

import {
  addBullet,
  appendBlockedLog,
  computeFullStats,
  createEmptyPlaybook,
  deprecateBullet,
  exportToMarkdown,
  findBullet,
  getActiveBullets,
  getBulletsByCategory,
  loadPlaybook,
  loadMergedPlaybook,
  loadBlockedLog,
  loadToxicLog,
  appendToxicLog,
  savePlaybook,
  BlockedEntry,
  ToxicEntry,
} from "../src/playbook.js";
import { Playbook, PlaybookBullet } from "../src/types.js";
import { createTestBullet, createTestConfig } from "./helpers/index.js";

async function writePlaybookFile(file: string, playbook: Playbook) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, yaml.stringify(playbook));
}

async function withTempDir(run: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cass-playbook-"));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// =============================================================================
// createEmptyPlaybook
// =============================================================================
describe("createEmptyPlaybook", () => {
  it("creates playbook with default name", () => {
    const pb = createEmptyPlaybook();
    expect(pb.name).toBe("playbook");
  });

  it("creates playbook with custom name", () => {
    const pb = createEmptyPlaybook("custom-name");
    expect(pb.name).toBe("custom-name");
  });

  it("has correct schema version", () => {
    const pb = createEmptyPlaybook();
    expect(pb.schema_version).toBe(2);
  });

  it("has empty bullets array", () => {
    const pb = createEmptyPlaybook();
    expect(pb.bullets).toEqual([]);
  });

  it("has empty deprecatedPatterns array", () => {
    const pb = createEmptyPlaybook();
    expect(pb.deprecatedPatterns).toEqual([]);
  });

  it("has metadata with createdAt", () => {
    const pb = createEmptyPlaybook();
    expect(pb.metadata.createdAt).toBeTruthy();
    expect(typeof pb.metadata.createdAt).toBe("string");
  });

  it("has zero totalReflections", () => {
    const pb = createEmptyPlaybook();
    expect(pb.metadata.totalReflections).toBe(0);
  });

  it("has zero totalSessionsProcessed", () => {
    const pb = createEmptyPlaybook();
    expect(pb.metadata.totalSessionsProcessed).toBe(0);
  });
});

// =============================================================================
// loadPlaybook
// =============================================================================
describe("loadPlaybook", () => {
  it("creates empty playbook when file missing", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "playbook.yaml");
      const playbook = await loadPlaybook(file);
      expect(playbook.bullets.length).toBe(0);
      expect(playbook.metadata.createdAt).toBeTruthy();
    });
  });

  it("loads valid YAML playbook", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "playbook.yaml");
      const pb = createEmptyPlaybook("test");
      pb.bullets = [
        createTestBullet({ content: "Rule 1", category: "testing" }),
        createTestBullet({ content: "Rule 2", category: "style" }),
      ];
      await fs.writeFile(file, yaml.stringify(pb));

      const loaded = await loadPlaybook(file);
      expect(loaded.bullets.length).toBe(2);
      expect(loaded.bullets[0].content).toBe("Rule 1");
      expect(loaded.bullets[1].content).toBe("Rule 2");
    });
  });

  it("returns empty playbook for empty file", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "playbook.yaml");
      await fs.writeFile(file, "");

      const loaded = await loadPlaybook(file);
      expect(loaded.bullets.length).toBe(0);
    });
  });

  it("returns empty playbook for whitespace-only file", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "playbook.yaml");
      await fs.writeFile(file, "   \n  \n  ");

      const loaded = await loadPlaybook(file);
      expect(loaded.bullets.length).toBe(0);
    });
  });

  it("throws on invalid YAML structure", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "playbook.yaml");
      // Invalid playbook - missing required metadata
      await fs.writeFile(file, yaml.stringify({ bullets: [], invalid: true }));

      await expect(loadPlaybook(file)).rejects.toThrow();
    });
  });

  it("preserves all bullet fields", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "playbook.yaml");
      const bullet = createTestBullet({
        content: "Test content",
        category: "testing",
        maturity: "proven",
        helpfulCount: 10,
        harmfulCount: 2,
        pinned: true,
        tags: ["important", "verified"],
      });
      const pb = createEmptyPlaybook("test");
      pb.bullets = [bullet];
      await fs.writeFile(file, yaml.stringify(pb));

      const loaded = await loadPlaybook(file);
      const loadedBullet = loaded.bullets[0];
      expect(loadedBullet.maturity).toBe("proven");
      expect(loadedBullet.helpfulCount).toBe(10);
      expect(loadedBullet.harmfulCount).toBe(2);
      expect(loadedBullet.pinned).toBe(true);
      expect(loadedBullet.tags).toContain("important");
    });
  });
});

// =============================================================================
// loadMergedPlaybook
// =============================================================================
describe("loadMergedPlaybook", () => {
  const originalCwd = process.cwd();
  const originalHome = process.env.HOME;

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalHome !== undefined) process.env.HOME = originalHome;
  });

  it.serial("merges global and repo playbooks, with repo overriding duplicate ids", async () => {
    await withTempDir(async (dir) => {
      const home = path.join(dir, "home");
      const repo = path.join(dir, "repo");
      process.env.HOME = home;
      await fs.mkdir(home, { recursive: true });
      await fs.mkdir(repo, { recursive: true });
      process.chdir(repo);

      const globalPath = path.join(home, ".cass-memory", "playbook.yaml");
      const repoPath = path.join(repo, ".cass", "playbook.yaml");

      const globalPb = createEmptyPlaybook("global");
      const repoPb = createEmptyPlaybook("repo");

      const sharedId = "b-shared";
      globalPb.bullets = [
        createTestBullet({ id: sharedId, content: "global-content" }),
        createTestBullet({ id: "b-global", content: "only-global" }),
      ];
      repoPb.bullets = [
        createTestBullet({ id: sharedId, content: "repo-content" }),
        createTestBullet({ id: "b-repo", content: "only-repo" }),
      ];

      await writePlaybookFile(globalPath, globalPb);
      await writePlaybookFile(repoPath, repoPb);

      const config = createTestConfig({ playbookPath: globalPath });
      const merged = await loadMergedPlaybook(config);

      expect(merged.bullets.length).toBe(3);
      const shared = merged.bullets.find((b) => b.id === sharedId)!;
      expect(shared.content).toBe("repo-content");
      expect(merged.bullets.some((b) => b.content === "only-global")).toBe(true);
      expect(merged.bullets.some((b) => b.content === "only-repo")).toBe(true);
    });
  });

  it.serial("filters bullets present in blocked logs (global or repo)", async () => {
    await withTempDir(async (dir) => {
      const home = path.join(dir, "home");
      const repo = path.join(dir, "repo");
      process.env.HOME = home;
      await fs.mkdir(home, { recursive: true });
      await fs.mkdir(repo, { recursive: true });
      process.chdir(repo);

      const globalPath = path.join(home, ".cass-memory", "playbook.yaml");
      const repoPath = path.join(repo, ".cass", "playbook.yaml");

      const blockedContent = "bad rule to block";
      const globalPb = createEmptyPlaybook("global");
      globalPb.bullets = [
        createTestBullet({ id: "b-keep", content: "keep me" }),
        createTestBullet({ id: "b-blocked", content: blockedContent }),
      ];

      const repoPb = createEmptyPlaybook("repo");
      repoPb.bullets = [
        createTestBullet({ id: "b-repo-keep", content: "repo keep" }),
      ];

      await writePlaybookFile(globalPath, globalPb);
      await writePlaybookFile(repoPath, repoPb);

      const globalBlockedPath = path.join(home, ".cass-memory", "blocked.log");
      const repoBlockedPath = path.join(repo, ".cass", "blocked.log");
      const blockedEntry = {
        id: "t-1",
        content: blockedContent,
        reason: "blocked",
        forgottenAt: new Date().toISOString(),
      };
      await fs.mkdir(path.dirname(globalBlockedPath), { recursive: true });
      await fs.mkdir(path.dirname(repoBlockedPath), { recursive: true });
      await fs.writeFile(globalBlockedPath, JSON.stringify(blockedEntry) + "\n");
      await fs.writeFile(repoBlockedPath, JSON.stringify(blockedEntry) + "\n");

      const config = createTestConfig({ playbookPath: globalPath });
      const merged = await loadMergedPlaybook(config);

      const contents = merged.bullets.map((b) => b.content);
      expect(contents).not.toContain(blockedContent);
      expect(contents).toContain("keep me");
      expect(contents).toContain("repo keep");
    });
  });
});

// =============================================================================
// savePlaybook
// =============================================================================
describe("savePlaybook", () => {
  it("saves playbook to YAML file", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "playbook.yaml");
      const pb = createEmptyPlaybook("test");
      pb.bullets = [createTestBullet({ content: "Rule", category: "test" })];

      await savePlaybook(pb, file);

      const content = await fs.readFile(file, "utf-8");
      expect(content).toContain("Rule");
      expect(content).toContain("test");
    });
  });

  it("updates lastReflection timestamp", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "playbook.yaml");
      const pb = createEmptyPlaybook("test");
      const beforeSave = pb.metadata.lastReflection;

      await savePlaybook(pb, file);

      expect(pb.metadata.lastReflection).toBeTruthy();
      expect(pb.metadata.lastReflection).not.toBe(beforeSave);
    });
  });

  it("creates parent directories", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "nested/deep/playbook.yaml");
      const pb = createEmptyPlaybook("test");

      await savePlaybook(pb, file);

      const stats = await fs.stat(file);
      expect(stats.isFile()).toBe(true);
    });
  });

  it("overwrites existing file", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "playbook.yaml");

      // Save first version
      const pb1 = createEmptyPlaybook("v1");
      pb1.bullets = [createTestBullet({ content: "Old rule", category: "test" })];
      await savePlaybook(pb1, file);

      // Save second version
      const pb2 = createEmptyPlaybook("v2");
      pb2.bullets = [createTestBullet({ content: "New rule", category: "test" })];
      await savePlaybook(pb2, file);

      const loaded = await loadPlaybook(file);
      expect(loaded.bullets[0].content).toBe("New rule");
    });
  });
});

// =============================================================================
// saves and loads playbook roundtrip (original test)
// =============================================================================
describe("playbook roundtrip", () => {
  it("saves and loads playbook roundtrip", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "playbook.yaml");
      const pb = createEmptyPlaybook("test");
      const bullet = addBullet(
        pb,
        { content: "Test rule content", category: "testing" },
        "~/.cursor/sessions/abc.jsonl"
      );
      expect(bullet.id).toMatch(/^b-/);
      await savePlaybook(pb, file);

      const reloaded = await loadPlaybook(file);
      expect(reloaded.bullets.length).toBe(1);
      const loadedBullet = reloaded.bullets[0];
      expect(loadedBullet.content).toBe("Test rule content");
      expect(loadedBullet.category).toBe("testing");
      expect(loadedBullet.sourceAgents).toContain("cursor");
    });
  });
});

// =============================================================================
// addBullet
// =============================================================================
describe("addBullet", () => {
  it("adds bullet with generated ID", () => {
    const pb = createEmptyPlaybook();
    const bullet = addBullet(
      pb,
      { content: "New rule", category: "testing" },
      "/path/session.jsonl"
    );

    expect(bullet.id).toMatch(/^b-/);
    expect(pb.bullets.length).toBe(1);
  });

  it("sets content and category from data", () => {
    const pb = createEmptyPlaybook();
    const bullet = addBullet(
      pb,
      { content: "Rule content", category: "style" },
      "/path/session.jsonl"
    );

    expect(bullet.content).toBe("Rule content");
    expect(bullet.category).toBe("style");
  });

  it("sets default values for optional fields", () => {
    const pb = createEmptyPlaybook();
    const bullet = addBullet(
      pb,
      { content: "Rule", category: "test" },
      "/path/session.jsonl"
    );

    expect(bullet.scope).toBe("global");
    expect(bullet.type).toBe("rule");
    expect(bullet.kind).toBe("workflow_rule");
    expect(bullet.state).toBe("draft");
    expect(bullet.maturity).toBe("candidate");
    expect(bullet.helpfulCount).toBe(0);
    expect(bullet.harmfulCount).toBe(0);
    expect(bullet.pinned).toBe(false);
    expect(bullet.deprecated).toBe(false);
  });

  it("extracts agent from session path", () => {
    const pb = createEmptyPlaybook();
    const bullet = addBullet(
      pb,
      { content: "Rule", category: "test" },
      "~/.claude-code/sessions/abc.jsonl"
    );

    expect(bullet.sourceAgents).toContain("claude");
    expect(bullet.sourceSessions).toContain("~/.claude-code/sessions/abc.jsonl");
  });

  it("accepts custom kind", () => {
    const pb = createEmptyPlaybook();
    const bullet = addBullet(
      pb,
      { content: "Rule", category: "test", kind: "project_convention" },
      "/path/session.jsonl"
    );

    expect(bullet.kind).toBe("project_convention");
  });

  it("accepts custom scope", () => {
    const pb = createEmptyPlaybook();
    const bullet = addBullet(
      pb,
      { content: "Rule", category: "test", scope: "workspace" },
      "/path/session.jsonl"
    );

    expect(bullet.scope).toBe("workspace");
  });

  it("accepts tags", () => {
    const pb = createEmptyPlaybook();
    const bullet = addBullet(
      pb,
      { content: "Rule", category: "test", tags: ["tag1", "tag2"] },
      "/path/session.jsonl"
    );

    expect(bullet.tags).toContain("tag1");
    expect(bullet.tags).toContain("tag2");
  });

  it("sets timestamps", () => {
    const pb = createEmptyPlaybook();
    const bullet = addBullet(
      pb,
      { content: "Rule", category: "test" },
      "/path/session.jsonl"
    );

    expect(bullet.createdAt).toBeTruthy();
    expect(bullet.updatedAt).toBeTruthy();
  });

  it("uses custom decay half-life", () => {
    const pb = createEmptyPlaybook();
    const bullet = addBullet(
      pb,
      { content: "Rule", category: "test" },
      "/path/session.jsonl",
      60
    );

    expect(bullet.confidenceDecayHalfLifeDays).toBe(60);
  });
});

// =============================================================================
// findBullet
// =============================================================================
describe("findBullet", () => {
  it("finds bullet by ID", () => {
    const pb = createEmptyPlaybook();
    const bullet = createTestBullet({ id: "b-123", content: "Test" });
    pb.bullets = [bullet];

    const found = findBullet(pb, "b-123");
    expect(found).toBeDefined();
    expect(found?.content).toBe("Test");
  });

  it("returns undefined for non-existent ID", () => {
    const pb = createEmptyPlaybook();
    pb.bullets = [createTestBullet({ id: "b-123" })];

    const found = findBullet(pb, "b-999");
    expect(found).toBeUndefined();
  });

  it("returns undefined for empty playbook", () => {
    const pb = createEmptyPlaybook();

    const found = findBullet(pb, "b-123");
    expect(found).toBeUndefined();
  });

  it("finds first match when multiple bullets exist", () => {
    const pb = createEmptyPlaybook();
    pb.bullets = [
      createTestBullet({ id: "b-1", content: "First" }),
      createTestBullet({ id: "b-2", content: "Second" }),
      createTestBullet({ id: "b-3", content: "Third" }),
    ];

    const found = findBullet(pb, "b-2");
    expect(found?.content).toBe("Second");
  });
});

// =============================================================================
// deprecateBullet
// =============================================================================
describe("deprecateBullet", () => {
  it("deprecates bullet with reason and replacedBy", () => {
    const pb = createEmptyPlaybook();
    const bullet = addBullet(
      pb,
      { content: "Rule to deprecate", category: "testing" },
      "~/.cursor/sessions/abc.jsonl"
    );

    const ok = deprecateBullet(pb, bullet.id, "Superseded", "new-id");

    expect(ok).toBe(true);
    const updated = findBullet(pb, bullet.id)!;
    expect(updated.deprecated).toBe(true);
    expect(updated.state).toBe("retired");
    expect(updated.maturity).toBe("deprecated");
    expect(updated.deprecationReason).toBe("Superseded");
    expect(updated.replacedBy).toBe("new-id");
    expect(updated.deprecatedAt).toBeTruthy();
  });

  it("returns false for non-existent bullet", () => {
    const pb = createEmptyPlaybook();

    const ok = deprecateBullet(pb, "non-existent", "reason");
    expect(ok).toBe(false);
  });

  it("deprecates without replacedBy", () => {
    const pb = createEmptyPlaybook();
    const bullet = addBullet(pb, { content: "Rule", category: "test" }, "/s.jsonl");

    const ok = deprecateBullet(pb, bullet.id, "No longer needed");

    expect(ok).toBe(true);
    const updated = findBullet(pb, bullet.id)!;
    expect(updated.deprecated).toBe(true);
    expect(updated.replacedBy).toBeUndefined();
  });

  it("updates updatedAt timestamp", async () => {
    const pb = createEmptyPlaybook();
    const bullet = addBullet(pb, { content: "Rule", category: "test" }, "/s.jsonl");
    const originalUpdatedAt = bullet.updatedAt;

    // Small delay to ensure different timestamp
    await new Promise((r) => setTimeout(r, 10));
    deprecateBullet(pb, bullet.id, "reason");

    const updated = findBullet(pb, bullet.id)!;
    expect(updated.updatedAt).not.toBe(originalUpdatedAt);
  });
});

// =============================================================================
// getActiveBullets
// =============================================================================
describe("getActiveBullets", () => {
  it("returns empty array for empty playbook", () => {
    const pb = createEmptyPlaybook();
    expect(getActiveBullets(pb)).toEqual([]);
  });

  it("returns all non-deprecated bullets", () => {
    const pb = createEmptyPlaybook();
    pb.bullets = [
      createTestBullet({ id: "b-1", content: "Active 1" }),
      createTestBullet({ id: "b-2", content: "Active 2" }),
    ];

    const active = getActiveBullets(pb);
    expect(active.length).toBe(2);
  });

  it("excludes deprecated bullets", () => {
    const pb = createEmptyPlaybook();
    pb.bullets = [
      createTestBullet({ id: "b-1", content: "Active", deprecated: false }),
      createTestBullet({ id: "b-2", content: "Deprecated", deprecated: true }),
    ];

    const active = getActiveBullets(pb);
    expect(active.length).toBe(1);
    expect(active[0].content).toBe("Active");
  });

  it("excludes retired state bullets", () => {
    const pb = createEmptyPlaybook();
    pb.bullets = [
      createTestBullet({ id: "b-1", content: "Active", state: "active" }),
      createTestBullet({ id: "b-2", content: "Retired", state: "retired" }),
    ];

    const active = getActiveBullets(pb);
    expect(active.length).toBe(1);
    expect(active[0].content).toBe("Active");
  });

  it("excludes deprecated maturity bullets", () => {
    const pb = createEmptyPlaybook();
    pb.bullets = [
      createTestBullet({ id: "b-1", content: "Active", maturity: "proven" }),
      createTestBullet({ id: "b-2", content: "Deprecated", maturity: "deprecated" }),
    ];

    const active = getActiveBullets(pb);
    expect(active.length).toBe(1);
    expect(active[0].content).toBe("Active");
  });
});

// =============================================================================
// getBulletsByCategory
// =============================================================================
describe("getBulletsByCategory", () => {
  it("returns empty array for no matches", () => {
    const pb = createEmptyPlaybook();
    pb.bullets = [createTestBullet({ category: "testing" })];

    const result = getBulletsByCategory(pb, "style");
    expect(result).toEqual([]);
  });

  it("returns matching bullets", () => {
    const pb = createEmptyPlaybook();
    pb.bullets = [
      createTestBullet({ id: "b-1", category: "testing" }),
      createTestBullet({ id: "b-2", category: "style" }),
      createTestBullet({ id: "b-3", category: "testing" }),
    ];

    const result = getBulletsByCategory(pb, "testing");
    expect(result.length).toBe(2);
  });

  it("is case-insensitive", () => {
    const pb = createEmptyPlaybook();
    pb.bullets = [createTestBullet({ category: "Testing" })];

    const result = getBulletsByCategory(pb, "testing");
    expect(result.length).toBe(1);
  });

  it("excludes deprecated bullets", () => {
    const pb = createEmptyPlaybook();
    pb.bullets = [
      createTestBullet({ id: "b-1", category: "testing", deprecated: false }),
      createTestBullet({ id: "b-2", category: "testing", deprecated: true }),
    ];

    const result = getBulletsByCategory(pb, "testing");
    expect(result.length).toBe(1);
  });
});

// =============================================================================
// exportToMarkdown
// =============================================================================
describe("exportToMarkdown", () => {
  it("generates markdown header", () => {
    const pb = createEmptyPlaybook();
    const md = exportToMarkdown(pb);
    expect(md).toContain("## Agent Playbook");
  });

  it("includes category sections", () => {
    const pb = createEmptyPlaybook();
    pb.bullets = [
      createTestBullet({ content: "Rule 1", category: "testing" }),
      createTestBullet({ content: "Rule 2", category: "style" }),
    ];

    const md = exportToMarkdown(pb);
    expect(md).toContain("### testing");
    expect(md).toContain("### style");
  });

  it("includes bullet content", () => {
    const pb = createEmptyPlaybook();
    pb.bullets = [createTestBullet({ content: "Always write tests", category: "testing" })];

    const md = exportToMarkdown(pb);
    expect(md).toContain("- Always write tests");
  });

  it("shows counts when option enabled", () => {
    const pb = createEmptyPlaybook();
    pb.bullets = [
      createTestBullet({ content: "Rule", category: "test", helpfulCount: 5, harmfulCount: 1 }),
    ];

    const md = exportToMarkdown(pb, { showCounts: true });
    expect(md).toContain("(5+ / 1-)");
  });

  it("respects topN limit", () => {
    const pb = createEmptyPlaybook();
    pb.bullets = [
      createTestBullet({ content: "Rule 1", category: "test" }),
      createTestBullet({ content: "Rule 2", category: "test" }),
      createTestBullet({ content: "Rule 3", category: "test" }),
    ];

    const md = exportToMarkdown(pb, { topN: 2 });
    expect(md).toContain("Rule 1");
    expect(md).toContain("Rule 2");
    expect(md).not.toContain("Rule 3");
  });

  it("includes anti-patterns section when enabled", () => {
    const pb = createEmptyPlaybook();
    pb.bullets = [
      createTestBullet({ content: "Good rule", category: "test", type: "rule" }),
      createTestBullet({ content: "Bad pattern", category: "test", type: "anti-pattern" }),
    ];

    const md = exportToMarkdown(pb, { includeAntiPatterns: true });
    expect(md).toContain("PITFALLS");
    expect(md).toContain("Bad pattern");
  });

  it("excludes anti-patterns by default", () => {
    const pb = createEmptyPlaybook();
    pb.bullets = [
      createTestBullet({ content: "Good rule", category: "test", type: "rule" }),
      createTestBullet({ content: "Bad pattern", category: "test", type: "anti-pattern" }),
    ];

    const md = exportToMarkdown(pb);
    expect(md).not.toContain("PITFALLS");
  });

  it("excludes deprecated bullets", () => {
    const pb = createEmptyPlaybook();
    pb.bullets = [
      createTestBullet({ content: "Active rule", category: "test", deprecated: false }),
      createTestBullet({ content: "Old rule", category: "test", deprecated: true }),
    ];

    const md = exportToMarkdown(pb);
    expect(md).toContain("Active rule");
    expect(md).not.toContain("Old rule");
  });
});

// =============================================================================
// loadBlockedLog (deprecated alias: loadToxicLog)
// =============================================================================
describe("loadBlockedLog", () => {
  it("returns empty array for non-existent file", async () => {
    await withTempDir(async (dir) => {
      const logPath = path.join(dir, "blocked.log");
      const entries = await loadBlockedLog(logPath);
      expect(entries).toEqual([]);
    });
  });

  it("loads valid blocked entries", async () => {
    await withTempDir(async (dir) => {
      const logPath = path.join(dir, "blocked.log");
      const entry: BlockedEntry = {
        id: "t-1",
        content: "Blocked rule",
        reason: "Caused bugs",
        forgottenAt: "2024-01-01T00:00:00Z",
      };
      await fs.writeFile(logPath, JSON.stringify(entry) + "\n");

      const entries = await loadBlockedLog(logPath);
      expect(entries.length).toBe(1);
      expect(entries[0].content).toBe("Blocked rule");
    });
  });

  it("loads multiple entries", async () => {
    await withTempDir(async (dir) => {
      const logPath = path.join(dir, "blocked.log");
      const lines = [
        JSON.stringify({ id: "t-1", content: "Blocked 1", reason: "r1", forgottenAt: "2024-01-01" }),
        JSON.stringify({ id: "t-2", content: "Blocked 2", reason: "r2", forgottenAt: "2024-01-02" }),
      ].join("\n");
      await fs.writeFile(logPath, lines + "\n");

      const entries = await loadBlockedLog(logPath);
      expect(entries.length).toBe(2);
    });
  });

  it("skips malformed lines", async () => {
    await withTempDir(async (dir) => {
      const logPath = path.join(dir, "blocked.log");
      const lines = [
        JSON.stringify({ id: "t-1", content: "Valid", reason: "r", forgottenAt: "2024-01-01" }),
        "not valid json",
        JSON.stringify({ id: "t-2", content: "Also valid", reason: "r", forgottenAt: "2024-01-02" }),
      ].join("\n");
      await fs.writeFile(logPath, lines + "\n");

      const entries = await loadBlockedLog(logPath);
      expect(entries.length).toBe(2);
    });
  });

  it("skips empty lines", async () => {
    await withTempDir(async (dir) => {
      const logPath = path.join(dir, "blocked.log");
      const lines = [
        JSON.stringify({ id: "t-1", content: "Valid", reason: "r", forgottenAt: "2024-01-01" }),
        "",
        "   ",
        JSON.stringify({ id: "t-2", content: "Also valid", reason: "r", forgottenAt: "2024-01-02" }),
      ].join("\n");
      await fs.writeFile(logPath, lines);

      const entries = await loadBlockedLog(logPath);
      expect(entries.length).toBe(2);
    });
  });

  it("skips entries without required id field", async () => {
    await withTempDir(async (dir) => {
      const logPath = path.join(dir, "blocked.log");
      const lines = [
        JSON.stringify({ content: "No ID", reason: "r", forgottenAt: "2024-01-01" }),
        JSON.stringify({ id: "t-1", content: "Has ID", reason: "r", forgottenAt: "2024-01-01" }),
      ].join("\n");
      await fs.writeFile(logPath, lines);

      const entries = await loadBlockedLog(logPath);
      expect(entries.length).toBe(1);
      expect(entries[0].id).toBe("t-1");
    });
  });
});

// =============================================================================
// appendBlockedLog (deprecated alias: appendToxicLog)
// =============================================================================
describe("appendBlockedLog", () => {
  it("appends entry to new file", async () => {
    await withTempDir(async (dir) => {
      const logPath = path.join(dir, "blocked.log");
      const entry: BlockedEntry = {
        id: "t-1",
        content: "Blocked rule",
        reason: "Bad",
        forgottenAt: "2024-01-01T00:00:00Z",
      };

      await appendBlockedLog(entry, logPath);

      const content = await fs.readFile(logPath, "utf-8");
      expect(content).toContain("Blocked rule");
    });
  });

  it("appends to existing file", async () => {
    await withTempDir(async (dir) => {
      const logPath = path.join(dir, "blocked.log");
      const entry1: BlockedEntry = { id: "t-1", content: "First", reason: "r", forgottenAt: "2024-01-01" };
      const entry2: BlockedEntry = { id: "t-2", content: "Second", reason: "r", forgottenAt: "2024-01-02" };

      await appendBlockedLog(entry1, logPath);
      await appendBlockedLog(entry2, logPath);

      const entries = await loadBlockedLog(logPath);
      expect(entries.length).toBe(2);
    });
  });

  it("creates parent directories", async () => {
    await withTempDir(async (dir) => {
      const logPath = path.join(dir, "nested/deep/blocked.log");
      const entry: BlockedEntry = { id: "t-1", content: "Test", reason: "r", forgottenAt: "2024-01-01" };

      await appendBlockedLog(entry, logPath);

      const stats = await fs.stat(logPath);
      expect(stats.isFile()).toBe(true);
    });
  });
});

// =============================================================================
// computeFullStats
// =============================================================================
describe("computeFullStats", () => {
  const config = createTestConfig();

  it("returns zero counts for empty playbook", () => {
    const pb = createEmptyPlaybook();
    const stats = computeFullStats(pb, config);

    expect(stats.total).toBe(0);
    expect(stats.byScope.global).toBe(0);
    expect(stats.byScope.workspace).toBe(0);
  });

  it("counts bullets by scope", () => {
    const pb = createEmptyPlaybook();
    pb.bullets = [
      createTestBullet({ scope: "global" }),
      createTestBullet({ scope: "global" }),
      createTestBullet({ scope: "workspace" }),
    ];

    const stats = computeFullStats(pb, config);
    expect(stats.byScope.global).toBe(2);
    expect(stats.byScope.workspace).toBe(1);
  });

  it("counts bullets by maturity", () => {
    const pb = createEmptyPlaybook();
    pb.bullets = [
      createTestBullet({ maturity: "candidate" }),
      createTestBullet({ maturity: "established" }),
      createTestBullet({ maturity: "proven" }),
      createTestBullet({ maturity: "proven" }),
    ];

    const stats = computeFullStats(pb, config);
    expect(stats.byMaturity.candidate).toBe(1);
    expect(stats.byMaturity.established).toBe(1);
    expect(stats.byMaturity.proven).toBe(2);
  });

  it("counts bullets by type", () => {
    const pb = createEmptyPlaybook();
    pb.bullets = [
      createTestBullet({ type: "rule" }),
      createTestBullet({ type: "rule" }),
      createTestBullet({ type: "anti-pattern" }),
    ];

    const stats = computeFullStats(pb, config);
    expect(stats.byType.rule).toBe(2);
    expect(stats.byType.antiPattern).toBe(1);
  });

  it("excludes deprecated bullets from stats", () => {
    const pb = createEmptyPlaybook();
    pb.bullets = [
      createTestBullet({ content: "Active" }),
      createTestBullet({ content: "Deprecated", deprecated: true }),
    ];

    const stats = computeFullStats(pb, config);
    expect(stats.total).toBe(1);
  });

  it("calculates score distribution", () => {
    const pb = createEmptyPlaybook();
    pb.bullets = [
      createTestBullet({ helpfulCount: 10, harmfulCount: 0 }), // excellent
      createTestBullet({ helpfulCount: 3, harmfulCount: 0 }),  // good
      createTestBullet({ helpfulCount: 0, harmfulCount: 0 }),  // neutral
    ];

    const stats = computeFullStats(pb, config);
    // Score distribution depends on scoring.ts getEffectiveScore
    expect(stats.scoreDistribution.excellent +
           stats.scoreDistribution.good +
           stats.scoreDistribution.neutral +
           stats.scoreDistribution.atRisk).toBe(3);
  });
});
