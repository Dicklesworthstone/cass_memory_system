import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import yaml from "yaml";
import { recordFeedback } from "../src/commands/mark.js";
import { playbookCommand } from "../src/commands/playbook.js";
import { assertInputLimits, InputLimitError, PLAYBOOK_INPUT_LIMITS } from "../src/input-limits.js";

import {
  addBullet,
  appendBlockedLog,
  type BlockedEntry,
  computeFullStats,
  createEmptyPlaybook,
  deprecateBullet,
  exportToMarkdown,
  findBullet,
  getActiveBullets,
  getBulletsByCategory,
  loadBlockedLog,
  loadMergedPlaybook,
  loadPlaybook,
  loadPlaybookWithRecovery,
  recordReflectionRun,
  repairPlaybookEmbeddings,
  savePlaybook,
  ToxicEntry,
} from "../src/playbook.js";
import {
  EMBEDDING_CACHE_VERSION,
  findSimilarBulletsSemantic,
  loadOrComputeEmbeddingsForBullets,
} from "../src/semantic.js";
import { type Playbook, PlaybookBullet, PlaybookSchema } from "../src/types.js";
import { extractBulletReasoning, hashContent } from "../src/utils.js";
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
// loadPlaybookWithRecovery
// =============================================================================
describe("untrusted playbook resource limits (#98)", () => {
  it("rejects oversized outer and nested arrays before validating their elements", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "playbook.yaml");
      const invalid = Array(PLAYBOOK_INPUT_LIMITS.maxArrayLength + 1).fill(null);
      for (const fields of [
        { bullets: invalid },
        { deprecatedPatterns: invalid },
        { bullets: [{ ...createTestBullet(), tags: invalid }] },
        { bullets: [{ ...createTestBullet(), feedbackEvents: invalid }] },
      ]) {
        // JSON is valid YAML and keeps these fixtures small and deterministic.
        const content = JSON.stringify({ ...createEmptyPlaybook(), ...fields });
        await fs.writeFile(file, content);
        await expect(loadPlaybook(file)).rejects.toBeInstanceOf(InputLimitError);
        expect(await fs.readFile(file, "utf8")).toBe(content);
      }
    });
  });

  it("rejects modest arrays of invalid bullets with bounded diagnostics", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "playbook.yaml");
      await fs.writeFile(file, JSON.stringify({ ...createEmptyPlaybook(), bullets: Array(128).fill(null) }));
      const messages: string[] = [];
      const original = console.error;
      console.error = (...args: unknown[]) => { messages.push(args.map(String).join(" ")); };
      try {
        await expect(loadPlaybook(file)).rejects.toThrow("is invalid");
      } finally {
        console.error = original;
      }
      expect(messages.join("\n").length).toBeLessThan(3000);
      expect(messages.join("\n")).toContain("validation");
    });
  });

  it("does not recover, back up, or replace files rejected by resource limits", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "playbook.yaml");
      // A sparse file exercises the byte limit without allocating its contents.
      const handle = await fs.open(file, "w");
      await handle.truncate(PLAYBOOK_INPUT_LIMITS.maxBytes + 1);
      await handle.close();
      await expect(loadPlaybookWithRecovery(file)).rejects.toBeInstanceOf(InputLimitError);
      expect((await fs.stat(file)).size).toBe(PLAYBOOK_INPUT_LIMITS.maxBytes + 1);
      expect(await fs.readdir(dir)).toEqual(["playbook.yaml"]);
    });
  });

  it("rejects cyclic YAML aliases and refuses oversized writes without losing saved rules", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "playbook.yaml");
      await fs.writeFile(file, "metadata: &meta { createdAt: now, recursive: *meta }\nbullets: []\n");
      await expect(loadPlaybookWithRecovery(file)).rejects.toBeInstanceOf(InputLimitError);
      const playbook = createEmptyPlaybook();
      playbook.bullets = [createTestBullet({ content: "Preserve ordinary playbooks" })];
      await savePlaybook(playbook, file);
      const original = await fs.readFile(file, "utf8");
      playbook.bullets[0].sourceSessions = Array(PLAYBOOK_INPUT_LIMITS.maxArrayLength + 1).fill("session");
      await expect(savePlaybook(playbook, file)).rejects.toBeInstanceOf(InputLimitError);
      expect(await fs.readFile(file, "utf8")).toBe(original);
      expect((await loadPlaybook(file)).bullets[0].content).toBe("Preserve ordinary playbooks");
    });
  });

  it("saves repeated object references without producing an unreadable alias-heavy file", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "playbook.yaml");
      const playbook = createEmptyPlaybook();
      const shared = createTestBullet({ content: "A normal bounded rule" });
      playbook.bullets = Array(128).fill(shared);
      await savePlaybook(playbook, file);
      expect((await loadPlaybook(file)).bullets).toHaveLength(128);
    });
  });
});

