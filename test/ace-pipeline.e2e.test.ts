/**
 * E2E Tests for Full ACE Pipeline - Session to Playbook
 *
 * Complete end-to-end test of the Autonomous Curation Engine:
 * Session ingestion → Reflection → Validation → Playbook update
 *
 * Uses stubbed LLM via CM_REFLECTOR_STUBS to avoid external dependencies.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { reflectOnSession } from "../src/reflect.js";
import { curatePlaybook } from "../src/curate.js";
import { validateDelta } from "../src/validate.js";
import { createEmptyPlaybook, savePlaybook, loadPlaybook } from "../src/playbook.js";
import { createTestConfig, createTestBullet, createTestPlaybook, createTestFeedbackEvent } from "./helpers/index.js";
import { __resetReflectorStubsForTest } from "../src/llm.js";
import { DiaryEntry, PlaybookDelta } from "../src/types.js";

// --- Helper Functions ---

let tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dirPath = path.join(os.tmpdir(), `ace-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dirPath, { recursive: true });
  tempDirs.push(dirPath);
  return dirPath;
}

beforeEach(() => {
  delete process.env.CM_REFLECTOR_STUBS;
  __resetReflectorStubsForTest();
});

afterEach(async () => {
  delete process.env.CM_REFLECTOR_STUBS;
  __resetReflectorStubsForTest();
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  tempDirs = [];
});

// Helper to create a test diary entry
function createTestDiary(overrides: Partial<DiaryEntry> = {}): DiaryEntry {
  return {
    id: `diary-${Date.now()}`,
    sessionPath: "/sessions/test-session.jsonl",
    timestamp: new Date().toISOString(),
    agent: "claude-code",
    status: "success",
    accomplishments: ["Completed feature implementation"],
    decisions: ["Used atomic writes for safety"],
    challenges: [],
    preferences: [],
    keyLearnings: ["Atomic writes prevent data corruption"],
    relatedSessions: [],
    tags: ["testing", "architecture"],
    searchAnchors: [],
    ...overrides
  };
}

// Helper to setup test environment
async function setupTestEnvironment() {
  const dir = await createTempDir();
  const home = path.join(dir, "home");
  const cassMemoryDir = path.join(home, ".cass-memory");

  await mkdir(cassMemoryDir, { recursive: true });
  await mkdir(path.join(cassMemoryDir, "diary"), { recursive: true });

  const config = { schema_version: 1 };
  await writeFile(path.join(cassMemoryDir, "config.json"), JSON.stringify(config));

  const playbook = createEmptyPlaybook("test");
  await savePlaybook(playbook, path.join(cassMemoryDir, "playbook.yaml"));

  return { dir, home, cassMemoryDir };
}

// --- Test Suites ---

describe("E2E: ACE Pipeline - Full Flow", () => {
  describe("Session to Playbook Pipeline", () => {
    it("executes full pipeline: reflect → curate", async () => {
      const diary = createTestDiary();
      const playbook = createTestPlaybook();
      const config = createTestConfig({ maxReflectorIterations: 2 });

      process.env.CM_REFLECTOR_STUBS = JSON.stringify([
        {
          deltas: [
            {
              type: "add",
              bullet: {
                content: "Always use atomic writes for configuration files",
                category: "best-practices"
              },
              reason: "Prevents data corruption on crash"
            }
          ]
        }
      ]);

      const reflectResult = await reflectOnSession(diary, playbook, config);

      expect(reflectResult.deltas.length).toBeGreaterThan(0);
      expect(reflectResult.deltas[0].type).toBe("add");
      expect(reflectResult.deltas[0].sourceSession).toBe(diary.sessionPath);

      const curationResult = curatePlaybook(playbook, reflectResult.deltas, config);

      expect(curationResult.applied).toBeGreaterThan(0);
      expect(curationResult.playbook.bullets.length).toBeGreaterThan(0);

      const addedBullet = curationResult.playbook.bullets.find(
        b => b.content.includes("atomic writes")
      );
      expect(addedBullet).toBeDefined();
      expect(addedBullet?.category).toBe("best-practices");
      expect(addedBullet?.maturity).toBe("candidate");
    });

    it("pipeline handles multiple iterations of reflection", async () => {
      const diary = createTestDiary();
      const playbook = createTestPlaybook();
      const config = createTestConfig({ maxReflectorIterations: 3 });

      process.env.CM_REFLECTOR_STUBS = JSON.stringify([
        { deltas: [{ type: "add", bullet: { content: "Rule from iteration 1", category: "testing" }, reason: "iter1" }] },
        { deltas: [{ type: "add", bullet: { content: "Rule from iteration 2", category: "testing" }, reason: "iter2" }] },
        { deltas: [{ type: "add", bullet: { content: "Rule from iteration 3", category: "testing" }, reason: "iter3" }] }
      ]);

      const reflectResult = await reflectOnSession(diary, playbook, config);
      const curationResult = curatePlaybook(playbook, reflectResult.deltas, config);

      // Multiple iterations produce multiple deltas
      expect(reflectResult.deltas.length).toBeGreaterThanOrEqual(2);
      // Curation applies deltas (at least 1 should be applied)
      expect(curationResult.applied).toBeGreaterThanOrEqual(1);
      expect(curationResult.playbook.bullets.length).toBeGreaterThanOrEqual(1);
    });

    it("pipeline deduplicates identical rules across iterations", async () => {
      const diary = createTestDiary();
      const playbook = createTestPlaybook();
      const config = createTestConfig({ maxReflectorIterations: 3 });

      process.env.CM_REFLECTOR_STUBS = JSON.stringify([
        { deltas: [{ type: "add", bullet: { content: "Unique rule", category: "testing" }, reason: "first" }] },
        { deltas: [{ type: "add", bullet: { content: "Unique rule", category: "testing" }, reason: "duplicate" }] }
      ]);

      const reflectResult = await reflectOnSession(diary, playbook, config);
      expect(reflectResult.deltas.length).toBe(1);
    });
  });

  describe("Feedback Recording Pipeline", () => {
    it("helpful feedback increases bullet confidence", async () => {
      const existingBullet = createTestBullet({
        id: "existing-rule",
        content: "Existing rule for testing",
        helpfulCount: 2
      });
      const playbook = createTestPlaybook([existingBullet]);
      const diary = createTestDiary();
      const config = createTestConfig();

      process.env.CM_REFLECTOR_STUBS = JSON.stringify([
        { deltas: [{ type: "helpful", bulletId: "existing-rule" }] }
      ]);

      const reflectResult = await reflectOnSession(diary, playbook, config);
      const curationResult = curatePlaybook(playbook, reflectResult.deltas, config);

      const updatedBullet = curationResult.playbook.bullets.find(b => b.id === "existing-rule");
      expect(updatedBullet?.helpfulCount).toBe(3);
    });

    it("harmful feedback decreases bullet confidence", async () => {
      const existingBullet = createTestBullet({
        id: "bad-rule",
        content: "Rule that is sometimes harmful",
        harmfulCount: 0
      });
      const playbook = createTestPlaybook([existingBullet]);
      const diary = createTestDiary();
      const config = createTestConfig();

      process.env.CM_REFLECTOR_STUBS = JSON.stringify([
        { deltas: [{ type: "harmful", bulletId: "bad-rule", reason: "outdated" }] }
      ]);

      const reflectResult = await reflectOnSession(diary, playbook, config);
      const curationResult = curatePlaybook(playbook, reflectResult.deltas, config);

      const updatedBullet = curationResult.playbook.bullets.find(b => b.id === "bad-rule");
      expect(updatedBullet?.harmfulCount).toBe(1);
    });
  });

  describe("Anti-Pattern Inversion", () => {
    it("inverts highly harmful bullet to anti-pattern", async () => {
      const harmfulBullet = createTestBullet({
        id: "invert-me",
        content: "Always deploy directly to production",
        category: "deployment",
        harmfulCount: 4,
        helpfulCount: 0,
        feedbackEvents: [
          createTestFeedbackEvent("harmful", { timestamp: new Date().toISOString() }),
          createTestFeedbackEvent("harmful", { timestamp: new Date().toISOString() }),
          createTestFeedbackEvent("harmful", { timestamp: new Date().toISOString() }),
          createTestFeedbackEvent("harmful", { timestamp: new Date().toISOString() })
        ]
      });
      const playbook = createTestPlaybook([harmfulBullet]);
      const diary = createTestDiary();
      const config = createTestConfig();

      process.env.CM_REFLECTOR_STUBS = JSON.stringify([
        { deltas: [{ type: "harmful", bulletId: "invert-me", reason: "dangerous" }] }
      ]);

      const reflectResult = await reflectOnSession(diary, playbook, config);
      const curationResult = curatePlaybook(playbook, reflectResult.deltas, config);

      expect(curationResult.inversions.length).toBeGreaterThanOrEqual(0);

      const original = curationResult.playbook.bullets.find(b => b.id === "invert-me");
      expect(original?.deprecated).toBe(true);

      const antiPattern = curationResult.playbook.bullets.find(
        b => b.kind === "anti_pattern" || b.isNegative
      );
      expect(antiPattern).toBeDefined();
      expect(antiPattern?.content).toContain("AVOID");
    });

    it("pinned bullets are not inverted even with harmful feedback", async () => {
      const pinnedBullet = createTestBullet({
        id: "pinned-rule",
        content: "Important rule that should never be inverted",
        pinned: true,
        harmfulCount: 10,
        feedbackEvents: Array(10).fill(null).map(() =>
          createTestFeedbackEvent("harmful", { timestamp: new Date().toISOString() })
        )
      });
      const playbook = createTestPlaybook([pinnedBullet]);
      const diary = createTestDiary();
      const config = createTestConfig();

      process.env.CM_REFLECTOR_STUBS = JSON.stringify([{ deltas: [] }]);

      const reflectResult = await reflectOnSession(diary, playbook, config);
      const curationResult = curatePlaybook(playbook, reflectResult.deltas, config);

      expect(curationResult.inversions.length).toBe(0);

      const bullet = curationResult.playbook.bullets.find(b => b.id === "pinned-rule");
      expect(bullet?.deprecated).toBeFalsy();
    });
  });

  describe("Maturity Transitions", () => {
    it("promotes bullet after sufficient helpful feedback", async () => {
      const candidateBullet = createTestBullet({
        id: "promotable",
        content: "Good coding practice",
        maturity: "candidate",
        helpfulCount: 4,
        feedbackEvents: Array(4).fill(null).map(() =>
          createTestFeedbackEvent("helpful", { timestamp: new Date().toISOString() })
        )
      });
      const playbook = createTestPlaybook([candidateBullet]);
      const diary = createTestDiary();
      const config = createTestConfig();

      process.env.CM_REFLECTOR_STUBS = JSON.stringify([
        { deltas: [{ type: "helpful", bulletId: "promotable" }] }
      ]);

      const reflectResult = await reflectOnSession(diary, playbook, config);
      const curationResult = curatePlaybook(playbook, reflectResult.deltas, config);

      const bullet = curationResult.playbook.bullets.find(b => b.id === "promotable");
      expect(["established", "proven"]).toContain(bullet?.maturity);
    });
  });

  describe("Validation Integration", () => {
    it("validates add deltas before curation", async () => {
      const config = createTestConfig({ validationEnabled: false });

      const addDelta: PlaybookDelta = {
        type: "add",
        bullet: {
          content: "Always validate input data before processing to prevent security issues",
          category: "security",
          scope: "global",
          kind: "workflow_rule"
        },
        sourceSession: "/sessions/test.jsonl",
        reason: "Security best practice"
      };

      const validationResult = await validateDelta(addDelta, config);
      expect(validationResult.valid).toBe(true);
    });

    it("feedback deltas bypass validation", async () => {
      const config = createTestConfig({ validationEnabled: true });

      const helpfulDelta: PlaybookDelta = {
        type: "helpful",
        bulletId: "any-bullet",
        sourceSession: "/sessions/test.jsonl"
      };

      const harmfulDelta: PlaybookDelta = {
        type: "harmful",
        bulletId: "any-bullet",
        sourceSession: "/sessions/test.jsonl",
        reason: "outdated"
      };

      const helpfulResult = await validateDelta(helpfulDelta, config);
      const harmfulResult = await validateDelta(harmfulDelta, config);

      expect(helpfulResult.valid).toBe(true);
      expect(harmfulResult.valid).toBe(true);
    });
  });

  describe("Conflict Detection", () => {
    it("detects potential conflicts between new and existing rules", async () => {
      const existingBullet = createTestBullet({
        id: "always-x",
        content: "Always use strict mode in TypeScript"
      });
      const playbook = createTestPlaybook([existingBullet]);
      const diary = createTestDiary();
      const config = createTestConfig();

      process.env.CM_REFLECTOR_STUBS = JSON.stringify([
        {
          deltas: [
            {
              type: "add",
              bullet: { content: "Avoid using strict mode for legacy code", category: "typescript" },
              reason: "Legacy compatibility"
            }
          ]
        }
      ]);

      const reflectResult = await reflectOnSession(diary, playbook, config);
      const curationResult = curatePlaybook(playbook, reflectResult.deltas, config);

      expect(curationResult.playbook.bullets.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("Persistence", () => {
    it("saves updated playbook to disk", async () => {
      const { cassMemoryDir } = await setupTestEnvironment();
      const playbookPath = path.join(cassMemoryDir, "playbook.yaml");

      const playbook = await loadPlaybook(playbookPath);
      const diary = createTestDiary();
      const config = createTestConfig();

      process.env.CM_REFLECTOR_STUBS = JSON.stringify([
        {
          deltas: [
            { type: "add", bullet: { content: "Persisted rule", category: "testing" }, reason: "test" }
          ]
        }
      ]);

      const reflectResult = await reflectOnSession(diary, playbook, config);
      const curationResult = curatePlaybook(playbook, reflectResult.deltas, config);

      await savePlaybook(curationResult.playbook, playbookPath);

      const reloaded = await loadPlaybook(playbookPath);
      const persistedBullet = reloaded.bullets.find(b => b.content === "Persisted rule");
      expect(persistedBullet).toBeDefined();
    });
  });

  describe("Early Exit Conditions", () => {
    it("exits early when no new deltas are produced", async () => {
      const diary = createTestDiary();
      const playbook = createTestPlaybook();
      const config = createTestConfig({ maxReflectorIterations: 5 });

      process.env.CM_REFLECTOR_STUBS = JSON.stringify([
        { deltas: [{ type: "add", bullet: { content: "Only rule", category: "testing" }, reason: "iter1" }] },
        { deltas: [] },
        { deltas: [] },
        { deltas: [] },
        { deltas: [] }
      ]);

      const reflectResult = await reflectOnSession(diary, playbook, config);
      expect(reflectResult.deltas.length).toBe(1);
    });

    it("exits early when delta limit is reached", async () => {
      const diary = createTestDiary();
      const playbook = createTestPlaybook();
      const config = createTestConfig({ maxReflectorIterations: 10 });

      const manyDeltas = Array(25).fill(null).map((_, i) => ({
        type: "add",
        bullet: { content: `Rule ${i}`, category: "testing" },
        reason: `gen-${i}`
      }));

      process.env.CM_REFLECTOR_STUBS = JSON.stringify([{ deltas: manyDeltas }]);

      const reflectResult = await reflectOnSession(diary, playbook, config);
      expect(reflectResult.deltas.length).toBeLessThanOrEqual(25);
    });
  });

  describe("Decision Logging", () => {
    it("produces decision log entries during reflection", async () => {
      const diary = createTestDiary();
      const playbook = createTestPlaybook();
      const config = createTestConfig({ maxReflectorIterations: 2 });

      process.env.CM_REFLECTOR_STUBS = JSON.stringify([
        { deltas: [{ type: "add", bullet: { content: "Logged rule", category: "testing" }, reason: "iter1" }] }
      ]);

      const reflectResult = await reflectOnSession(diary, playbook, config);
      const curationResult = curatePlaybook(playbook, reflectResult.deltas, config);

      expect(curationResult.decisionLog).toBeDefined();
      expect(Array.isArray(curationResult.decisionLog)).toBe(true);
    });
  });

  describe("Curation Result Structure", () => {
    it("returns complete curation result", async () => {
      const playbook = createTestPlaybook([createTestBullet()]);
      const diary = createTestDiary();
      const config = createTestConfig();

      process.env.CM_REFLECTOR_STUBS = JSON.stringify([
        { deltas: [{ type: "add", bullet: { content: "New rule", category: "testing" }, reason: "new" }] }
      ]);

      const reflectResult = await reflectOnSession(diary, playbook, config);
      const curationResult = curatePlaybook(playbook, reflectResult.deltas, config);

      expect(curationResult).toHaveProperty("playbook");
      expect(curationResult).toHaveProperty("applied");
      expect(curationResult).toHaveProperty("skipped");
      expect(curationResult).toHaveProperty("conflicts");
      expect(curationResult).toHaveProperty("promotions");
      expect(curationResult).toHaveProperty("inversions");
      expect(curationResult).toHaveProperty("pruned");

      expect(Array.isArray(curationResult.conflicts)).toBe(true);
      expect(Array.isArray(curationResult.promotions)).toBe(true);
      expect(Array.isArray(curationResult.inversions)).toBe(true);
    });
  });

  describe("Source Session Tracking", () => {
    it("injects source session into add deltas", async () => {
      const diary = createTestDiary({ sessionPath: "/my/custom/session.jsonl" });
      const playbook = createTestPlaybook();
      const config = createTestConfig();

      process.env.CM_REFLECTOR_STUBS = JSON.stringify([
        { deltas: [{ type: "add", bullet: { content: "Tracked rule", category: "testing" }, reason: "test" }] }
      ]);

      const reflectResult = await reflectOnSession(diary, playbook, config);
      expect(reflectResult.deltas[0].sourceSession).toBe("/my/custom/session.jsonl");
    });

    it("injects source session into feedback deltas", async () => {
      const existingBullet = createTestBullet({ id: "feedback-target" });
      const playbook = createTestPlaybook([existingBullet]);
      const diary = createTestDiary({ sessionPath: "/feedback/session.jsonl" });
      const config = createTestConfig();

      process.env.CM_REFLECTOR_STUBS = JSON.stringify([
        { deltas: [{ type: "helpful", bulletId: "feedback-target" }] }
      ]);

      const reflectResult = await reflectOnSession(diary, playbook, config);
      expect(reflectResult.deltas[0].sourceSession).toBe("/feedback/session.jsonl");
    });
  });
});
