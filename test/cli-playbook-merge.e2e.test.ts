/**
 * E2E Tests for Playbook Merge - Global plus Repo Playbooks
 *
 * Tests the merging of bullets from multiple playbook sources:
 * - Global playbook (~/.cass-memory/playbook.yaml)
 * - Repo playbook (.cass/playbook.yaml)
 */
import { describe, expect, it } from "bun:test";
import { execSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import yaml from "yaml";
import { loadConfig } from "../src/config.js";
import { loadMergedPlaybook } from "../src/playbook.js";
import { TestEnv, withTempCassHome } from "./helpers/temp.js";

// Helper to initialize a git repo so resolveRepoDir() can find it
function initGitRepo(dir: string): void {
  execSync("git init", { cwd: dir, stdio: "pipe" });
}

// Helper to create a valid test playbook
function createTestPlaybook(bullets: any[] = [], deprecatedPatterns: any[] = []) {
  const now = new Date().toISOString();
  return {
    schema_version: 2,
    name: "test-playbook",
    description: "Test playbook for E2E tests",
    metadata: {
      createdAt: now,
      totalReflections: 0,
      totalSessionsProcessed: 0,
    },
    bullets: bullets,
    deprecatedPatterns: deprecatedPatterns,
  };
}

// Helper to create a valid test bullet
function createTestBullet(
  overrides: Partial<{
    id: string;
    content: string;
    kind: string;
    category: string;
    scope: string;
    workspace?: string;
    tags: string[];
    maturity: string;
    isNegative?: boolean;
    effectiveScore?: number;
    helpfulCount?: number;
    harmfulCount?: number;
  }> = {},
) {
  const now = new Date().toISOString();
  return {
    id: overrides.id || `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    content: overrides.content || "Test bullet content",
    kind: overrides.kind || "stack_pattern",
    category: overrides.category || "testing",
    scope: overrides.scope || "global",
    workspace: overrides.workspace,
    tags: overrides.tags || [],
    maturity: overrides.maturity || "candidate",
    isNegative: overrides.isNegative || false,
    effectiveScore: overrides.effectiveScore ?? 0.8,
    state: "active",
    type: overrides.isNegative ? "anti-pattern" : "rule",
    helpfulCount: overrides.helpfulCount ?? 0,
    harmfulCount: overrides.harmfulCount ?? 0,
    createdAt: now,
    updatedAt: now,
  };
}

describe("E2E: Playbook Merge - Global plus Repo", () => {
  describe("Global + Repo Merge", () => {
    it("returns only global bullets when no repo playbook exists", async () => {
      await withTempCassHome(async (env) => {
        const globalPlaybook = createTestPlaybook([
          createTestBullet({ id: "global-1", content: "Global rule 1", category: "global" }),
          createTestBullet({ id: "global-2", content: "Global rule 2", category: "global" }),
          createTestBullet({ id: "global-3", content: "Global rule 3", category: "global" }),
        ]);
        await writeFile(env.playbookPath, yaml.stringify(globalPlaybook));

        const config = await loadConfig();
        const merged = await loadMergedPlaybook(config);

        expect(merged.bullets.length).toBe(3);
        expect(merged.bullets.every((b) => b.id.startsWith("global-"))).toBe(true);
      });
    });

    it("merges bullets from global and repo playbooks", async () => {
      await withTempCassHome(async (env) => {
        // Create global playbook
        const globalPlaybook = createTestPlaybook([
          createTestBullet({ id: "global-1", content: "Global rule 1", category: "global" }),
          createTestBullet({ id: "global-2", content: "Global rule 2", category: "global" }),
          createTestBullet({ id: "global-3", content: "Global rule 3", category: "global" }),
        ]);
        await writeFile(env.playbookPath, yaml.stringify(globalPlaybook));

        // Create repo playbook in cwd
        const repoDir = path.join(env.home, "test-repo", ".cass");
        await mkdir(repoDir, { recursive: true });

        const repoPlaybook = createTestPlaybook([
          createTestBullet({ id: "repo-1", content: "Repo rule 1", category: "repo" }),
          createTestBullet({ id: "repo-2", content: "Repo rule 2", category: "repo" }),
        ]);
        await writeFile(path.join(repoDir, "playbook.yaml"), yaml.stringify(repoPlaybook));

        // Initialize git repo so resolveRepoDir() can find it
        initGitRepo(path.join(env.home, "test-repo"));

        // Change to repo directory
        const originalCwd = process.cwd();
        process.chdir(path.join(env.home, "test-repo"));

        try {
          const config = await loadConfig();
          const merged = await loadMergedPlaybook(config);

          // Should have all 5 bullets
          expect(merged.bullets.length).toBe(5);

          const globalBullets = merged.bullets.filter((b) => b.id.startsWith("global-"));
          const repoBullets = merged.bullets.filter((b) => b.id.startsWith("repo-"));

          expect(globalBullets.length).toBe(3);
          expect(repoBullets.length).toBe(2);
        } finally {
          process.chdir(originalCwd);
        }
      });
    });

    it("repo bullets override global bullets with same ID", async () => {
      await withTempCassHome(async (env) => {
        // Create global playbook with a bullet
        const globalPlaybook = createTestPlaybook([
          createTestBullet({
            id: "shared-bullet",
            content: "Global version of the rule",
            category: "global",
            helpfulCount: 5,
          }),
        ]);
        await writeFile(env.playbookPath, yaml.stringify(globalPlaybook));

        // Create repo playbook with same bullet ID but different content
        const repoDir = path.join(env.home, "test-repo", ".cass");
        await mkdir(repoDir, { recursive: true });

        const repoPlaybook = createTestPlaybook([
          createTestBullet({
            id: "shared-bullet",
            content: "Repo version of the rule (takes precedence)",
            category: "repo",
            helpfulCount: 10,
          }),
        ]);
        await writeFile(path.join(repoDir, "playbook.yaml"), yaml.stringify(repoPlaybook));

        // Initialize git repo so resolveRepoDir() can find it
        initGitRepo(path.join(env.home, "test-repo"));

        const originalCwd = process.cwd();
        process.chdir(path.join(env.home, "test-repo"));

        try {
          const config = await loadConfig();
          const merged = await loadMergedPlaybook(config);

          // Should have only 1 bullet (deduplicated by ID)
          expect(merged.bullets.length).toBe(1);

          // Repo version should win
          const bullet = merged.bullets[0];
          expect(bullet.content).toBe("Repo version of the rule (takes precedence)");
          expect(bullet.category).toBe("repo");
          expect(bullet.helpfulCount).toBe(10);
        } finally {
          process.chdir(originalCwd);
        }
      });
    });
  });

  describe("Deprecated Patterns Merge", () => {
    it("merges deprecated patterns from both playbooks", async () => {
      await withTempCassHome(async (env) => {
        const now = new Date().toISOString();

        // Create global playbook with deprecated patterns
        const globalPlaybook = createTestPlaybook(
          [],
          [
            { pattern: "eval\\(", reason: "Security risk", deprecatedAt: now },
            { pattern: "\\bany\\b", reason: "Type safety", deprecatedAt: now },
          ],
        );
        await writeFile(env.playbookPath, yaml.stringify(globalPlaybook));

        // Create repo playbook with additional deprecated patterns
        const repoDir = path.join(env.home, "test-repo", ".cass");
        await mkdir(repoDir, { recursive: true });

        const repoPlaybook = createTestPlaybook(
          [],
          [{ pattern: "console\\.log", reason: "Use logger instead", deprecatedAt: now }],
        );
        await writeFile(path.join(repoDir, "playbook.yaml"), yaml.stringify(repoPlaybook));

        // Initialize git repo so resolveRepoDir() can find it
        initGitRepo(path.join(env.home, "test-repo"));

        const originalCwd = process.cwd();
        process.chdir(path.join(env.home, "test-repo"));

        try {
          const config = await loadConfig();
          const merged = await loadMergedPlaybook(config);

          // Should have all 3 deprecated patterns
          expect(merged.deprecatedPatterns.length).toBe(3);

          const patterns = merged.deprecatedPatterns.map((p) => p.pattern);
          expect(patterns).toContain("eval\\(");
          expect(patterns).toContain("\\bany\\b");
          expect(patterns).toContain("console\\.log");
        } finally {
          process.chdir(originalCwd);
        }
      });
    });
  });

  describe("Scope Handling", () => {
    it("preserves scope information in merged bullets", async () => {
      await withTempCassHome(async (env) => {
        // Create global playbook with global-scoped bullet
        const globalPlaybook = createTestPlaybook([
          createTestBullet({
            id: "global-scoped",
            content: "Applies everywhere",
            scope: "global",
          }),
        ]);
        await writeFile(env.playbookPath, yaml.stringify(globalPlaybook));

        // Create repo playbook with workspace-scoped bullet
        const repoDir = path.join(env.home, "test-repo", ".cass");
        await mkdir(repoDir, { recursive: true });

        const repoPlaybook = createTestPlaybook([
          createTestBullet({
            id: "workspace-scoped",
            content: "Only for frontend workspace",
            scope: "workspace",
            workspace: "frontend",
          }),
        ]);
        await writeFile(path.join(repoDir, "playbook.yaml"), yaml.stringify(repoPlaybook));

        // Initialize git repo so resolveRepoDir() can find it
        initGitRepo(path.join(env.home, "test-repo"));

        const originalCwd = process.cwd();
        process.chdir(path.join(env.home, "test-repo"));

        try {
          const config = await loadConfig();
          const merged = await loadMergedPlaybook(config);

          expect(merged.bullets.length).toBe(2);

          const globalBullet = merged.bullets.find((b) => b.id === "global-scoped");
          const workspaceBullet = merged.bullets.find((b) => b.id === "workspace-scoped");

          expect(globalBullet?.scope).toBe("global");
          expect(workspaceBullet?.scope).toBe("workspace");
          expect(workspaceBullet?.workspace).toBe("frontend");
        } finally {
          process.chdir(originalCwd);
        }
      });
    });
  });

  describe("Metadata Handling", () => {
    it("uses global metadata in merged playbook", async () => {
      await withTempCassHome(async (env) => {
        const earlyDate = "2024-01-01T00:00:00Z";
        const lateDate = "2024-06-01T00:00:00Z";

        // Create global playbook with early date
        const globalPlaybook = {
          schema_version: 2,
          name: "global-playbook",
          description: "Global description",
          metadata: {
            createdAt: earlyDate,
            totalReflections: 100,
            totalSessionsProcessed: 50,
          },
          bullets: [],
          deprecatedPatterns: [],
        };
        await writeFile(env.playbookPath, yaml.stringify(globalPlaybook));

        // Create repo playbook with later date
        const repoDir = path.join(env.home, "test-repo", ".cass");
        await mkdir(repoDir, { recursive: true });

        const repoPlaybook = {
          schema_version: 2,
          name: "repo-playbook",
          description: "Repo description",
          metadata: {
            createdAt: lateDate,
            totalReflections: 10,
            totalSessionsProcessed: 5,
          },
          bullets: [],
          deprecatedPatterns: [],
        };
        await writeFile(path.join(repoDir, "playbook.yaml"), yaml.stringify(repoPlaybook));

        // Initialize git repo so resolveRepoDir() can find it
        initGitRepo(path.join(env.home, "test-repo"));

        const originalCwd = process.cwd();
        process.chdir(path.join(env.home, "test-repo"));

        try {
          const config = await loadConfig();
          const merged = await loadMergedPlaybook(config);

          // Should use global metadata
          expect(merged.metadata.createdAt).toBe(earlyDate);
          expect(merged.metadata.totalReflections).toBe(100);
          expect(merged.metadata.totalSessionsProcessed).toBe(50);
        } finally {
          process.chdir(originalCwd);
        }
      });
    });
  });

  describe("Multiple Bullets with Same ID", () => {
    it("handles many bullets with unique IDs correctly", async () => {
      await withTempCassHome(async (env) => {
        // Create global playbook with 10 bullets
        const globalBullets = Array.from({ length: 10 }, (_, i) =>
          createTestBullet({
            id: `global-${i}`,
            content: `Global rule ${i}`,
            category: "global",
          }),
        );
        const globalPlaybook = createTestPlaybook(globalBullets);
        await writeFile(env.playbookPath, yaml.stringify(globalPlaybook));

        // Create repo playbook with 5 bullets
        const repoDir = path.join(env.home, "test-repo", ".cass");
        await mkdir(repoDir, { recursive: true });

        const repoBullets = Array.from({ length: 5 }, (_, i) =>
          createTestBullet({
            id: `repo-${i}`,
            content: `Repo rule ${i}`,
            category: "repo",
          }),
        );
        const repoPlaybook = createTestPlaybook(repoBullets);
        await writeFile(path.join(repoDir, "playbook.yaml"), yaml.stringify(repoPlaybook));

        // Initialize git repo so resolveRepoDir() can find it
        initGitRepo(path.join(env.home, "test-repo"));

        const originalCwd = process.cwd();
        process.chdir(path.join(env.home, "test-repo"));

        try {
          const config = await loadConfig();
          const merged = await loadMergedPlaybook(config);

          // Should have all 15 bullets (no ID collision)
          expect(merged.bullets.length).toBe(15);
        } finally {
          process.chdir(originalCwd);
        }
      });
    });

    it("handles partial ID collision correctly", async () => {
      await withTempCassHome(async (env) => {
        // Create global playbook with 5 bullets
        const globalPlaybook = createTestPlaybook([
          createTestBullet({ id: "shared-1", content: "Global shared 1", category: "global" }),
          createTestBullet({ id: "shared-2", content: "Global shared 2", category: "global" }),
          createTestBullet({ id: "global-unique", content: "Global unique", category: "global" }),
        ]);
        await writeFile(env.playbookPath, yaml.stringify(globalPlaybook));

        // Create repo playbook with overlapping IDs
        const repoDir = path.join(env.home, "test-repo", ".cass");
        await mkdir(repoDir, { recursive: true });

        const repoPlaybook = createTestPlaybook([
          createTestBullet({
            id: "shared-1",
            content: "Repo shared 1 (override)",
            category: "repo",
          }),
          createTestBullet({
            id: "shared-2",
            content: "Repo shared 2 (override)",
            category: "repo",
          }),
          createTestBullet({ id: "repo-unique", content: "Repo unique", category: "repo" }),
        ]);
        await writeFile(path.join(repoDir, "playbook.yaml"), yaml.stringify(repoPlaybook));

        // Initialize git repo so resolveRepoDir() can find it
        initGitRepo(path.join(env.home, "test-repo"));

        const originalCwd = process.cwd();
        process.chdir(path.join(env.home, "test-repo"));

        try {
          const config = await loadConfig();
          const merged = await loadMergedPlaybook(config);

          // Should have 4 bullets (2 shared IDs deduplicated)
          expect(merged.bullets.length).toBe(4);

          // Verify repo versions won for shared IDs
          const shared1 = merged.bullets.find((b) => b.id === "shared-1");
          const shared2 = merged.bullets.find((b) => b.id === "shared-2");

          expect(shared1?.content).toBe("Repo shared 1 (override)");
          expect(shared2?.content).toBe("Repo shared 2 (override)");

          // Verify unique bullets exist
          expect(merged.bullets.some((b) => b.id === "global-unique")).toBe(true);
          expect(merged.bullets.some((b) => b.id === "repo-unique")).toBe(true);
        } finally {
          process.chdir(originalCwd);
        }
      });
    });
  });

  describe("Empty Playbooks", () => {
    it("handles empty global playbook with repo bullets", async () => {
      await withTempCassHome(async (env) => {
        // Create empty global playbook
        const globalPlaybook = createTestPlaybook([]);
        await writeFile(env.playbookPath, yaml.stringify(globalPlaybook));

        // Create repo playbook with bullets
        const repoDir = path.join(env.home, "test-repo", ".cass");
        await mkdir(repoDir, { recursive: true });

        const repoPlaybook = createTestPlaybook([
          createTestBullet({ id: "repo-only", content: "Only in repo", category: "repo" }),
        ]);
        await writeFile(path.join(repoDir, "playbook.yaml"), yaml.stringify(repoPlaybook));

        // Initialize git repo so resolveRepoDir() can find it
        initGitRepo(path.join(env.home, "test-repo"));

        const originalCwd = process.cwd();
        process.chdir(path.join(env.home, "test-repo"));

        try {
          const config = await loadConfig();
          const merged = await loadMergedPlaybook(config);

          expect(merged.bullets.length).toBe(1);
          expect(merged.bullets[0].id).toBe("repo-only");
        } finally {
          process.chdir(originalCwd);
        }
      });
    });

    it("handles empty repo playbook gracefully", async () => {
      await withTempCassHome(async (env) => {
        // Create global playbook with bullets
        const globalPlaybook = createTestPlaybook([
          createTestBullet({ id: "global-only", content: "Only in global", category: "global" }),
        ]);
        await writeFile(env.playbookPath, yaml.stringify(globalPlaybook));

        // Create empty repo playbook
        const repoDir = path.join(env.home, "test-repo", ".cass");
        await mkdir(repoDir, { recursive: true });

        const repoPlaybook = createTestPlaybook([]);
        await writeFile(path.join(repoDir, "playbook.yaml"), yaml.stringify(repoPlaybook));

        // Initialize git repo so resolveRepoDir() can find it
        initGitRepo(path.join(env.home, "test-repo"));

        const originalCwd = process.cwd();
        process.chdir(path.join(env.home, "test-repo"));

        try {
          const config = await loadConfig();
          const merged = await loadMergedPlaybook(config);

          expect(merged.bullets.length).toBe(1);
          expect(merged.bullets[0].id).toBe("global-only");
        } finally {
          process.chdir(originalCwd);
        }
      });
    });

    it("handles both playbooks empty", async () => {
      await withTempCassHome(async (env) => {
        // Create empty global playbook
        const globalPlaybook = createTestPlaybook([]);
        await writeFile(env.playbookPath, yaml.stringify(globalPlaybook));

        // Create empty repo playbook
        const repoDir = path.join(env.home, "test-repo", ".cass");
        await mkdir(repoDir, { recursive: true });

        const repoPlaybook = createTestPlaybook([]);
        await writeFile(path.join(repoDir, "playbook.yaml"), yaml.stringify(repoPlaybook));

        // Initialize git repo so resolveRepoDir() can find it
        initGitRepo(path.join(env.home, "test-repo"));

        const originalCwd = process.cwd();
        process.chdir(path.join(env.home, "test-repo"));

        try {
          const config = await loadConfig();
          const merged = await loadMergedPlaybook(config);

          expect(merged.bullets.length).toBe(0);
        } finally {
          process.chdir(originalCwd);
        }
      });
    });
  });
});