describe("loadPlaybookWithRecovery", () => {
  it("returns recovered=false for valid playbook roundtrip", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "playbook.yaml");
      const bullet = createTestBullet({
        content: "Keep tests fast",
        category: "testing",
        maturity: "established",
        helpfulCount: 3,
        tags: ["speed"],
      });

      const playbook = createEmptyPlaybook("roundtrip");
      playbook.bullets = [bullet];
      await savePlaybook(playbook, file);

      const { playbook: loaded, recovered } = await loadPlaybookWithRecovery(file);
      expect(recovered).toBe(false);
      expect(loaded.name).toBe("roundtrip");
      expect(loaded.bullets[0].content).toBe("Keep tests fast");
      expect(loaded.bullets[0].helpfulCount).toBe(3);
      expect(loaded.bullets[0].tags).toEqual(["speed"]);
    });
  });

  it("creates empty playbook when file is missing", async () => {
    await withTempDir(async (dir) => {
      const missing = path.join(dir, "does-not-exist.yaml");
      const { playbook, recovered } = await loadPlaybookWithRecovery(missing);
      expect(recovered).toBe(false);
      expect(playbook.bullets).toHaveLength(0);
      expect(playbook.metadata.createdAt).toBeTruthy();
    });
  });

  it("backs up corrupt YAML and returns fresh playbook", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "playbook.yaml");
      const corruptContent = "::: not valid yaml :::";
      await fs.writeFile(file, corruptContent, "utf-8");

      const { playbook, recovered, recovery } = await loadPlaybookWithRecovery(file);

      expect(recovered).toBe(true);
      expect(playbook.bullets).toHaveLength(0);
      expect(recovery?.backupPath).toBeTruthy();
      if (recovery?.backupPath) {
        const backupExists = await fs
          .stat(recovery.backupPath)
          .then(() => true)
          .catch(() => false);
        expect(backupExists).toBe(true);
        const backupContents = await fs.readFile(recovery.backupPath, "utf-8");
        expect(backupContents).toContain("not valid yaml");
      }
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
      // Initialize git repo so resolveRepoDir() can find .cass directory
      execSync("git init", { cwd: repo, stdio: "pipe" });
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
      // Initialize git repo so resolveRepoDir() can find .cass directory
      execSync("git init", { cwd: repo, stdio: "pipe" });
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
      repoPb.bullets = [createTestBullet({ id: "b-repo-keep", content: "repo keep" })];

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

      const activeContents = getActiveBullets(merged).map((b) => b.content);
      expect(activeContents).not.toContain(blockedContent);
      expect(activeContents).toContain("keep me");
      expect(activeContents).toContain("repo keep");

      const blockedBullet = merged.bullets.find((b) => b.content === blockedContent);
      expect(blockedBullet?.deprecated).toBe(true);
      expect(blockedBullet?.deprecationReason).toBe("BLOCKED_CONTENT");
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

      await savePlaybook(pb, file, { updateLastReflection: true });

      expect(pb.metadata.lastReflection).toBeTruthy();
      expect(pb.metadata.lastReflection).not.toBe(beforeSave);
    });
  });

  it("does not update lastReflection timestamp by default", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "playbook.yaml");
      const pb = createEmptyPlaybook("test");
      // Set an initial timestamp
      const initialTs = "2024-01-01T00:00:00.000Z";
      pb.metadata.lastReflection = initialTs;

      await savePlaybook(pb, file);

      const loaded = await loadPlaybook(file);
      expect(loaded.metadata.lastReflection).toBe(initialTs);
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

