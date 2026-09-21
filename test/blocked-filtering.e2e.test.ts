/**
 * E2E Tests: Blocked Bullet Filtering - Semantic Similarity
 *
 * Tests that blocked bullets prevent similar content from surfacing
 * using exact hash match and Jaccard similarity (>0.85 threshold).
 */
import { afterEach, describe, expect, it } from "bun:test";
import { execSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import yaml from "yaml";
import {
  appendBlockedLog,
  type BlockedEntry,
  createEmptyPlaybook,
  getActiveBullets,
  loadBlockedLog,
  loadMergedPlaybook,
} from "../src/playbook.js";
import type { Playbook } from "../src/types.js";
import { jaccardSimilarity } from "../src/utils.js";
import { createTestBullet, createTestConfig } from "./helpers/index.js";

// --- Helper Functions ---

let tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "blocked-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  tempDirs = [];
});

async function writePlaybookFile(filePath: string, playbook: Playbook) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, yaml.stringify(playbook));
}

async function writeBlockedLog(logPath: string, entries: BlockedEntry[]) {
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await fs.writeFile(logPath, content);
}

// --- Test Suites ---

describe("Blocked Bullet Filtering - E2E", () => {
  describe("Exact Match Blocking", () => {
    it("blocks bullets with exact content match", async () => {
      const dir = await createTempDir();
      const home = path.join(dir, "home");
      const repo = path.join(dir, "repo");
      const originalHome = process.env.HOME;
      const originalCwd = process.cwd();

      try {
        process.env.HOME = home;
        await fs.mkdir(home, { recursive: true });
        await fs.mkdir(repo, { recursive: true });
        process.chdir(repo);

        // Create playbook with eval-related bullet
        const globalPath = path.join(home, ".cass-memory", "playbook.yaml");
        const playbook = createEmptyPlaybook("test");
        playbook.bullets = [
          createTestBullet({ id: "b-eval", content: "Never use eval()" }),
          createTestBullet({ id: "b-keep", content: "Always validate inputs" }),
        ];
        await writePlaybookFile(globalPath, playbook);

        // Add eval rule to blocked list
        const blockedPath = path.join(home, ".cass-memory", "blocked.log");
        await writeBlockedLog(blockedPath, [
          {
            id: "blocked-1",
            content: "Never use eval()",
            reason: "Security: eval is dangerous",
            forgottenAt: new Date().toISOString(),
          },
        ]);

        const config = createTestConfig({ playbookPath: globalPath });
        const merged = await loadMergedPlaybook(config);

        // Eval bullet should be deprecated (blocked)
        const evalBullet = merged.bullets.find((b) => b.content === "Never use eval()");
        expect(evalBullet).toBeDefined();
        expect(evalBullet?.deprecated).toBe(true);
        expect(evalBullet?.deprecationReason).toBe("BLOCKED_CONTENT");

        // But getActiveBullets should exclude it
        const activeContents = getActiveBullets(merged).map((b) => b.content);
        expect(activeContents).not.toContain("Never use eval()");
        expect(activeContents).toContain("Always validate inputs");
      } finally {
        process.env.HOME = originalHome;
        process.chdir(originalCwd);
      }
    });

    it("blocks bullets with hash-equivalent content", async () => {
      const dir = await createTempDir();
      const home = path.join(dir, "home");
      const repo = path.join(dir, "repo");
      const originalHome = process.env.HOME;
      const originalCwd = process.cwd();

      try {
        process.env.HOME = home;
        await fs.mkdir(home, { recursive: true });
        await fs.mkdir(repo, { recursive: true });
        process.chdir(repo);

        const globalPath = path.join(home, ".cass-memory", "playbook.yaml");
        const playbook = createEmptyPlaybook("test");
        // Different whitespace/case but same semantic content
        playbook.bullets = [
          createTestBullet({ id: "b-var", content: "  NEVER use   var  " }),
          createTestBullet({ id: "b-keep", content: "Use const or let" }),
        ];
        await writePlaybookFile(globalPath, playbook);

        const blockedPath = path.join(home, ".cass-memory", "blocked.log");
        await writeBlockedLog(blockedPath, [
          {
            id: "blocked-1",
            content: "never use var",
            reason: "Use const/let instead",
            forgottenAt: new Date().toISOString(),
          },
        ]);

        const config = createTestConfig({ playbookPath: globalPath });
        const merged = await loadMergedPlaybook(config);

        // Should be deprecated due to hash normalization
        const activeContents = getActiveBullets(merged).map((b) => b.content.toLowerCase().trim());
        expect(activeContents).not.toContain("never use var");

        const blockedBullet = merged.bullets.find((b) => b.id === "b-var");
        expect(blockedBullet?.deprecated).toBe(true);
        expect(blockedBullet?.deprecationReason).toBe("BLOCKED_CONTENT");
      } finally {
        process.env.HOME = originalHome;
        process.chdir(originalCwd);
      }
    });
  });

  describe("Semantic Similarity Blocking", () => {
    it("blocks bullets with high Jaccard similarity (>0.85)", async () => {
      const dir = await createTempDir();
      const home = path.join(dir, "home");
      const repo = path.join(dir, "repo");
      const originalHome = process.env.HOME;
      const originalCwd = process.cwd();

      try {
        process.env.HOME = home;
        await fs.mkdir(home, { recursive: true });
        await fs.mkdir(repo, { recursive: true });
        process.chdir(repo);

        // Test with content that has >0.85 Jaccard similarity
        const blockedContent = "Avoid using any type in TypeScript";
        const similarContent = "Avoid using any type in TypeScript code";

        // Verify similarity is above threshold
        const similarity = jaccardSimilarity(blockedContent, similarContent);
        expect(similarity).toBeGreaterThan(0.85);

        const globalPath = path.join(home, ".cass-memory", "playbook.yaml");
        const playbook = createEmptyPlaybook("test");
        playbook.bullets = [
          createTestBullet({ id: "b-similar", content: similarContent }),
          createTestBullet({ id: "b-different", content: "Use proper error handling" }),
        ];
        await writePlaybookFile(globalPath, playbook);

        const blockedPath = path.join(home, ".cass-memory", "blocked.log");
        await writeBlockedLog(blockedPath, [
          {
            id: "blocked-1",
            content: blockedContent,
            reason: "Overly restrictive rule",
            forgottenAt: new Date().toISOString(),
          },
        ]);

        const config = createTestConfig({ playbookPath: globalPath });
        const merged = await loadMergedPlaybook(config);

        // Similar content should be blocked (deprecated)
        const activeContents = getActiveBullets(merged).map((b) => b.content);
        expect(activeContents).not.toContain(similarContent);
        expect(activeContents).toContain("Use proper error handling");

        const blockedBullet = merged.bullets.find((b) => b.id === "b-similar");
        expect(blockedBullet?.deprecated).toBe(true);
        expect(blockedBullet?.deprecationReason).toBe("BLOCKED_CONTENT");
      } finally {
        process.env.HOME = originalHome;
        process.chdir(originalCwd);
      }
    });

    it("does NOT block bullets with low similarity (<0.85)", async () => {
      const dir = await createTempDir();
      const home = path.join(dir, "home");
      const repo = path.join(dir, "repo");
      const originalHome = process.env.HOME;
      const originalCwd = process.cwd();

      try {
        process.env.HOME = home;
        await fs.mkdir(home, { recursive: true });
        await fs.mkdir(repo, { recursive: true });
        process.chdir(repo);

        // Content with different intent despite some word overlap
        const blockedContent = "Never use var declarations";
        const differentIntent = "Use const/let instead of var for better scoping";

        // Verify similarity is below threshold
        const similarity = jaccardSimilarity(blockedContent, differentIntent);
        expect(similarity).toBeLessThan(0.85);

        const globalPath = path.join(home, ".cass-memory", "playbook.yaml");
        const playbook = createEmptyPlaybook("test");
        playbook.bullets = [createTestBullet({ id: "b-different", content: differentIntent })];
        await writePlaybookFile(globalPath, playbook);

        const blockedPath = path.join(home, ".cass-memory", "blocked.log");
        await writeBlockedLog(blockedPath, [
          {
            id: "blocked-1",
            content: blockedContent,
            reason: "Too prescriptive",
            forgottenAt: new Date().toISOString(),
          },
        ]);

        const config = createTestConfig({ playbookPath: globalPath });
        const merged = await loadMergedPlaybook(config);

        // Different intent should NOT be blocked
        const contents = merged.bullets.map((b) => b.content);
        expect(contents).toContain(differentIntent);
      } finally {
        process.env.HOME = originalHome;
        process.chdir(originalCwd);
      }
    });
  });

  describe("Multi-Source Blocked Logs", () => {
    it("filters from both global and repo blocked logs", async () => {
      const dir = await createTempDir();
      const home = path.join(dir, "home");
      const repo = path.join(dir, "repo");
      const originalHome = process.env.HOME;
      const originalCwd = process.cwd();

      try {
        process.env.HOME = home;
        await fs.mkdir(home, { recursive: true });
        await fs.mkdir(repo, { recursive: true });
        // Initialize git repo so resolveRepoDir() can find .cass directory
        execSync("git init", { cwd: repo, stdio: "pipe" });
        process.chdir(repo);

        const globalPath = path.join(home, ".cass-memory", "playbook.yaml");
        const repoPath = path.join(repo, ".cass", "playbook.yaml");

        // Bullets in both playbooks
        const globalPb = createEmptyPlaybook("global");
        globalPb.bullets = [
          createTestBullet({ id: "g-1", content: "Global rule blocked by global" }),
          createTestBullet({ id: "g-2", content: "Global rule blocked by repo" }),
          createTestBullet({ id: "g-3", content: "Global rule kept" }),
        ];

        const repoPb = createEmptyPlaybook("repo");
        repoPb.bullets = [createTestBullet({ id: "r-1", content: "Repo rule kept" })];

        await writePlaybookFile(globalPath, globalPb);
        await writePlaybookFile(repoPath, repoPb);

        // Global blocked log
        const globalBlockedPath = path.join(home, ".cass-memory", "blocked.log");
        await writeBlockedLog(globalBlockedPath, [
          {
            id: "blocked-g1",
            content: "Global rule blocked by global",
            reason: "Old rule",
            forgottenAt: new Date().toISOString(),
          },
        ]);

        // Repo blocked log
        const repoBlockedPath = path.join(repo, ".cass", "blocked.log");
        await writeBlockedLog(repoBlockedPath, [
          {
            id: "blocked-r1",
            content: "Global rule blocked by repo",
            reason: "Project-specific block",
            forgottenAt: new Date().toISOString(),
          },
        ]);

        const config = createTestConfig({ playbookPath: globalPath });
        const merged = await loadMergedPlaybook(config);

        const activeContents = getActiveBullets(merged).map((b) => b.content);
        expect(activeContents).not.toContain("Global rule blocked by global");
        expect(activeContents).not.toContain("Global rule blocked by repo");
        expect(activeContents).toContain("Global rule kept");
        expect(activeContents).toContain("Repo rule kept");

        const b1 = merged.bullets.find((b) => b.id === "g-1");
        expect(b1?.deprecated).toBe(true);
        expect(b1?.deprecationReason).toBe("BLOCKED_CONTENT");
      } finally {
        process.env.HOME = originalHome;
        process.chdir(originalCwd);
      }
    });
  });

  describe("BlockedLog CRUD Operations", () => {
    it("appendBlockedLog creates new file with entry", async () => {
      const dir = await createTempDir();
      const logPath = path.join(dir, "blocked.log");

      const entry: BlockedEntry = {
        id: "b-1",
        content: "Test blocked rule",
        reason: "Testing",
        forgottenAt: new Date().toISOString(),
      };

      await appendBlockedLog(entry, logPath);

      const entries = await loadBlockedLog(logPath);
      expect(entries.length).toBe(1);
      expect(entries[0].content).toBe("Test blocked rule");
    });

    it("appendBlockedLog appends to existing file", async () => {
      const dir = await createTempDir();
      const logPath = path.join(dir, "blocked.log");

      const entry1: BlockedEntry = {
        id: "b-1",
        content: "First rule",
        reason: "Reason 1",
        forgottenAt: new Date().toISOString(),
      };
      const entry2: BlockedEntry = {
        id: "b-2",
        content: "Second rule",
        reason: "Reason 2",
        forgottenAt: new Date().toISOString(),
      };

      await appendBlockedLog(entry1, logPath);
      await appendBlockedLog(entry2, logPath);

      const entries = await loadBlockedLog(logPath);
      expect(entries.length).toBe(2);
      expect(entries[0].content).toBe("First rule");
      expect(entries[1].content).toBe("Second rule");
    });

    it("loadBlockedLog returns empty array for non-existent file", async () => {
      const dir = await createTempDir();
      const logPath = path.join(dir, "nonexistent.log");

      const entries = await loadBlockedLog(logPath);
      expect(entries).toEqual([]);
    });

    it("loadBlockedLog skips malformed JSON lines", async () => {
      const dir = await createTempDir();
      const logPath = path.join(dir, "blocked.log");

      const content = [
        JSON.stringify({ id: "b-1", content: "Valid", reason: "r", forgottenAt: "2024-01-01" }),
        "not valid json",
        JSON.stringify({
          id: "b-2",
          content: "Also valid",
          reason: "r",
          forgottenAt: "2024-01-02",
        }),
      ].join("\n");
      await fs.writeFile(logPath, content);

      const entries = await loadBlockedLog(logPath);
      expect(entries.length).toBe(2);
      expect(entries[0].content).toBe("Valid");
      expect(entries[1].content).toBe("Also valid");
    });
  });

  describe("Jaccard Similarity Threshold Verification", () => {
    it("calculates Jaccard similarity correctly", () => {
      // Test exact match
      expect(jaccardSimilarity("hello world", "hello world")).toBe(1);

      // Test complete mismatch
      expect(jaccardSimilarity("abc", "xyz")).toBe(0);

      // Test partial overlap - "use const" vs "use let" share "use"
      const sim = jaccardSimilarity("use const", "use let");
      expect(sim).toBeGreaterThan(0);
      expect(sim).toBeLessThan(1);

      // Test high similarity should be > 0.85
      const highSim = jaccardSimilarity(
        "avoid using any type in code",
        "avoid using any type in code files",
      );
      expect(highSim).toBeGreaterThan(0.85);
    });
  });
});
