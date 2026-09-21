/**
 * E2E Tests for Multi-Session Learning (Scenario 7)
 *
 * Tests the system's ability to learn across multiple sessions:
 * - Process session A → extract deltas
 * - Process session B → extract deltas (references A's learnings)
 * - Process session C → verify deduplication
 * - Verify playbook growth curve
 *
 * Uses stubbed LLM via CM_REFLECTOR_STUBS to avoid external dependencies.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { curatePlaybook } from "../src/curate.js";
import { __resetReflectorStubsForTest } from "../src/llm.js";
import { createEmptyPlaybook, loadPlaybook, savePlaybook } from "../src/playbook.js";
import { ReflectionResult, reflectOnSession } from "../src/reflect.js";
import { CurationResult, type DiaryEntry, Playbook, type PlaybookDelta } from "../src/types.js";
import { createTestBullet, createTestConfig, createTestPlaybook } from "./helpers/index.js";
import { createTestLogger, type TestLogger } from "./helpers/logger.js";

// --- Test Infrastructure ---

let tempDirs: string[] = [];
let logger: TestLogger;

async function createTempDir(): Promise<string> {
  const dirPath = path.join(
    os.tmpdir(),
    `multi-session-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(dirPath, { recursive: true });
  tempDirs.push(dirPath);
  return dirPath;
}

function createTestDiary(overrides: Partial<DiaryEntry> = {}): DiaryEntry {
  return {
    id: `diary-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    sessionPath: `/sessions/session-${Date.now()}.jsonl`,
    timestamp: new Date().toISOString(),
    agent: "claude-code",
    status: "success",
    accomplishments: ["Completed task"],
    decisions: ["Made a decision"],
    challenges: [],
    preferences: [],
    keyLearnings: ["Learned something"],
    relatedSessions: [],
    tags: ["testing"],
    searchAnchors: [],
    ...overrides,
  };
}

async function setupTestEnvironment() {
  const dir = await createTempDir();
  const home = path.join(dir, "home");
  const cassMemoryDir = path.join(home, ".cass-memory");

  await mkdir(cassMemoryDir, { recursive: true });
  await mkdir(path.join(cassMemoryDir, "diary"), { recursive: true });

  const config = { schema_version: 1 };
  await writeFile(path.join(cassMemoryDir, "config.json"), JSON.stringify(config));

  const playbook = createEmptyPlaybook("test");
  const playbookPath = path.join(cassMemoryDir, "playbook.yaml");
  await savePlaybook(playbook, playbookPath);

  return { dir, home, cassMemoryDir, playbookPath };
}

// --- Test Suites ---

describe("E2E: Multi-Session Learning (Scenario 7)", () => {
  beforeEach(() => {
    delete process.env.CM_REFLECTOR_STUBS;
    __resetReflectorStubsForTest();
    logger = createTestLogger("multi-session-learning", "debug");
    logger.startStep("setup");
  });

  afterEach(async () => {
    delete process.env.CM_REFLECTOR_STUBS;
    __resetReflectorStubsForTest();
    logger.endStep("teardown");

    for (const dir of tempDirs) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    tempDirs = [];
  });

  describe("Sequential Session Processing", () => {
    it("processes multiple sessions and accumulates unique rules", async () => {
      logger.startStep("session-accumulation");

      const playbook = createTestPlaybook();
      const config = createTestConfig({ maxReflectorIterations: 2 });

      // Session A: First learning - database validation
      const diaryA = createTestDiary({
        sessionPath: "/sessions/session-a.jsonl",
        keyLearnings: ["Validate database queries"],
      });

      process.env.CM_REFLECTOR_STUBS = JSON.stringify([
        {
          deltas: [
            {
              type: "add",
              bullet: {
                content: "Always sanitize SQL queries to prevent injection attacks",
                category: "security",
              },
              reason: "Prevents SQL injection",
              sourceSession: diaryA.sessionPath,
            },
          ],
        },
      ]);

      logger.step("session-a", "info", "Processing session A", { path: diaryA.sessionPath });
      const resultA = await reflectOnSession(diaryA, playbook, config);
      const curationA = curatePlaybook(playbook, resultA.deltas, config);

      expect(resultA.deltas.length).toBe(1);
      expect(curationA.applied).toBe(1);
      logger.step("session-a", "info", "Session A complete", {
        deltas: resultA.deltas.length,
        applied: curationA.applied,
        bulletCount: curationA.playbook.bullets.length,
      });

      // Session B: Second learning (completely different topic - caching)
      __resetReflectorStubsForTest();
      const diaryB = createTestDiary({
        sessionPath: "/sessions/session-b.jsonl",
        keyLearnings: ["Implement caching strategy"],
      });

      process.env.CM_REFLECTOR_STUBS = JSON.stringify([
        {
          deltas: [
            {
              type: "add",
              bullet: {
                content: "Use Redis for distributed caching in microservices architecture",
                category: "performance",
              },
              reason: "Improves latency",
              sourceSession: diaryB.sessionPath,
            },
          ],
        },
      ]);

      logger.step("session-b", "info", "Processing session B", { path: diaryB.sessionPath });
      const resultB = await reflectOnSession(diaryB, curationA.playbook, config);
      const curationB = curatePlaybook(curationA.playbook, resultB.deltas, config);

      expect(resultB.deltas.length).toBe(1);
      expect(curationB.applied).toBe(1);
      expect(curationB.playbook.bullets.length).toBe(2);
      logger.step("session-b", "info", "Session B complete", {
        deltas: resultB.deltas.length,
        applied: curationB.applied,
        bulletCount: curationB.playbook.bullets.length,
      });

      // Session C: Third session with EXACT duplicate of session A
      __resetReflectorStubsForTest();
      const diaryC = createTestDiary({
        sessionPath: "/sessions/session-c.jsonl",
        keyLearnings: ["SQL injection prevention"],
      });

      process.env.CM_REFLECTOR_STUBS = JSON.stringify([
        {
          deltas: [
            {
              type: "add",
              bullet: {
                content: "Always sanitize SQL queries to prevent injection attacks",
                category: "security",
              },
              reason: "Re-learned",
              sourceSession: diaryC.sessionPath,
            },
          ],
        },
      ]);

      logger.step("session-c", "info", "Processing session C (duplicate)", {
        path: diaryC.sessionPath,
      });
      const resultC = await reflectOnSession(diaryC, curationB.playbook, config);
      const curationC = curatePlaybook(curationB.playbook, resultC.deltas, config);

      // Duplicate is now applied as reinforcement (adds helpful feedback)
      expect(curationC.applied).toBeGreaterThanOrEqual(1);
      expect(curationC.playbook.bullets.length).toBe(2); // No new bullet added (reinforcement doesn't add bullets)
      logger.step("session-c", "info", "Session C complete (dedup via reinforcement)", {
        deltas: resultC.deltas.length,
        applied: curationC.applied,
        skipped: curationC.skipped,
        bulletCount: curationC.playbook.bullets.length,
      });

      logger.endStep("session-accumulation");
    });

    it("deduplicates within same reflection iteration", async () => {
      logger.startStep("intra-session-dedup");

      const playbook = createTestPlaybook();
      const diary = createTestDiary();
      const config = createTestConfig({ maxReflectorIterations: 3 });

      // LLM produces same rule multiple times in different iterations
      process.env.CM_REFLECTOR_STUBS = JSON.stringify([
        {
          deltas: [
            {
              type: "add",
              bullet: { content: "Unique rule A", category: "testing" },
              reason: "iter1",
            },
          ],
        },
        {
          deltas: [
            {
              type: "add",
              bullet: { content: "Unique rule A", category: "testing" },
              reason: "iter2-dup",
            },
          ],
        },
        {
          deltas: [
            {
              type: "add",
              bullet: { content: "Unique rule B", category: "testing" },
              reason: "iter3",
            },
          ],
        },
      ]);

      const result = await reflectOnSession(diary, playbook, config);

      // Should deduplicate to 2 unique rules
      expect(result.deltas.length).toBe(2);

      const contents = result.deltas
        .filter((d): d is PlaybookDelta & { type: "add" } => d.type === "add")
        .map((d) => d.bullet.content);
      expect(contents).toContain("Unique rule A");
      expect(contents).toContain("Unique rule B");

      logger.step("intra-session-dedup", "info", "Deduplication verified", {
        inputIterations: 3,
        outputDeltas: result.deltas.length,
      });
      logger.endStep("intra-session-dedup");
    });

    it("tracks playbook growth curve across sessions", async () => {
      logger.startStep("growth-curve");

      let playbook = createTestPlaybook();
      const config = createTestConfig({ maxReflectorIterations: 1 });
      const growthStats: {
        session: number;
        bulletCount: number;
        applied: number;
        skipped: number;
      }[] = [];

      // Sessions 0-2: unique rules (growth phase) - very different content to avoid similarity matching
      // Sessions 3-4: exact duplicates of session 0 (plateau phase)
      const sessionContents = [
        "Always validate user input before processing database queries",
        "Use environment variables for configuration secrets and API keys",
        "Implement retry logic with exponential backoff for network requests",
        "Always validate user input before processing database queries", // Exact duplicate
        "Always validate user input before processing database queries", // Exact duplicate
      ];

      for (let i = 0; i < sessionContents.length; i++) {
        __resetReflectorStubsForTest();
        const diary = createTestDiary({ sessionPath: `/sessions/session-${i}.jsonl` });

        process.env.CM_REFLECTOR_STUBS = JSON.stringify([
          {
            deltas: [
              {
                type: "add",
                bullet: { content: sessionContents[i], category: "testing" },
                reason: `session-${i}`,
              },
            ],
          },
        ]);

        const result = await reflectOnSession(diary, playbook, config);
        const curation = curatePlaybook(playbook, result.deltas, config);

        growthStats.push({
          session: i,
          bulletCount: curation.playbook.bullets.length,
          applied: curation.applied,
          skipped: curation.skipped,
        });

        playbook = curation.playbook;

        logger.step("growth-curve", "info", `Session ${i} processed`, growthStats[i]);
      }

      // Verify growth pattern
      expect(growthStats[0].bulletCount).toBe(1); // First rule
      expect(growthStats[1].bulletCount).toBe(2); // Second unique rule
      expect(growthStats[2].bulletCount).toBe(3); // Third unique rule
      expect(growthStats[3].bulletCount).toBe(3); // Duplicate reinforced (still 3 bullets)
      expect(growthStats[4].bulletCount).toBe(3); // Duplicate reinforced (still 3 bullets)

      // Duplicates are now applied as reinforcements (not skipped)
      // They add helpful feedback to existing rules
      expect(growthStats[3].applied).toBe(1); // Duplicate reinforced
      expect(growthStats[4].applied).toBe(1); // Duplicate reinforced

      logger.step("growth-curve", "info", "Growth curve analysis", {
        finalBulletCount: playbook.bullets.length,
        totalSessions: 5,
        uniqueRules: 3,
        duplicatesReinforced: 2,
      });
      logger.endStep("growth-curve");
    });
  });

  describe("Cross-Session Reference", () => {
    it("helpful feedback reinforces rules across sessions", async () => {
      logger.startStep("cross-session-feedback");

      // Setup: Create playbook with existing rule
      const existingBullet = createTestBullet({
        id: "existing-rule",
        content: "Use atomic writes for safety",
        maturity: "candidate",
        helpfulCount: 2,
      });
      const playbook = createTestPlaybook([existingBullet]);
      const config = createTestConfig();

      // Session A: Helpful feedback
      const diaryA = createTestDiary({ sessionPath: "/sessions/feedback-a.jsonl" });
      process.env.CM_REFLECTOR_STUBS = JSON.stringify([
        { deltas: [{ type: "helpful", bulletId: "existing-rule" }] },
      ]);

      const resultA = await reflectOnSession(diaryA, playbook, config);
      const curationA = curatePlaybook(playbook, resultA.deltas, config);
      const bulletAfterA = curationA.playbook.bullets.find((b) => b.id === "existing-rule");

      expect(bulletAfterA?.helpfulCount).toBe(3);
      logger.step("cross-session-feedback", "info", "Session A feedback applied", {
        helpfulCount: bulletAfterA?.helpfulCount,
      });

      // Session B: More helpful feedback
      __resetReflectorStubsForTest();
      const diaryB = createTestDiary({ sessionPath: "/sessions/feedback-b.jsonl" });
      process.env.CM_REFLECTOR_STUBS = JSON.stringify([
        { deltas: [{ type: "helpful", bulletId: "existing-rule" }] },
      ]);

      const resultB = await reflectOnSession(diaryB, curationA.playbook, config);
      const curationB = curatePlaybook(curationA.playbook, resultB.deltas, config);
      const bulletAfterB = curationB.playbook.bullets.find((b) => b.id === "existing-rule");

      expect(bulletAfterB?.helpfulCount).toBe(4);

      // Check for maturity promotion
      logger.step("cross-session-feedback", "info", "Session B feedback applied", {
        helpfulCount: bulletAfterB?.helpfulCount,
        maturity: bulletAfterB?.maturity,
      });

      logger.endStep("cross-session-feedback");
    });

    it("harmful feedback accumulates to trigger inversion", async () => {
      logger.startStep("cross-session-harmful");

      // Setup: Rule that will become harmful
      const harmfulBullet = createTestBullet({
        id: "bad-rule",
        content: "Always deploy directly to production",
        maturity: "candidate",
        harmfulCount: 3,
        feedbackEvents: [
          { type: "harmful", timestamp: new Date().toISOString() },
          { type: "harmful", timestamp: new Date().toISOString() },
          { type: "harmful", timestamp: new Date().toISOString() },
        ],
      });
      let playbook = createTestPlaybook([harmfulBullet]);
      const config = createTestConfig();

      // Multiple sessions report harmful
      for (let i = 0; i < 2; i++) {
        __resetReflectorStubsForTest();
        const diary = createTestDiary({ sessionPath: `/sessions/harmful-${i}.jsonl` });
        process.env.CM_REFLECTOR_STUBS = JSON.stringify([
          { deltas: [{ type: "harmful", bulletId: "bad-rule", reason: "dangerous" }] },
        ]);

        const result = await reflectOnSession(diary, playbook, config);
        const curation = curatePlaybook(playbook, result.deltas, config);
        playbook = curation.playbook;

        logger.step("cross-session-harmful", "info", `Harmful session ${i}`, {
          harmfulCount: playbook.bullets.find((b) => b.id === "bad-rule")?.harmfulCount,
          inversions: curation.inversions.length,
        });
      }

      // Verify inversion occurred
      const original = playbook.bullets.find((b) => b.id === "bad-rule");
      const antiPattern = playbook.bullets.find((b) => b.kind === "anti_pattern" || b.isNegative);

      expect(original?.deprecated).toBe(true);
      expect(antiPattern).toBeDefined();
      expect(antiPattern?.content).toContain("AVOID");

      logger.step("cross-session-harmful", "info", "Inversion verified", {
        originalDeprecated: original?.deprecated,
        antiPatternCreated: !!antiPattern,
      });
      logger.endStep("cross-session-harmful");
    });
  });

  describe("Delta Statistics", () => {
    it("tracks delta counts and dedup stats across session batch", async () => {
      logger.startStep("delta-stats");

      let playbook = createTestPlaybook();
      const config = createTestConfig({ maxReflectorIterations: 2 });

      let totalDeltas = 0;
      let totalApplied = 0;
      let totalSkipped = 0;

      // Process batch of sessions
      const sessionCount = 4;
      for (let i = 0; i < sessionCount; i++) {
        __resetReflectorStubsForTest();
        const diary = createTestDiary({ sessionPath: `/sessions/batch-${i}.jsonl` });

        // Mix of new and duplicate rules
        const deltas =
          i % 2 === 0
            ? [
                {
                  type: "add",
                  bullet: { content: `Batch rule ${i}`, category: "testing" },
                  reason: "new",
                },
              ]
            : [
                {
                  type: "add",
                  bullet: { content: "Batch rule 0", category: "testing" },
                  reason: "dup",
                },
              ]; // Duplicate

        process.env.CM_REFLECTOR_STUBS = JSON.stringify([{ deltas }]);

        const result = await reflectOnSession(diary, playbook, config);
        const curation = curatePlaybook(playbook, result.deltas, config);

        totalDeltas += result.deltas.length;
        totalApplied += curation.applied;
        totalSkipped += curation.skipped;
        playbook = curation.playbook;
      }

      logger.step("delta-stats", "info", "Batch processing complete", {
        sessions: sessionCount,
        totalDeltas,
        totalApplied,
        totalSkipped,
        finalBullets: playbook.bullets.length,
        applicationRate: totalApplied / totalDeltas,
      });

      // With the new reinforcement behavior, duplicates are applied (not skipped)
      // Verify deduplication by checking final bullet count is less than total deltas
      expect(totalApplied).toBeGreaterThan(0);
      expect(playbook.bullets.length).toBeLessThan(sessionCount);

      logger.endStep("delta-stats");
    });
  });

  describe("Persistence Across Sessions", () => {
    it("saves and loads playbook between sessions", async () => {
      logger.startStep("persistence");

      const { playbookPath } = await setupTestEnvironment();
      const config = createTestConfig();

      // Session 1: Add rule and save
      __resetReflectorStubsForTest();
      let playbook = await loadPlaybook(playbookPath);
      const diary1 = createTestDiary({ sessionPath: "/sessions/persist-1.jsonl" });

      process.env.CM_REFLECTOR_STUBS = JSON.stringify([
        {
          deltas: [
            {
              type: "add",
              bullet: {
                content: "Always use parameterized queries for database access",
                category: "security",
              },
              reason: "session1",
            },
          ],
        },
      ]);

      const result1 = await reflectOnSession(diary1, playbook, config);
      const curation1 = curatePlaybook(playbook, result1.deltas, config);
      await savePlaybook(curation1.playbook, playbookPath);

      logger.step("persistence", "info", "Session 1 saved", {
        bullets: curation1.playbook.bullets.length,
      });

      // Session 2: Load and add another rule (completely different content)
      __resetReflectorStubsForTest();
      playbook = await loadPlaybook(playbookPath);
      expect(playbook.bullets.length).toBe(1);

      const diary2 = createTestDiary({ sessionPath: "/sessions/persist-2.jsonl" });
      process.env.CM_REFLECTOR_STUBS = JSON.stringify([
        {
          deltas: [
            {
              type: "add",
              bullet: {
                content: "Implement health checks for all microservices endpoints",
                category: "devops",
              },
              reason: "session2",
            },
          ],
        },
      ]);

      const result2 = await reflectOnSession(diary2, playbook, config);
      const curation2 = curatePlaybook(playbook, result2.deltas, config);
      await savePlaybook(curation2.playbook, playbookPath);

      logger.step("persistence", "info", "Session 2 saved", {
        bullets: curation2.playbook.bullets.length,
      });

      // Verify final state
      const finalPlaybook = await loadPlaybook(playbookPath);
      expect(finalPlaybook.bullets.length).toBe(2);

      const contents = finalPlaybook.bullets.map((b) => b.content);
      expect(contents).toContain("Always use parameterized queries for database access");
      expect(contents).toContain("Implement health checks for all microservices endpoints");

      logger.step("persistence", "info", "Persistence verified", {
        finalBullets: finalPlaybook.bullets.length,
      });
      logger.endStep("persistence");
    });
  });
});