describe("persisted legacy evidence preservation (#99)", () => {
  it.serial("retains legacy evidence through repair, a real mark, and reflection metadata writes", async () => {
    await withTempDir(async dir => {
      const file = path.join(dir, "playbook.yaml");
      const createdAt = "2026-10-01T00:00:00.000Z";
      const legacy = {
        ...createEmptyPlaybook("legacy-evidence"),
        evidenceSources: { sessions: ["original-session"], embedding: { retain: "top-level evidence" } },
        metadata: {
          createdAt, totalReflections: 7, totalSessionsProcessed: 11,
          checkpoint: { source: "legacy-session-index", sequence: "9007199254740993" },
        },
        deprecatedPatterns: [{
          pattern: "Ignore failed writes", deprecatedAt: createdAt, reason: "Data preservation",
          evidence: { incident: "previous-write-failure" },
        }],
        bullets: [{
          ...createTestBullet({ id: "b-legacy-evidence", content: "Use atomic writes for learned state.", helpfulCount: 1 }),
          derivedFrom: {
            sessionPath: "/sessions/original.jsonl", extractedBy: "claude", timestamp: createdAt,
            keyEvidence: ["Missing transaction boundary caused partial writes."],
          },
          helpfulEvents: [{ timestamp: createdAt, context: "Original validation evidence" }],
          harmfulEvents: [{ timestamp: createdAt, reason: "wrong_context", context: "An earlier counterexample" }],
          verification: { type: "file_exists", pattern: "src/storage.ts", mode: "exists" },
          feedbackEvents: [{
            type: "helpful" as const, timestamp: createdAt, outcomeId: "original-outcome",
            evidence: { sessionHash: "original-session-hash", lines: [10, 11] },
          }],
          extension: { annotation: "Keep nested state", embedding: [4, 5] },
          embedding: [0.25, 0.5, 0.75],
        }],
      };
      const source = yaml.stringify(legacy, { aliasDuplicateObjects: false });
      await fs.writeFile(file, source);
      const repair = await repairPlaybookEmbeddings(file);
      expect(repair.embeddingsRemoved).toBe(1);
      expect(extractBulletReasoning((await loadPlaybook(file)).bullets[0]))
        .toBe(legacy.bullets[0].derivedFrom.keyEvidence[0]);

      const previousGlobalDir = process.env.CASS_MEMORY_HOME;
      process.env.CASS_MEMORY_HOME = dir;
      try {
        const feedback = await recordFeedback("b-legacy-evidence", {
          helpful: true, workspace: dir, session: "/sessions/after-repair.jsonl", reason: "A successful post-repair use",
        });
        expect(feedback.type).toBe("helpful");
      } finally {
        if (previousGlobalDir === undefined) delete process.env.CASS_MEMORY_HOME;
        else process.env.CASS_MEMORY_HOME = previousGlobalDir;
      }

      const loaded = await loadPlaybook(file);
      expect(loaded.bullets[0].feedbackEvents).toHaveLength(2);
      expect(loaded.bullets[0].helpfulCount).toBe(2);
      recordReflectionRun(loaded, 1);
      await savePlaybook(loaded, file, { updateLastReflection: true });

      const stored = yaml.parse(await fs.readFile(file, "utf8"));
      expect(stored.evidenceSources).toEqual(legacy.evidenceSources);
      expect(stored.metadata.checkpoint).toEqual(legacy.metadata.checkpoint);
      expect(stored.metadata.totalReflections).toBe(8);
      expect(stored.metadata.totalSessionsProcessed).toBe(12);
      expect(stored.deprecatedPatterns).toEqual(legacy.deprecatedPatterns);
      expect(stored.bullets[0].derivedFrom).toEqual(legacy.bullets[0].derivedFrom);
      expect(stored.bullets[0].helpfulEvents).toEqual(legacy.bullets[0].helpfulEvents);
      expect(stored.bullets[0].harmfulEvents).toEqual(legacy.bullets[0].harmfulEvents);
      expect(stored.bullets[0].verification).toEqual(legacy.bullets[0].verification);
      expect(stored.bullets[0].feedbackEvents[0]).toEqual(legacy.bullets[0].feedbackEvents[0]);
      expect(stored.bullets[0].feedbackEvents[1].context).toBe("A successful post-repair use");
      expect(stored.bullets[0].extension).toEqual(legacy.bullets[0].extension);
      expect(Object.hasOwn(stored.bullets[0], "embedding")).toBe(false);
      expect(extractBulletReasoning((await loadPlaybook(file)).bullets[0]))
        .toBe(legacy.bullets[0].derivedFrom.keyEvidence[0]);
      expect(await fs.readFile(repair.backupPath!, "utf8")).toBe(source);
    });
  });

  it("preserves ordinary playbook extensions while applying the existing defaults", async () => {
    await withTempDir(async dir => {
      const file = path.join(dir, "playbook.yaml");
      const createdAt = "2026-10-01T00:00:00.000Z";
      const raw = {
        metadata: { createdAt, evidenceIndex: { version: 3 } },
        bullets: [{
          id: "b-minimal", category: "testing", content: "Keep existing evidence.", createdAt, updatedAt: createdAt,
          derivedFrom: { keyEvidence: ["A useful earlier observation"] },
        }],
        extension: { producer: "other-cm-version" },
      };
      await fs.writeFile(file, JSON.stringify(raw));
      const loaded = await loadPlaybook(file);
      expect(loaded.name).toBe("playbook");
      expect(loaded.schema_version).toBe(2);
      expect(loaded.deprecatedPatterns).toEqual([]);
      expect(loaded.metadata.totalReflections).toBe(0);
      expect(loaded.metadata.totalSessionsProcessed).toBe(0);
      expect(loaded.bullets[0]).toMatchObject({ scope: "global", source: "learned", helpfulCount: 0, harmfulCount: 0 });
      expect(loaded.bullets[0].feedbackEvents).toEqual([]);
      await savePlaybook(loaded, file);
      const stored = yaml.parse(await fs.readFile(file, "utf8"));
      expect(stored.extension).toEqual(raw.extension);
      expect(stored.metadata.evidenceIndex).toEqual(raw.metadata.evidenceIndex);
      expect(stored.bullets[0].derivedFrom).toEqual(raw.bullets[0].derivedFrom);

      // Storage preservation must not broaden model/import schema contracts.
      const ordinarySchemaResult = PlaybookSchema.parse(raw);
      expect(Object.hasOwn(ordinarySchemaResult, "extension")).toBe(false);
      expect(Object.hasOwn(ordinarySchemaResult.metadata, "evidenceIndex")).toBe(false);
      expect(Object.hasOwn(ordinarySchemaResult.bullets[0], "derivedFrom")).toBe(false);
    });
  });

  const invalidKnownFields = [
    { name: "metadata counter", fields: { metadata: { createdAt: "now", totalReflections: "invalid" } } },
    { name: "bullet content", fields: { bullets: [{ ...createTestBullet(), content: { text: "invalid" } }] } },
    { name: "feedback type", fields: { bullets: [{ ...createTestBullet(), feedbackEvents: [{ type: "invalid", timestamp: "now" }] }] } },
    { name: "deprecated-pattern reason", fields: { deprecatedPatterns: [{ pattern: "old", deprecatedAt: "now", reason: 123 }] } },
  ];
  for (const invalid of invalidKnownFields) {
    it(`still rejects an invalid known ${invalid.name} without changing the file`, async () => {
      await withTempDir(async dir => {
        const file = path.join(dir, "playbook.yaml");
        const source = JSON.stringify({ ...createEmptyPlaybook(), ...invalid.fields, extension: { retain: true } });
        await fs.writeFile(file, source);
        await expect(loadPlaybook(file)).rejects.toThrow("is invalid");
        expect(await fs.readFile(file, "utf8")).toBe(source);
        expect(await fs.readdir(dir)).toEqual(["playbook.yaml"]);
      });
    });
  }

  it("bounds unknown extension data before storage validation and before writes", async () => {
    await withTempDir(async dir => {
      const file = path.join(dir, "playbook.yaml");
      const oversized = Array(PLAYBOOK_INPUT_LIMITS.maxArrayLength + 1).fill("evidence");
      const unknownFields = [
        { extension: oversized },
        { metadata: { createdAt: "now", evidence: oversized } },
        { bullets: [{ ...createTestBullet(), derivedFrom: { keyEvidence: oversized } }] },
        { bullets: [{ ...createTestBullet(), feedbackEvents: [{ type: "helpful", timestamp: "now", evidence: oversized }] }] },
        { deprecatedPatterns: [{ pattern: "old", deprecatedAt: "now", reason: "legacy", evidence: oversized }] },
      ];
      for (const fields of unknownFields) {
        const source = JSON.stringify({ ...createEmptyPlaybook(), ...fields });
        await fs.writeFile(file, source);
        await expect(loadPlaybook(file)).rejects.toBeInstanceOf(InputLimitError);
        expect(await fs.readFile(file, "utf8")).toBe(source);
      }

      const ordinary = { ...createEmptyPlaybook(), extension: { notes: ["Keep this evidence"] } };
      await fs.writeFile(file, JSON.stringify(ordinary));
      const loaded = await loadPlaybook(file);
      const baseline = await fs.readFile(file, "utf8");
      (loaded as Playbook & { extension: unknown }).extension = oversized;
      await expect(savePlaybook(loaded, file)).rejects.toBeInstanceOf(InputLimitError);
      expect(await fs.readFile(file, "utf8")).toBe(baseline);
    });
  });
});

