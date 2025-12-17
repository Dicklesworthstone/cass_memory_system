/**
 * Unit tests for why command
 *
 * Tests:
 * - Bullet lookup (exact ID, not found)
 * - WhyResult building (score, sessions, diary entries, feedback)
 * - JSON output format
 * - Text output (via stdout capture)
 * - Edge cases (no evidence, no feedback, deprecated bullets)
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import yaml from "yaml";
import { Playbook, PlaybookBullet, DiaryEntry } from "../src/types.js";
import { whyCommand } from "../src/commands/why.js";
import { withTempCassHome, TestEnv } from "./helpers/temp.js";

// Helper to create a test bullet with known properties
function createTestBullet(overrides: Partial<PlaybookBullet> = {}): PlaybookBullet {
  return {
    id: overrides.id || "b-test123",
    content: overrides.content || "Test bullet content for why command",
    category: overrides.category || "testing",
    kind: "workflow_rule",
    type: "rule",
    isNegative: overrides.isNegative ?? false,
    scope: "global",
    source: "learned",
    tags: overrides.tags || [],
    state: "active",
    maturity: overrides.maturity || "candidate",
    createdAt: overrides.createdAt || "2025-01-01T00:00:00Z",
    updatedAt: overrides.updatedAt || "2025-01-01T00:00:00Z",
    sourceSessions: overrides.sourceSessions || [],
    sourceAgents: overrides.sourceAgents || [],
    helpfulCount: overrides.helpfulCount ?? 0,
    harmfulCount: overrides.harmfulCount ?? 0,
    feedbackEvents: overrides.feedbackEvents || [],
    deprecated: overrides.deprecated ?? false,
    pinned: false,
    reasoning: overrides.reasoning,
    confidenceDecayHalfLifeDays: overrides.confidenceDecayHalfLifeDays ?? 90
  };
}

// Helper to create a test playbook
function createTestPlaybook(bullets: PlaybookBullet[] = []): Playbook {
  return {
    schema_version: 2,
    name: "test-playbook",
    description: "Test playbook for why command",
    metadata: {
      createdAt: "2025-01-01T00:00:00Z",
      totalReflections: 0,
      totalSessionsProcessed: 0
    },
    deprecatedPatterns: [],
    bullets
  };
}

// Helper to create a diary entry
function createTestDiary(overrides: Partial<DiaryEntry> = {}): DiaryEntry {
  return {
    id: overrides.id ?? "diary-test123",
    sessionPath: overrides.sessionPath ?? "/tmp/session.jsonl",
    timestamp: overrides.timestamp ?? "2025-01-01T12:00:00Z",
    agent: overrides.agent ?? "claude",
    ...(overrides.workspace ? { workspace: overrides.workspace } : {}),
    ...(typeof overrides.duration === "number" ? { duration: overrides.duration } : {}),
    status: overrides.status ?? "success",
    accomplishments: overrides.accomplishments ?? ["Test accomplishment"],
    decisions: overrides.decisions ?? [],
    challenges: overrides.challenges ?? [],
    preferences: overrides.preferences ?? [],
    keyLearnings: overrides.keyLearnings ?? ["Test learning"],
    relatedSessions: overrides.relatedSessions ?? [],
    tags: overrides.tags ?? [],
    searchAnchors: overrides.searchAnchors ?? []
  };
}

// Helper to set up a test environment with playbook and config
async function setupTestEnv(env: TestEnv, bullets: PlaybookBullet[], diaries: DiaryEntry[] = []): Promise<void> {
  const playbook = createTestPlaybook(bullets);
  writeFileSync(env.playbookPath, yaml.stringify(playbook));

  // Create config
  writeFileSync(env.configPath, JSON.stringify({
    playbookPath: env.playbookPath,
    diaryDir: env.diaryDir
  }));

  // Write diary entries if provided
  for (const diary of diaries) {
    const diaryPath = join(env.diaryDir, `${diary.id}.json`);
    writeFileSync(diaryPath, JSON.stringify(diary, null, 2));
  }
}

// Helper to capture console output
function captureConsole(): { logs: string[]; errors: string[]; restore: () => void } {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;

  console.log = (...args) => logs.push(args.join(" "));
  console.error = (...args) => errors.push(args.join(" "));

  return {
    logs,
    errors,
    restore: () => {
      console.log = originalLog;
      console.error = originalError;
    }
  };
}

function parseJsonSuccessData(stdout: string): any {
  const payload = JSON.parse(stdout) as any;
  expect(payload.success).toBe(true);
  return payload.data;
}

function parseJsonError(stdout: string): any {
  const payload = JSON.parse(stdout) as any;
  expect(payload.success).toBe(false);
  return payload.error;
}

describe("why command - Unit Tests", () => {
  describe("bullet lookup", () => {
    test("finds bullet by exact ID", async () => {
      await withTempCassHome(async (env) => {
        const bullet = createTestBullet({
          id: "b-exact123",
          content: "Use const for immutable values"
        });
        await setupTestEnv(env, [bullet]);

        const capture = captureConsole();
        process.exitCode = 0;

        try {
          await whyCommand("b-exact123", { json: true });
        } finally {
          capture.restore();
        }

        expect(process.exitCode).toBe(0);

        // Parse JSON output
        const output = parseJsonSuccessData(capture.logs.join(""));
        expect(output.bullet.id).toBe("b-exact123");
        expect(output.bullet.content).toBe("Use const for immutable values");
      });
    });

    test("returns error for non-existent bullet", async () => {
      await withTempCassHome(async (env) => {
        await setupTestEnv(env, []);

        const capture = captureConsole();
        process.exitCode = 0;

        try {
          await whyCommand("b-nonexistent", { json: true });
        } finally {
          capture.restore();
        }

        expect(process.exitCode).toBe(2);

        // Parse JSON error
        const err = parseJsonError(capture.logs.join(""));
        expect(err.message).toContain("not found");
      });
    });

    test("returns error with text output for non-existent bullet", async () => {
      await withTempCassHome(async (env) => {
        await setupTestEnv(env, []);

        const capture = captureConsole();
        process.exitCode = 0;

        try {
          await whyCommand("b-nonexistent", {});
        } finally {
          capture.restore();
        }

        expect(process.exitCode).toBe(2);
        expect(capture.errors.some(e => e.includes("not found"))).toBe(true);
      });
    });
  });

  describe("WhyResult building", () => {
    test("includes bullet metadata in result", async () => {
      await withTempCassHome(async (env) => {
        const bullet = createTestBullet({
          id: "b-meta123",
          content: "Test metadata extraction",
          category: "architecture",
          maturity: "proven",
          createdAt: "2025-06-15T10:30:00Z",
          helpfulCount: 5,
          harmfulCount: 1
        });
        await setupTestEnv(env, [bullet]);

        const capture = captureConsole();
        process.exitCode = 0;

        try {
          await whyCommand("b-meta123", { json: true });
        } finally {
          capture.restore();
        }

        expect(process.exitCode).toBe(0);

        const output = parseJsonSuccessData(capture.logs.join(""));
        expect(output.bullet.category).toBe("architecture");
        expect(output.bullet.maturity).toBe("proven");
        expect(output.bullet.createdAt).toBe("2025-06-15T10:30:00Z");
        expect(output.currentStatus.helpfulCount).toBe(5);
        expect(output.currentStatus.harmfulCount).toBe(1);
      });
    });

    test("includes reasoning when present", async () => {
      await withTempCassHome(async (env) => {
        const bullet = createTestBullet({
          id: "b-reason123",
          reasoning: 'Learned from session where "async operations" caused issues'
        });
        await setupTestEnv(env, [bullet]);

        const capture = captureConsole();
        process.exitCode = 0;

        try {
          await whyCommand("b-reason123", { json: true });
        } finally {
          capture.restore();
        }

        const output = parseJsonSuccessData(capture.logs.join(""));
        expect(output.reasoning).toContain("async operations");
      });
    });

    test("extracts evidence from reasoning quotes", async () => {
      await withTempCassHome(async (env) => {
        const bullet = createTestBullet({
          id: "b-evidence123",
          reasoning: 'The user said "always validate input" and "never trust user data"'
        });
        await setupTestEnv(env, [bullet]);

        const capture = captureConsole();
        process.exitCode = 0;

        try {
          await whyCommand("b-evidence123", { json: true });
        } finally {
          capture.restore();
        }

        const output = parseJsonSuccessData(capture.logs.join(""));
        expect(output.evidence).toContain("always validate input");
        expect(output.evidence).toContain("never trust user data");
      });
    });

    test("includes feedback history", async () => {
      await withTempCassHome(async (env) => {
        const bullet = createTestBullet({
          id: "b-feedback123",
          feedbackEvents: [
            {
              type: "helpful",
              timestamp: "2025-06-01T10:00:00Z",
              sessionPath: "/sessions/s1.jsonl"
            },
            {
              type: "harmful",
              timestamp: "2025-06-02T10:00:00Z",
              reason: "caused_bug"
            }
          ]
        });
        await setupTestEnv(env, [bullet]);

        const capture = captureConsole();
        process.exitCode = 0;

        try {
          await whyCommand("b-feedback123", { json: true });
        } finally {
          capture.restore();
        }

        const output = parseJsonSuccessData(capture.logs.join(""));
        expect(output.feedbackHistory).toHaveLength(2);
        expect(output.feedbackHistory[0].type).toBe("harmful"); // Sorted by timestamp desc
        expect(output.feedbackHistory[1].type).toBe("helpful");
      });
    });

    test("calculates effectiveness based on score and helpful count", async () => {
      await withTempCassHome(async (env) => {
        const bullet = createTestBullet({
          id: "b-effective123",
          helpfulCount: 15,
          harmfulCount: 0
        });
        await setupTestEnv(env, [bullet]);

        const capture = captureConsole();
        process.exitCode = 0;

        try {
          await whyCommand("b-effective123", { json: true });
        } finally {
          capture.restore();
        }

        const output = parseJsonSuccessData(capture.logs.join(""));
        // Effectiveness should be one of the defined levels
        expect(["Very high", "High", "Moderate", "Low", "Negative"]).toContain(
          output.currentStatus.effectiveness
        );
        // Verify counts are passed through correctly
        expect(output.currentStatus.helpfulCount).toBe(15);
        expect(output.currentStatus.harmfulCount).toBe(0);
      });
    });
  });

  describe("source sessions", () => {
    test("includes source session paths", async () => {
      await withTempCassHome(async (env) => {
        const bullet = createTestBullet({
          id: "b-sources123",
          sourceSessions: [
            "/sessions/session1.jsonl",
            "/sessions/session2.jsonl"
          ]
        });
        await setupTestEnv(env, [bullet]);

        const capture = captureConsole();
        process.exitCode = 0;

        try {
          await whyCommand("b-sources123", { json: true });
        } finally {
          capture.restore();
        }

        const output = parseJsonSuccessData(capture.logs.join(""));
        expect(output.sourceSessions).toHaveLength(2);
        expect(output.sourceSessions[0].path).toBe("/sessions/session1.jsonl");
        expect(output.sourceSessions[1].path).toBe("/sessions/session2.jsonl");
      });
    });

    test("limits source sessions to 5 by default", async () => {
      await withTempCassHome(async (env) => {
        const sessions = Array.from({ length: 10 }, (_, i) => `/sessions/s${i}.jsonl`);
        const bullet = createTestBullet({
          id: "b-many123",
          sourceSessions: sessions
        });
        await setupTestEnv(env, [bullet]);

        const capture = captureConsole();
        process.exitCode = 0;

        try {
          await whyCommand("b-many123", { json: true });
        } finally {
          capture.restore();
        }

        const output = parseJsonSuccessData(capture.logs.join(""));
        expect(output.sourceSessions).toHaveLength(5);
      });
    });

    test("shows 10 source sessions with verbose flag", async () => {
      await withTempCassHome(async (env) => {
        const sessions = Array.from({ length: 15 }, (_, i) => `/sessions/s${i}.jsonl`);
        const bullet = createTestBullet({
          id: "b-verbose123",
          sourceSessions: sessions
        });
        await setupTestEnv(env, [bullet]);

        const capture = captureConsole();
        process.exitCode = 0;

        try {
          await whyCommand("b-verbose123", { json: true, verbose: true });
        } finally {
          capture.restore();
        }

        const output = parseJsonSuccessData(capture.logs.join(""));
        expect(output.sourceSessions).toHaveLength(10);
      });
    });
  });

  describe("edge cases", () => {
    test("handles bullet with no evidence gracefully", async () => {
      await withTempCassHome(async (env) => {
        const bullet = createTestBullet({
          id: "b-noevidence123",
          sourceSessions: [],
          feedbackEvents: [],
          reasoning: undefined
        });
        await setupTestEnv(env, [bullet]);

        const capture = captureConsole();
        process.exitCode = 0;

        try {
          await whyCommand("b-noevidence123", { json: true });
        } finally {
          capture.restore();
        }

        expect(process.exitCode).toBe(0);
        const output = parseJsonSuccessData(capture.logs.join(""));
        expect(output.sourceSessions).toHaveLength(0);
        expect(output.feedbackHistory).toHaveLength(0);
        expect(output.reasoning).toBeNull();
        expect(output.evidence).toHaveLength(0);
      });
    });

    test("handles deprecated bullet", async () => {
      await withTempCassHome(async (env) => {
        const bullet = createTestBullet({
          id: "b-deprecated123",
          deprecated: true,
          deprecationReason: "Outdated practice"
        });
        await setupTestEnv(env, [bullet]);

        const capture = captureConsole();
        process.exitCode = 0;

        try {
          await whyCommand("b-deprecated123", { json: true });
        } finally {
          capture.restore();
        }

        expect(process.exitCode).toBe(0);
        const output = parseJsonSuccessData(capture.logs.join(""));
        expect(output.bullet.id).toBe("b-deprecated123");
      });
    });

    test("handles anti-pattern bullet (isNegative)", async () => {
      await withTempCassHome(async (env) => {
        const bullet = createTestBullet({
          id: "b-antipattern123",
          content: "AVOID: Using var for variable declarations",
          isNegative: true,
          tags: ["anti-pattern"]
        });
        await setupTestEnv(env, [bullet]);

        const capture = captureConsole();
        process.exitCode = 0;

        try {
          await whyCommand("b-antipattern123", { json: true });
        } finally {
          capture.restore();
        }

        expect(process.exitCode).toBe(0);
        const output = parseJsonSuccessData(capture.logs.join(""));
        expect(output.bullet.content).toContain("AVOID:");
      });
    });

    test("handles bullet with special characters in content", async () => {
      await withTempCassHome(async (env) => {
        const bullet = createTestBullet({
          id: "b-special123",
          content: 'Use "double quotes" and handle <html> & special chars'
        });
        await setupTestEnv(env, [bullet]);

        const capture = captureConsole();
        process.exitCode = 0;

        try {
          await whyCommand("b-special123", { json: true });
        } finally {
          capture.restore();
        }

        expect(process.exitCode).toBe(0);
        const output = parseJsonSuccessData(capture.logs.join(""));
        expect(output.bullet.content).toContain("double quotes");
        expect(output.bullet.content).toContain("<html>");
      });
    });
  });

  describe("text output", () => {
    test("displays formatted output for bullet", async () => {
      await withTempCassHome(async (env) => {
        const bullet = createTestBullet({
          id: "b-text123",
          content: "Always handle errors explicitly",
          category: "error-handling",
          maturity: "proven",
          helpfulCount: 8,
          harmfulCount: 2
        });
        await setupTestEnv(env, [bullet]);

        const capture = captureConsole();
        process.exitCode = 0;

        try {
          await whyCommand("b-text123", {});
        } finally {
          capture.restore();
        }

        expect(process.exitCode).toBe(0);

        const output = capture.logs.join("\n");
        expect(output).toContain("WHY");
        expect(output).toContain("b-text123");
        expect(output).toContain("error-handling");
        expect(output).toContain("proven");
        expect(output).toContain("Always handle errors explicitly");
        expect(output).toContain("8 helpful");
        expect(output).toContain("2 harmful");
      });
    });

    test("shows next step suggestions in text output", async () => {
      await withTempCassHome(async (env) => {
        const bullet = createTestBullet({ id: "b-tip123" });
        await setupTestEnv(env, [bullet]);

        const capture = captureConsole();
        process.exitCode = 0;

        try {
          await whyCommand("b-tip123", {});
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        expect(output).toContain("playbook get");
        expect(output).toContain("mark");
      });
    });
  });

  describe("diary integration", () => {
    test("handles empty diary directory gracefully", async () => {
      await withTempCassHome(async (env) => {
        const bullet = createTestBullet({
          id: "b-diary123",
          createdAt: "2025-06-15T12:00:00Z"
        });
        await setupTestEnv(env, [bullet], []);

        const capture = captureConsole();
        process.exitCode = 0;

        try {
          await whyCommand("b-diary123", { json: true });
        } finally {
          capture.restore();
        }

        expect(process.exitCode).toBe(0);
        const output = parseJsonSuccessData(capture.logs.join(""));
        // diaryEntries should be empty array when no diaries exist
        expect(Array.isArray(output.diaryEntries)).toBe(true);
      });
    });

    test("includes diaryEntries field in result", async () => {
      await withTempCassHome(async (env) => {
        const bullet = createTestBullet({
          id: "b-diary456"
        });
        await setupTestEnv(env, [bullet]);

        const capture = captureConsole();
        process.exitCode = 0;

        try {
          await whyCommand("b-diary456", { json: true });
        } finally {
          capture.restore();
        }

        const output = parseJsonSuccessData(capture.logs.join(""));
        expect(output).toHaveProperty("diaryEntries");
        expect(Array.isArray(output.diaryEntries)).toBe(true);
      });
    });
  });
});
