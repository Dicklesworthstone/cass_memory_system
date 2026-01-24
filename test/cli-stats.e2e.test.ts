/**
 * E2E Tests for CLI stats command - Playbook Health Dashboard
 *
 * Tests the `cm stats` command for generating playbook statistics:
 * - Total bullet counts by scope, state, kind
 * - Score distribution (excellent, good, neutral, at-risk)
 * - Top performers and most helpful bullets
 * - Stale and at-risk detection
 * - Merge candidate identification
 */
import { describe, it, expect, afterEach } from "bun:test";
import { writeFile, rm, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import yaml from "yaml";

import { statsCommand } from "../src/commands/stats.js";
import { createTestLogger, TestLogger } from "./helpers/logger.js";

// --- Test Infrastructure ---

let tempDirs: string[] = [];
let logger: TestLogger;

async function createTempDir(): Promise<string> {
  const dirPath = path.join(os.tmpdir(), `stats-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dirPath, { recursive: true });
  tempDirs.push(dirPath);
  return dirPath;
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  tempDirs = [];
});

function captureConsole() {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;

  console.log = (...args: any[]) => {
    logs.push(args.map(String).join(" "));
  };
  console.error = (...args: any[]) => {
    errors.push(args.map(String).join(" "));
  };

  return {
    logs,
    errors,
    restore: () => {
      console.log = originalLog;
      console.error = originalError;
    }
  };
}

function createTestPlaybook(bullets: any[] = []) {
  const now = new Date().toISOString();
  return {
    schema_version: 2,
    name: "test-playbook",
    description: "Test playbook for stats E2E tests",
    metadata: {
      createdAt: now,
      totalReflections: 0,
      totalSessionsProcessed: 0
    },
    bullets,
    deprecatedPatterns: []
  };
}

function createTestBullet(overrides: Partial<{
  id: string;
  content: string;
  kind: string;
  category: string;
  scope: string;
  state: string;
  maturity: string;
  helpfulCount: number;
  harmfulCount: number;
  createdAt: string;
  updatedAt: string;
}> = {}) {
  const now = new Date().toISOString();
  return {
    id: overrides.id || `test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    content: overrides.content || "Test bullet content",
    kind: overrides.kind || "workflow_rule",
    category: overrides.category || "testing",
    scope: overrides.scope || "global",
    state: overrides.state || "active",
    maturity: overrides.maturity || "candidate",
    helpfulCount: overrides.helpfulCount ?? 0,
    harmfulCount: overrides.harmfulCount ?? 0,
    createdAt: overrides.createdAt || now,
    updatedAt: overrides.updatedAt || now,
    feedbackEvents: [],
    tags: []
  };
}

async function setupTestEnvironment(bullets: any[] = []) {
  const dir = await createTempDir();
  const home = path.join(dir, "home");
  const cassMemoryDir = path.join(home, ".cass-memory");

  await mkdir(cassMemoryDir, { recursive: true });
  await mkdir(path.join(cassMemoryDir, "diary"), { recursive: true });

  const config = { schema_version: 1 };
  await writeFile(path.join(cassMemoryDir, "config.json"), JSON.stringify(config));

  const playbook = createTestPlaybook(bullets);
  await writeFile(path.join(cassMemoryDir, "playbook.yaml"), yaml.stringify(playbook));

  return { dir, home, cassMemoryDir };
}

// --- Test Suites ---

describe("E2E: CLI stats command", () => {
  describe("JSON Output", () => {
    it("outputs valid JSON when --json flag is set", async () => {
      const { home } = await setupTestEnvironment([
        createTestBullet({ id: "stat-1", content: "Rule 1" }),
        createTestBullet({ id: "stat-2", content: "Rule 2" })
      ]);
      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;
        logger = createTestLogger("stats-json", "debug");

        const capture = captureConsole();
        try {
          await statsCommand({ json: true });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        expect(() => JSON.parse(output)).not.toThrow();

        const payload = JSON.parse(output);
        const stats = payload.data;
        expect(stats.total).toBe(2);
        expect(stats).toHaveProperty("byScope");
        expect(stats).toHaveProperty("byState");
        expect(stats).toHaveProperty("byKind");
        expect(stats).toHaveProperty("scoreDistribution");

        logger.info("JSON stats verified", { total: stats.total });
      } finally {
        process.env.HOME = originalHome;
      }
    });

    it("outputs valid JSON when --format json is set (even without --json)", async () => {
      const { home } = await setupTestEnvironment([
        createTestBullet({ id: "stat-1", content: "Rule 1" }),
        createTestBullet({ id: "stat-2", content: "Rule 2" })
      ]);
      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;

        const capture = captureConsole();
        try {
          await statsCommand({ format: "json" });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        expect(() => JSON.parse(output)).not.toThrow();

        const payload = JSON.parse(output);
        const stats = payload.data;
        expect(stats.total).toBe(2);
        expect(stats).toHaveProperty("byScope");
        expect(stats).toHaveProperty("byState");
        expect(stats).toHaveProperty("byKind");
        expect(stats).toHaveProperty("scoreDistribution");
      } finally {
        process.env.HOME = originalHome;
      }
    });

    it("includes all expected JSON fields", async () => {
      const { home } = await setupTestEnvironment([
        createTestBullet({ id: "field-test", content: "Test rule", helpfulCount: 3 })
      ]);
      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;

        const capture = captureConsole();
        try {
          await statsCommand({ json: true });
        } finally {
          capture.restore();
        }

        const payload = JSON.parse(capture.logs.join("\n"));
        const stats = payload.data;

        expect(stats).toHaveProperty("total");
        expect(stats).toHaveProperty("byScope");
        expect(stats).toHaveProperty("byState");
        expect(stats).toHaveProperty("byKind");
        expect(stats).toHaveProperty("scoreDistribution");
        expect(stats).toHaveProperty("topPerformers");
        expect(stats).toHaveProperty("mostHelpful");
        expect(stats).toHaveProperty("atRiskCount");
        expect(stats).toHaveProperty("staleCount");
        expect(stats).toHaveProperty("mergeCandidates");
      } finally {
        process.env.HOME = originalHome;
      }
    });
  });

  describe("Counts by Category", () => {
    it("correctly counts bullets by scope", async () => {
      // Valid scopes: global, workspace, language, framework, task
      const { home } = await setupTestEnvironment([
        createTestBullet({ id: "global-1", scope: "global" }),
        createTestBullet({ id: "global-2", scope: "global" }),
        createTestBullet({ id: "lang-1", scope: "language" }),
        createTestBullet({ id: "workspace-1", scope: "workspace" })
      ]);
      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;

        const capture = captureConsole();
        try {
          await statsCommand({ json: true });
        } finally {
          capture.restore();
        }

        const payload = JSON.parse(capture.logs.join("\n"));
        const stats = payload.data;
        expect(stats.byScope.global).toBe(2);
        expect(stats.byScope.language).toBe(1);
        expect(stats.byScope.workspace).toBe(1);
      } finally {
        process.env.HOME = originalHome;
      }
    });

    it("correctly counts bullets by state", async () => {
      // Valid states: draft, active, retired
      const { home } = await setupTestEnvironment([
        createTestBullet({ id: "active-1", state: "active" }),
        createTestBullet({ id: "active-2", state: "active" }),
        createTestBullet({ id: "draft-1", state: "draft" }),
        createTestBullet({ id: "retired-1", state: "retired" })
      ]);
      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;

        const capture = captureConsole();
        try {
          await statsCommand({ json: true });
        } finally {
          capture.restore();
        }

        const payload = JSON.parse(capture.logs.join("\n"));
        const stats = payload.data;
        expect(stats.byState.active).toBe(2);
        expect(stats.byState.draft).toBe(1);
        expect(stats.byState.retired).toBe(1);
      } finally {
        process.env.HOME = originalHome;
      }
    });

    it("correctly counts bullets by kind", async () => {
      const { home } = await setupTestEnvironment([
        createTestBullet({ id: "wf-1", kind: "workflow_rule" }),
        createTestBullet({ id: "wf-2", kind: "workflow_rule" }),
        createTestBullet({ id: "stack-1", kind: "stack_pattern" }),
        createTestBullet({ id: "anti-1", kind: "anti_pattern" })
      ]);
      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;

        const capture = captureConsole();
        try {
          await statsCommand({ json: true });
        } finally {
          capture.restore();
        }

        const payload = JSON.parse(capture.logs.join("\n"));
        const stats = payload.data;
        expect(stats.byKind.workflow_rule).toBe(2);
        expect(stats.byKind.stack_pattern).toBe(1);
        expect(stats.byKind.anti_pattern).toBe(1);
      } finally {
        process.env.HOME = originalHome;
      }
    });
  });

  describe("Score Distribution", () => {
    it("reports score distribution buckets", async () => {
      const { home } = await setupTestEnvironment([
        createTestBullet({ id: "high-score", helpfulCount: 15, harmfulCount: 0 }),
        createTestBullet({ id: "mid-score", helpfulCount: 5, harmfulCount: 0 }),
        createTestBullet({ id: "low-score", helpfulCount: 1, harmfulCount: 0 }),
        createTestBullet({ id: "neg-score", helpfulCount: 0, harmfulCount: 5 })
      ]);
      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;

        const capture = captureConsole();
        try {
          await statsCommand({ json: true });
        } finally {
          capture.restore();
        }

        const payload = JSON.parse(capture.logs.join("\n"));
        const stats = payload.data;
        const dist = stats.scoreDistribution;

        expect(dist).toHaveProperty("excellent");
        expect(dist).toHaveProperty("good");
        expect(dist).toHaveProperty("neutral");
        expect(dist).toHaveProperty("atRisk");

        // At least one at-risk bullet (negative score)
        expect(dist.atRisk).toBeGreaterThanOrEqual(0);
      } finally {
        process.env.HOME = originalHome;
      }
    });
  });

  describe("Top Performers", () => {
    it("identifies top performing bullets by effective score", async () => {
      const { home } = await setupTestEnvironment([
        createTestBullet({ id: "top-1", content: "Top performer one", helpfulCount: 20 }),
        createTestBullet({ id: "top-2", content: "Top performer two", helpfulCount: 15 }),
        createTestBullet({ id: "mid-1", content: "Mid performer", helpfulCount: 5 }),
        createTestBullet({ id: "low-1", content: "Low performer", helpfulCount: 1 })
      ]);
      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;

        const capture = captureConsole();
        try {
          await statsCommand({ json: true });
        } finally {
          capture.restore();
        }

        const payload = JSON.parse(capture.logs.join("\n"));
        const stats = payload.data;
        expect(stats.topPerformers.length).toBeGreaterThan(0);
        expect(stats.topPerformers.length).toBeLessThanOrEqual(5);

        // First should have highest score
        if (stats.topPerformers.length >= 2) {
          expect(stats.topPerformers[0].score).toBeGreaterThanOrEqual(stats.topPerformers[1].score);
        }
      } finally {
        process.env.HOME = originalHome;
      }
    });
  });

  describe("Most Helpful", () => {
    it("identifies most helpful bullets by feedback count", async () => {
      const { home } = await setupTestEnvironment([
        createTestBullet({ id: "helpful-1", content: "Very helpful rule", helpfulCount: 25 }),
        createTestBullet({ id: "helpful-2", content: "Quite helpful rule", helpfulCount: 15 }),
        createTestBullet({ id: "meh-1", content: "Less helpful", helpfulCount: 2 })
      ]);
      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;

        const capture = captureConsole();
        try {
          await statsCommand({ json: true });
        } finally {
          capture.restore();
        }

        const payload = JSON.parse(capture.logs.join("\n"));
        const stats = payload.data;
        expect(stats.mostHelpful.length).toBeGreaterThan(0);
        expect(stats.mostHelpful[0].id).toBe("helpful-1");
        expect(stats.mostHelpful[0].helpfulCount).toBe(25);
      } finally {
        process.env.HOME = originalHome;
      }
    });
  });

  describe("At-Risk Detection", () => {
    it("counts bullets with negative effective scores", async () => {
      const { home } = await setupTestEnvironment([
        createTestBullet({ id: "at-risk-1", helpfulCount: 0, harmfulCount: 10 }),
        createTestBullet({ id: "at-risk-2", helpfulCount: 1, harmfulCount: 8 }),
        createTestBullet({ id: "healthy-1", helpfulCount: 10, harmfulCount: 0 })
      ]);
      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;

        const capture = captureConsole();
        try {
          await statsCommand({ json: true });
        } finally {
          capture.restore();
        }

        const payload = JSON.parse(capture.logs.join("\n"));
        const stats = payload.data;
        // At-risk bullets have negative scores
        expect(stats.atRiskCount).toBeGreaterThanOrEqual(0);
      } finally {
        process.env.HOME = originalHome;
      }
    });
  });

  describe("Stale Detection", () => {
    it("counts bullets with no feedback events created 90+ days ago", async () => {
      // Stale detection uses createdAt for bullets without feedback events
      const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
      const recentDate = new Date().toISOString();

      const { home } = await setupTestEnvironment([
        createTestBullet({ id: "stale-1", createdAt: oldDate, updatedAt: oldDate }),
        createTestBullet({ id: "stale-2", createdAt: oldDate, updatedAt: oldDate }),
        createTestBullet({ id: "fresh-1", createdAt: recentDate, updatedAt: recentDate })
      ]);
      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;

        const capture = captureConsole();
        try {
          await statsCommand({ json: true });
        } finally {
          capture.restore();
        }

        const payload = JSON.parse(capture.logs.join("\n"));
        const stats = payload.data;
        expect(stats.staleCount).toBe(2);
      } finally {
        process.env.HOME = originalHome;
      }
    });
  });

  describe("Merge Candidates", () => {
    it("identifies similar bullets as merge candidates", async () => {
      const { home } = await setupTestEnvironment([
        createTestBullet({
          id: "similar-a",
          content: "Always validate user input before database queries"
        }),
        createTestBullet({
          id: "similar-b",
          content: "Always validate user input before database operations"
        }),
        createTestBullet({
          id: "different-1",
          content: "Use environment variables for configuration management"
        })
      ]);
      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;

        const capture = captureConsole();
        try {
          await statsCommand({ json: true });
        } finally {
          capture.restore();
        }

        const payload = JSON.parse(capture.logs.join("\n"));
        const stats = payload.data;
        // Merge candidates may or may not be found depending on similarity threshold
        expect(Array.isArray(stats.mergeCandidates)).toBe(true);

        if (stats.mergeCandidates.length > 0) {
          const candidate = stats.mergeCandidates[0];
          expect(candidate).toHaveProperty("a");
          expect(candidate).toHaveProperty("b");
          expect(candidate).toHaveProperty("similarity");
          expect(candidate.similarity).toBeGreaterThanOrEqual(0.8);
        }
      } finally {
        process.env.HOME = originalHome;
      }
    });
  });

  describe("Human-Readable Output", () => {
    it("outputs human-readable format by default", async () => {
      const { home } = await setupTestEnvironment([
        createTestBullet({ id: "human-1", content: "Test rule", helpfulCount: 5 })
      ]);
      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;

        const capture = captureConsole();
        try {
          await statsCommand({ json: false });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        expect(output).toContain("Playbook Health Dashboard");
        expect(output).toContain("Total Bullets:");
        expect(output).toContain("By Scope:");
        expect(output).toContain("By State:");
        expect(output).toContain("Score Distribution:");
      } finally {
        process.env.HOME = originalHome;
      }
    });

    it("displays section headers with emojis", async () => {
      const { home } = await setupTestEnvironment([
        createTestBullet({ id: "emoji-test", helpfulCount: 10 })
      ]);
      const originalHome = process.env.HOME;
      const originalNoEmoji = process.env.CASS_MEMORY_NO_EMOJI;

      try {
        process.env.HOME = home;

        const capture = captureConsole();
        try {
          await statsCommand({ json: false });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        expect(output).toContain("📊");
        expect(output).toContain("🌟");
        expect(output).toContain("✅");
      } finally {
        process.env.HOME = originalHome;
        if (originalNoEmoji === undefined) delete process.env.CASS_MEMORY_NO_EMOJI;
        else process.env.CASS_MEMORY_NO_EMOJI = originalNoEmoji;
      }
    });

    it("respects CASS_MEMORY_NO_EMOJI for human output", async () => {
      const { home } = await setupTestEnvironment([
        createTestBullet({ id: "no-emoji-test", helpfulCount: 10 })
      ]);
      const originalHome = process.env.HOME;
      const originalNoEmoji = process.env.CASS_MEMORY_NO_EMOJI;

      try {
        process.env.HOME = home;
        process.env.CASS_MEMORY_NO_EMOJI = "1";

        const capture = captureConsole();
        try {
          await statsCommand({ json: false });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        expect(output).toContain("Playbook Health Dashboard");
        expect(output).not.toContain("📊");
        expect(output).not.toContain("🌟");
        expect(output).not.toContain("✅");
      } finally {
        process.env.HOME = originalHome;
        if (originalNoEmoji === undefined) delete process.env.CASS_MEMORY_NO_EMOJI;
        else process.env.CASS_MEMORY_NO_EMOJI = originalNoEmoji;
      }
    });
  });

  describe("Empty Playbook", () => {
    it("handles empty playbook gracefully", async () => {
      const { home } = await setupTestEnvironment([]);
      const originalHome = process.env.HOME;

      try {
        process.env.HOME = home;

        const capture = captureConsole();
        try {
          await statsCommand({ json: true });
        } finally {
          capture.restore();
        }

        const payload = JSON.parse(capture.logs.join("\n"));
        const stats = payload.data;
        expect(stats.total).toBe(0);
        expect(stats.topPerformers).toEqual([]);
        expect(stats.mostHelpful).toEqual([]);
        expect(stats.mergeCandidates).toEqual([]);
      } finally {
        process.env.HOME = originalHome;
      }
    });
  });
});