describe("embedding-free playbook persistence (#99)", () => {
  it("retains learned state through repair, feedback, reflection counters, and subsequent writes", async () => {
    await withTempDir(async dir => {
      const file = path.join(dir, "playbook.yaml");
      const retained = createEmptyPlaybook("legacy-learning");
      retained.metadata = {
        createdAt: "2025-03-01T00:00:00.000Z",
        lastReflection: "2026-10-01T00:00:00.000Z",
        totalReflections: 17,
        totalSessionsProcessed: 41,
      };
      retained.deprecatedPatterns = [{
        pattern: "Ignore failed reflection jobs",
        deprecatedAt: "2026-10-01T00:00:00.000Z",
        reason: "Failures need investigation",
        replacement: "Check the process exit status",
      }];
      retained.bullets = [
        createTestBullet({
          id: "b-preserve-feedback",
          content: "Check the reflection exit status before counting a session as learned.",
          helpfulCount: 1,
          feedbackEvents: [{
            type: "helpful", timestamp: "2026-10-01T00:00:00.000Z",
            sessionPath: "/sessions/original.jsonl", context: "Caught a failed job",
          }],
          sourceSessions: ["/sessions/original.jsonl"],
          sourceAgents: ["claude"],
          tags: ["reliability", "cron"],
          pinned: true,
          pinnedReason: "Keep automated learning observable",
        }),
        createTestBullet({
          id: "b-preserve-scope",
          content: "Type-check TypeScript before publishing a package.",
          scope: "language", scopeKey: "typescript", maturity: "proven",
          sourceSessions: ["/sessions/build.jsonl"], sourceAgents: ["codex"],
        }),
      ];
      const legacy = structuredClone(retained);
      legacy.bullets[0].embedding = [0.25, 0.5, 0.75];
      legacy.bullets[1].embedding = [-0.25, 0.75, 0.5];
      const original = yaml.stringify(legacy);
      await fs.writeFile(file, original);

      const repair = await repairPlaybookEmbeddings(file);
      expect(repair.changed).toBe(true);
      expect(repair.embeddingsRemoved).toBe(2);
      expect(await fs.readFile(repair.backupPath!, "utf8")).toBe(original);
      const loaded = await loadPlaybook(file);
      expect(loaded).toEqual(retained);

      const feedback = {
        type: "helpful" as const, timestamp: "2026-10-28T12:00:00.000Z",
        sessionPath: "/sessions/after-repair.jsonl", context: "The recovered rule remains useful",
      };
      loaded.bullets[0].feedbackEvents.push(feedback);
      loaded.bullets[0].helpfulCount++;
      loaded.bullets[0].updatedAt = feedback.timestamp;
      recordReflectionRun(loaded, 2);
      await savePlaybook(loaded, file, { updateLastReflection: true });

      const reloaded = await loadPlaybook(file);
      const expected = structuredClone(retained);
      expected.bullets[0].feedbackEvents.push(feedback);
      expected.bullets[0].helpfulCount = 2;
      expected.bullets[0].updatedAt = feedback.timestamp;
      expected.metadata.totalReflections = 18;
      expected.metadata.totalSessionsProcessed = 43;
      expected.metadata.lastReflection = loaded.metadata.lastReflection;
      expect(reloaded).toEqual(expected);
      expect(reloaded.metadata.lastReflection).not.toBe(retained.metadata.lastReflection);
      expect(reloaded.bullets.map(bullet => bullet.id)).toEqual(retained.bullets.map(bullet => bullet.id));
      expect(reloaded.bullets.every(bullet => !Object.hasOwn(bullet, "embedding"))).toBe(true);
      expect(await fs.readFile(repair.backupPath!, "utf8")).toBe(original);
    });
  });

  it("reuses the untouched external cache after repair and never persists hydrated vectors", async () => {
    await withTempDir(async dir => {
      const file = path.join(dir, "playbook.yaml");
      const cachePath = path.join(dir, "embeddings", "bullets.json");
      const retained = createEmptyPlaybook("cached-rules");
      retained.bullets = [
        createTestBullet({ id: "b-cache-first", content: "Inspect errors from the reflection job." }),
        createTestBullet({ id: "b-cache-second", content: "Keep backups before migrating learned rules." }),
      ];
      const cache = {
        version: EMBEDDING_CACHE_VERSION,
        model: "none",
        bullets: {
          "b-cache-first": {
            contentHash: hashContent(retained.bullets[0].content),
            embedding: [1, 0, 0], computedAt: "2026-10-01T00:00:00.000Z",
          },
          "b-cache-second": {
            contentHash: hashContent(retained.bullets[1].content),
            embedding: [0, 1, 0], computedAt: "2026-10-02T00:00:00.000Z",
          },
          "b-other-playbook": {
            contentHash: hashContent("A rule owned by another playbook"),
            embedding: [0, 0, 1], computedAt: "2026-10-03T00:00:00.000Z",
          },
        },
      };
      // Deliberate non-default formatting detects even a needless cache rewrite.
      const cacheBytes = JSON.stringify(cache, null, 4) + "\n";
      await fs.mkdir(path.dirname(cachePath), { recursive: true });
      await fs.writeFile(cachePath, cacheBytes);
      const legacy = structuredClone(retained);
      // Unproven inline vectors must not overwrite the model-labelled cache.
      legacy.bullets[0].embedding = [-1, 0, 0];
      legacy.bullets[1].embedding = [0, -1, 0];
      await writePlaybookFile(file, legacy);

      await repairPlaybookEmbeddings(file);
      expect(await fs.readFile(cachePath, "utf8")).toBe(cacheBytes);
      const loaded = await loadPlaybook(file);
      expect(loaded).toEqual(retained);
      const hydrated = await loadOrComputeEmbeddingsForBullets(loaded.bullets, { cachePath, model: "none" });
      expect(hydrated.stats).toEqual({ reused: 2, computed: 0, skipped: 0 });
      expect(loaded.bullets[0].embedding).toEqual([1, 0, 0]);
      expect(loaded.bullets[1].embedding).toEqual([0, 1, 0]);
      const matches = await findSimilarBulletsSemantic("reflection errors", loaded.bullets, 2, {
        cachePath, model: "none", queryEmbedding: [1, 0, 0], threshold: 0.9,
      });
      expect(matches.map(match => match.bullet.id)).toEqual(["b-cache-first"]);

      const snapshot = structuredClone(loaded);
      const vector = loaded.bullets[0].embedding;
      await savePlaybook(loaded, file);
      expect(loaded).toEqual(snapshot);
      expect(loaded.bullets[0].embedding).toBe(vector);
      expect(yaml.parse(await fs.readFile(file, "utf8"))).toEqual(retained);
      expect(await loadPlaybook(file)).toEqual(retained);
      expect(await fs.readFile(cachePath, "utf8")).toBe(cacheBytes);
    });
  });

  it("omits more than 200,000 in-memory embedding values before applying ordinary write limits", async () => {
    await withTempDir(async dir => {
      const file = path.join(dir, "playbook.yaml");
      const playbook = createEmptyPlaybook("hydrated-large-playbook");
      playbook.bullets = Array.from({ length: 600 }, (_, index) => createTestBullet({
        id: `b-hydrated-${index}`,
        content: `Preserve learned rule ${index} when saving cached embeddings.`,
        embedding: Array.from({ length: 384 }, (_, component) => (component - 192) / 384),
      }));
      expect(600 * 384).toBeGreaterThan(PLAYBOOK_INPUT_LIMITS.maxNodes);
      expect(() => assertInputLimits(playbook, PLAYBOOK_INPUT_LIMITS, file)).toThrow(InputLimitError);
      const vectors = playbook.bullets.map(bullet => bullet.embedding);

      await savePlaybook(playbook, file);
      const loaded = await loadPlaybook(file);
      expect(loaded.bullets).toHaveLength(600);
      expect(loaded.bullets.map(bullet => [bullet.id, bullet.content]))
        .toEqual(playbook.bullets.map(bullet => [bullet.id, bullet.content]));
      expect(loaded.bullets.every(bullet => !Object.hasOwn(bullet, "embedding"))).toBe(true);
      expect(playbook.bullets.every((bullet, index) => bullet.embedding === vectors[index])).toBe(true);
      expect((await fs.stat(file)).size).toBeLessThan(PLAYBOOK_INPUT_LIMITS.maxBytes);
    });
  });

  const invalidRetainedState: Array<{
    name: string;
    message: string;
    mutate: (playbook: Playbook) => void;
  }> = [
    {
      name: "bullet count", message: "maximum array length",
      mutate: playbook => { playbook.bullets = Array(PLAYBOOK_INPUT_LIMITS.maxArrayLength + 1).fill(playbook.bullets[0]); },
    },
    {
      name: "feedback count", message: "maximum array length",
      mutate: playbook => {
        playbook.bullets[0].feedbackEvents = Array(PLAYBOOK_INPUT_LIMITS.maxArrayLength + 1)
          .fill({ type: "helpful", timestamp: "2026-10-01T00:00:00.000Z" });
      },
    },
    {
      name: "expanded text bytes", message: "maximum expanded text size",
      mutate: playbook => { playbook.description = "é".repeat(PLAYBOOK_INPUT_LIMITS.maxBytes / 2 + 1); },
    },
    {
      name: "object keys", message: "maximum object key count",
      mutate: playbook => {
        Object.assign(playbook, { extension: Object.fromEntries(
          Array.from({ length: PLAYBOOK_INPUT_LIMITS.maxObjectKeys + 1 }, (_, index) => [`field-${index}`, true]),
        ) });
      },
    },
    {
      name: "nesting depth", message: "maximum nesting depth",
      mutate: playbook => {
        let extension: Record<string, unknown> = {};
        for (let depth = 0; depth <= PLAYBOOK_INPUT_LIMITS.maxDepth; depth++) extension = { child: extension };
        Object.assign(playbook, { extension });
      },
    },
    {
      name: "expanded nodes", message: "maximum expanded value count",
      mutate: playbook => {
        Object.assign(playbook, { extension: Array.from({ length: 21 }, () => Array(10_000).fill(0)) });
      },
    },
  ];

  for (const invalid of invalidRetainedState) {
    it(`still rejects excessive non-embedding ${invalid.name} without replacing the saved playbook`, async () => {
      await withTempDir(async dir => {
        const file = path.join(dir, "playbook.yaml");
        const playbook = createEmptyPlaybook("protected-state");
        playbook.bullets = [createTestBullet({
          id: "b-retained", content: "Keep the last valid playbook on write failure.", embedding: [1, 0, 0],
        })];
        await savePlaybook(playbook, file);
        const original = await fs.readFile(file, "utf8");
        invalid.mutate(playbook);

        await expect(savePlaybook(playbook, file)).rejects.toThrow(invalid.message);
        expect(await fs.readFile(file, "utf8")).toBe(original);
        expect((await loadPlaybook(file)).bullets.map(bullet => bullet.id)).toEqual(["b-retained"]);
        expect(await fs.readdir(dir)).toEqual(["playbook.yaml"]);
      });
    });
  }

  it("still enforces the serialized byte limit after omitting vectors", async () => {
    await withTempDir(async dir => {
      const file = path.join(dir, "playbook.yaml");
      const playbook = createEmptyPlaybook("serialized-limit");
      playbook.bullets = [createTestBullet({ content: "Preserve the prior saved rule.", embedding: [1, 0, 0] })];
      await savePlaybook(playbook, file);
      const original = await fs.readFile(file, "utf8");
      // YAML escapes each control character as four bytes, so raw text is
      // comfortably bounded while its serialized representation is too large.
      playbook.description = "\u0001".repeat(PLAYBOOK_INPUT_LIMITS.maxBytes / 4);
      expect(() => assertInputLimits(playbook, PLAYBOOK_INPUT_LIMITS, file)).not.toThrow();

      await expect(savePlaybook(playbook, file)).rejects.toThrow("maximum file size");
      expect(await fs.readFile(file, "utf8")).toBe(original);
      expect(await fs.readdir(dir)).toEqual(["playbook.yaml"]);
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
        "~/.cursor/sessions/abc.jsonl",
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
      "/path/session.jsonl",
    );

    expect(bullet.id).toMatch(/^b-/);
    expect(pb.bullets.length).toBe(1);
  });

  it("respects provided id when unique", () => {
    const pb = createEmptyPlaybook();
    const bullet = addBullet(
      pb,
      { id: "b-custom-1", content: "New rule", category: "testing" },
      "/path/session.jsonl",
    );

    expect(bullet.id).toBe("b-custom-1");
    expect(pb.bullets.length).toBe(1);
  });

  it("throws when provided id already exists", () => {
    const pb = createEmptyPlaybook();
    addBullet(
      pb,
      { id: "b-collision", content: "Rule 1", category: "testing" },
      "/path/session.jsonl",
    );

    expect(() => {
      addBullet(
        pb,
        { id: "b-collision", content: "Rule 2", category: "testing" },
        "/path/session.jsonl",
      );
    }).toThrow();
  });

  it("sets content and category from data", () => {
    const pb = createEmptyPlaybook();
    const bullet = addBullet(
      pb,
      { content: "Rule content", category: "style" },
      "/path/session.jsonl",
    );

    expect(bullet.content).toBe("Rule content");
    expect(bullet.category).toBe("style");
  });

  it("sets default values for optional fields", () => {
    const pb = createEmptyPlaybook();
    const bullet = addBullet(pb, { content: "Rule", category: "test" }, "/path/session.jsonl");

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
      "~/.claude-code/sessions/abc.jsonl",
    );

    expect(bullet.sourceAgents).toContain("claude");
    expect(bullet.sourceSessions).toContain("~/.claude-code/sessions/abc.jsonl");
  });

  it("accepts custom kind", () => {
    const pb = createEmptyPlaybook();
    const bullet = addBullet(
      pb,
      { content: "Rule", category: "test", kind: "project_convention" },
      "/path/session.jsonl",
    );

    expect(bullet.kind).toBe("project_convention");
  });

  it("accepts custom scope", () => {
    const pb = createEmptyPlaybook();
    const bullet = addBullet(
      pb,
      { content: "Rule", category: "test", scope: "workspace" },
      "/path/session.jsonl",
    );

    expect(bullet.scope).toBe("workspace");
  });

  it("accepts tags", () => {
    const pb = createEmptyPlaybook();
    const bullet = addBullet(
      pb,
      { content: "Rule", category: "test", tags: ["tag1", "tag2"] },
      "/path/session.jsonl",
    );

    expect(bullet.tags).toContain("tag1");
    expect(bullet.tags).toContain("tag2");
  });

  it("sets timestamps", () => {
    const pb = createEmptyPlaybook();
    const bullet = addBullet(pb, { content: "Rule", category: "test" }, "/path/session.jsonl");

    expect(bullet.createdAt).toBeTruthy();
    expect(bullet.updatedAt).toBeTruthy();
  });

  it("uses custom decay half-life", () => {
    const pb = createEmptyPlaybook();
    const bullet = addBullet(pb, { content: "Rule", category: "test" }, "/path/session.jsonl", 60);

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
      "~/.cursor/sessions/abc.jsonl",
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
// loadBlockedLog
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
        JSON.stringify({
          id: "t-1",
          content: "Blocked 1",
          reason: "r1",
          forgottenAt: "2024-01-01",
        }),
        JSON.stringify({
          id: "t-2",
          content: "Blocked 2",
          reason: "r2",
          forgottenAt: "2024-01-02",
        }),
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
        JSON.stringify({
          id: "t-2",
          content: "Also valid",
          reason: "r",
          forgottenAt: "2024-01-02",
        }),
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
        JSON.stringify({
          id: "t-2",
          content: "Also valid",
          reason: "r",
          forgottenAt: "2024-01-02",
        }),
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
// appendBlockedLog
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
      const entry1: BlockedEntry = {
        id: "t-1",
        content: "First",
        reason: "r",
        forgottenAt: "2024-01-01",
      };
      const entry2: BlockedEntry = {
        id: "t-2",
        content: "Second",
        reason: "r",
        forgottenAt: "2024-01-02",
      };

      await appendBlockedLog(entry1, logPath);
      await appendBlockedLog(entry2, logPath);

      const entries = await loadBlockedLog(logPath);
      expect(entries.length).toBe(2);
    });
  });

  it("creates parent directories", async () => {
    await withTempDir(async (dir) => {
      const logPath = path.join(dir, "nested/deep/blocked.log");
      const entry: BlockedEntry = {
        id: "t-1",
        content: "Test",
        reason: "r",
        forgottenAt: "2024-01-01",
      };

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
      createTestBullet({ helpfulCount: 3, harmfulCount: 0 }), // good
      createTestBullet({ helpfulCount: 0, harmfulCount: 0 }), // neutral
    ];

    const stats = computeFullStats(pb, config);
    // Score distribution depends on scoring.ts getEffectiveScore
    expect(
      stats.scoreDistribution.excellent +
        stats.scoreDistribution.good +
        stats.scoreDistribution.neutral +
        stats.scoreDistribution.atRisk,
    ).toBe(3);
  });
});

describe("recordReflectionRun (#72)", () => {
  it("increments totalReflections once per run and totalSessionsProcessed by the committed count", () => {
    const pb = createEmptyPlaybook();
    recordReflectionRun(pb, 3);
    expect(pb.metadata.totalReflections).toBe(1);
    expect(pb.metadata.totalSessionsProcessed).toBe(3);

    recordReflectionRun(pb, 1);
    expect(pb.metadata.totalReflections).toBe(2);
    expect(pb.metadata.totalSessionsProcessed).toBe(4);
  });

  it("ignores runs that committed no sessions", () => {
    const pb = createEmptyPlaybook();
    recordReflectionRun(pb, 0);
    recordReflectionRun(pb, -2);
    recordReflectionRun(pb, Number.NaN);
    expect(pb.metadata.totalReflections).toBe(0);
    expect(pb.metadata.totalSessionsProcessed).toBe(0);
  });

  it("tolerates legacy playbooks whose counters are missing", () => {
    const pb = createEmptyPlaybook();
    delete (pb.metadata as any).totalReflections;
    delete (pb.metadata as any).totalSessionsProcessed;
    recordReflectionRun(pb, 2);
    expect(pb.metadata.totalReflections).toBe(1);
    expect(pb.metadata.totalSessionsProcessed).toBe(2);
  });
});

describe("playbook storage failures are not absence", () => {
  interface OwnedPlaybooks {
    directory: string;
    workspace: string;
    globalPath: string;
    repoPath: string;
    globalBytes: Buffer<ArrayBuffer>;
    repoBytes: Buffer<ArrayBuffer>;
  }

  async function withOwnedPlaybooks(check: (fixture: OwnedPlaybooks) => Promise<void>): Promise<void> {
    await withTempDir(async directory => {
      const globalDirectory = path.join(directory, "memory");
      const workspace = path.join(directory, "repo");
      const globalPath = path.join(globalDirectory, "playbook.yaml");
      const repoPath = path.join(workspace, ".cass", "playbook.yaml");
      await fs.mkdir(workspace, { recursive: true });
      execFileSync("git", ["init", "-q", "--initial-branch=main", workspace]);
      const previousHome = process.env.CASS_MEMORY_HOME;
      const previousCwd = process.cwd();
      process.env.CASS_MEMORY_HOME = globalDirectory;
      process.chdir(workspace);
      try {
        const global = createEmptyPlaybook("global-learned-state");
        global.bullets = [createTestBullet({
          id: "b-storage-owned", content: "Preserve learned feedback when storage is temporarily unavailable.",
          sourceSessions: ["global-source-session"],
        })];
        const repo = createEmptyPlaybook("repository-learned-state");
        repo.bullets = [createTestBullet({
          id: "b-storage-owned", content: "Run repository-specific database checks before applying migrations.",
          scope: "workspace", sourceSessions: ["repo-source-session"],
        })];
        await savePlaybook(global, globalPath);
        await savePlaybook(repo, repoPath);
        await fs.writeFile(path.join(globalDirectory, "config.json"), JSON.stringify({
          playbookPath: globalPath, embeddingModel: "none", semanticSearchEnabled: false,
        }));
        await check({
          directory, workspace, globalPath, repoPath,
          globalBytes: await fs.readFile(globalPath), repoBytes: await fs.readFile(repoPath),
        });
      } finally {
        process.chdir(previousCwd);
        if (previousHome === undefined) delete process.env.CASS_MEMORY_HOME;
        else process.env.CASS_MEMORY_HOME = previousHome;
      }
    });
  }

  it.serial("a failed existence probe cannot make the actual add command replace existing learned state", async () => {
    await withOwnedPlaybooks(async ({ globalPath, repoPath, repoBytes }) => {
      const failure = Object.assign(new Error("injected EIO existence probe"), { code: "EIO" });
      const realAccess = fs.access.bind(fs);
      const accessSpy = spyOn(fs, "access").mockImplementation(async (...args: Parameters<typeof fs.access>) => {
        if (String(args[0]) === globalPath) throw failure;
        return realAccess(...args);
      });
      const output: string[] = [];
      const logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => { output.push(args.join(" ")); });
      try {
        await playbookCommand("add", ["Record deployment package checksums before publishing artifacts."], { json: true });
      } finally {
        logSpy.mockRestore();
        accessSpy.mockRestore();
      }
      expect(JSON.parse(output.find(line => line.startsWith("{"))!).success).toBe(true);
      const stored = await loadPlaybook(globalPath);
      expect(stored.bullets).toHaveLength(2);
      expect(stored.bullets.find(bullet => bullet.id === "b-storage-owned")?.sourceSessions).toEqual(["global-source-session"]);
      expect(stored.bullets.some(bullet => bullet.content === "Record deployment package checksums before publishing artifacts.")).toBe(true);
      expect(await fs.readFile(repoPath)).toEqual(repoBytes);
    });
  });

  for (const code of ["EIO", "EACCES"]) {
    it.serial(`propagates ${code} from real reads and prevents recovery or add from overwriting the playbook`, async () => {
      await withOwnedPlaybooks(async ({ globalPath, globalBytes, repoPath, repoBytes }) => {
        const directory = path.dirname(globalPath);
        const beforeFiles = (await fs.readdir(directory)).sort();
        const failure = Object.assign(new Error(`injected ${code} playbook read`), { code });
        const realOpen = fs.open.bind(fs);
        const openSpy = spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
          if (String(args[0]) === globalPath) throw failure;
          return realOpen(...args);
        });
        try {
          await expect(loadPlaybook(globalPath)).rejects.toBe(failure);
          await expect(loadPlaybookWithRecovery(globalPath)).rejects.toBe(failure);
          await expect(playbookCommand("add", ["Keep this failed addition from replacing learned state."], { json: true })).rejects.toBe(failure);
        } finally {
          openSpy.mockRestore();
        }
        expect(await fs.readFile(globalPath)).toEqual(globalBytes);
        expect(await fs.readFile(repoPath)).toEqual(repoBytes);
        expect((await fs.readdir(directory)).sort()).toEqual(beforeFiles);
      });
    });

    it.serial(`propagates ${code} from repository ownership checks instead of marking the global duplicate`, async () => {
      await withOwnedPlaybooks(async ({ workspace, globalPath, globalBytes, repoPath, repoBytes }) => {
        const failure = Object.assign(new Error(`injected ${code} repository probe`), { code });
        const realAccess = fs.access.bind(fs);
        const accessSpy = spyOn(fs, "access").mockImplementation(async (...args: Parameters<typeof fs.access>) => {
          if (String(args[0]) === repoPath) throw failure;
          return realAccess(...args);
        });
        try {
          await expect(recordFeedback("b-storage-owned", { helpful: true, workspace })).rejects.toBe(failure);
          await expect(loadMergedPlaybook(createTestConfig({ playbookPath: globalPath }), { cwd: workspace })).rejects.toBe(failure);
        } finally {
          accessSpy.mockRestore();
        }
        expect(await fs.readFile(globalPath)).toEqual(globalBytes);
        expect(await fs.readFile(repoPath)).toEqual(repoBytes);
        await recordFeedback("b-storage-owned", { helpful: true, workspace });
        expect((await loadPlaybook(repoPath)).bullets[0]?.helpfulCount).toBe(1);
        expect(await fs.readFile(globalPath)).toEqual(globalBytes);
      });
    });
  }

  it.serial("still marks the global owner when the repository playbook is genuinely missing", async () => {
    await withOwnedPlaybooks(async ({ workspace, globalPath, repoPath, repoBytes }) => {
      const preserved = `${repoPath}.preserved`;
      await fs.rename(repoPath, preserved);
      await recordFeedback("b-storage-owned", { helpful: true, workspace });
      expect((await loadPlaybook(globalPath)).bullets[0]?.helpfulCount).toBe(1);
      expect(await fs.readFile(preserved)).toEqual(repoBytes);
      await expect(fs.lstat(repoPath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("rejects directories without creating recovery artifacts", async () => {
    await withTempDir(async directory => {
      const file = path.join(directory, "playbook.yaml");
      await fs.mkdir(file);
      await expect(loadPlaybook(file)).rejects.toBeInstanceOf(InputLimitError);
      await expect(loadPlaybookWithRecovery(file)).rejects.toBeInstanceOf(InputLimitError);
      expect(await fs.readdir(directory)).toEqual(["playbook.yaml"]);
      expect((await fs.lstat(file)).isDirectory()).toBe(true);
    });
  });

  it.skipIf(process.platform === "win32")("rejects FIFOs without blocking or creating recovery artifacts", async () => {
    await withTempDir(async directory => {
      const file = path.join(directory, "playbook.yaml");
      execFileSync("mkfifo", [file]);
      await expect(loadPlaybook(file)).rejects.toBeInstanceOf(InputLimitError);
      await expect(loadPlaybookWithRecovery(file)).rejects.toBeInstanceOf(InputLimitError);
      expect(await fs.readdir(directory)).toEqual(["playbook.yaml"]);
      expect((await fs.lstat(file)).isFIFO()).toBe(true);
    });
  });

  it.skipIf(process.platform === "win32")("a dangling repository symlink cannot become empty state or redirect feedback globally", async () => {
    await withOwnedPlaybooks(async ({ workspace, globalPath, globalBytes, repoPath, repoBytes }) => {
      const preserved = `${repoPath}.preserved`;
      await fs.rename(repoPath, preserved);
      await fs.symlink(path.join(path.dirname(repoPath), "missing-playbook.yaml"), repoPath);
      await expect(loadPlaybook(repoPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(loadPlaybookWithRecovery(repoPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(recordFeedback("b-storage-owned", { helpful: true, workspace })).rejects.toMatchObject({ code: "ENOENT" });
      expect((await fs.lstat(repoPath)).isSymbolicLink()).toBe(true);
      expect(await fs.readFile(globalPath)).toEqual(globalBytes);
      expect(await fs.readFile(preserved)).toEqual(repoBytes);
    });
  });
});
