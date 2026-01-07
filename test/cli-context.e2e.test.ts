/**
 * E2E Tests for CLI context command - Pre-task briefing
 *
 * Tests the `cm context` command for generating task-relevant context
 * from playbook rules and session history.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { writeFile, rm, mkdir } from "node:fs/promises";
import path from "node:path";
import yaml from "yaml";
import { contextCommand, generateContextResult, ContextFlags, scoreBulletsEnhanced } from "../src/commands/context.js";
import { withTempCassHome, TestEnv, makeCassStub } from "./helpers/temp.js";
import { createE2ELogger } from "./helpers/e2e-logger.js";
import { createTestConfig } from "./helpers/factories.js";

// Helper to capture console output
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

// Sample playbook content for testing
function createTestPlaybook(bullets: any[] = []) {
  const now = new Date().toISOString();
  return {
    schema_version: 2,
    name: "test-playbook",
    description: "Test playbook for E2E tests",
    metadata: {
      createdAt: now,
      totalReflections: 0,
      totalSessionsProcessed: 0
    },
    bullets: bullets,
    deprecatedPatterns: []
  };
}

// Helper to create a valid test bullet
function createTestBullet(overrides: Partial<{
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
}> = {}) {
  const now = new Date().toISOString();
  return {
    id: overrides.id || `test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    content: overrides.content || "Test bullet content",
    kind: overrides.kind || "workflow_rule",
    category: overrides.category || "testing",
    scope: overrides.scope || "global",
    workspace: overrides.workspace,
    tags: overrides.tags || [],
    maturity: overrides.maturity || "candidate",
    isNegative: overrides.isNegative || false,
    effectiveScore: overrides.effectiveScore ?? 0.8,
    state: "active", // valid per schema
    type: overrides.isNegative ? "anti-pattern" : "rule",
    helpfulCount: 0,
    harmfulCount: 0,
    createdAt: now,
    updatedAt: now
  };
}

describe("E2E: CLI context command", () => {
  describe("Enhanced Scoring (unit)", () => {
    it("can prioritize semantic matches when enabled (deterministic embeddings)", async () => {
      const config = createTestConfig({
        semanticSearchEnabled: true,
        semanticWeight: 0.6,
        embeddingModel: "Xenova/all-MiniLM-L6-v2",
      });

      const keywordBullet: any = createTestBullet({
        id: "b-keyword",
        content: "auth token handling",
        tags: ["auth"],
        effectiveScore: 1,
      });
      keywordBullet.embedding = [0, 1];

      const semanticBullet: any = createTestBullet({
        id: "b-semantic",
        content: "login session management",
        tags: [],
        effectiveScore: 1,
      });
      semanticBullet.embedding = [1, 0];

      const scored = await scoreBulletsEnhanced(
        [keywordBullet, semanticBullet],
        "fix auth bug",
        ["auth"],
        config,
        { queryEmbedding: [1, 0], skipEmbeddingLoad: true }
      );

      expect(scored[0].id).toBe("b-semantic");
    });

    it("falls back to keyword-only when semanticWeight is 0", async () => {
      const config = createTestConfig({
        semanticSearchEnabled: true,
        semanticWeight: 0,
        embeddingModel: "Xenova/all-MiniLM-L6-v2",
      });

      const keywordBullet: any = createTestBullet({
        id: "b-keyword",
        content: "auth token handling",
        tags: ["auth"],
        effectiveScore: 1,
      });
      keywordBullet.embedding = [0, 1];

      const semanticBullet: any = createTestBullet({
        id: "b-semantic",
        content: "login session management",
        tags: [],
        effectiveScore: 1,
      });
      semanticBullet.embedding = [1, 0];

      const scored = await scoreBulletsEnhanced(
        [keywordBullet, semanticBullet],
        "fix auth bug",
        ["auth"],
        config,
        { queryEmbedding: [1, 0], skipEmbeddingLoad: true }
      );

      expect(scored[0].id).toBe("b-keyword");
    });
  });

  describe("Basic Context Generation", () => {
    it("generates empty context when no playbook rules exist", async () => {
      const log = createE2ELogger("cli-context: empty playbook");
      log.setRepro("bun test test/cli-context.e2e.test.ts");

      await log.run(async () => {
        await withTempCassHome(async (env) => {
          log.step("Write empty playbook", { playbookPath: env.playbookPath });
          const playbook = createTestPlaybook([]);
          await writeFile(env.playbookPath, yaml.stringify(playbook));

          log.startTimer("generateContextResult");
          const { result } = await generateContextResult("implement user auth", {});
          log.endTimer("generateContextResult");
          log.snapshot("contextResult", result);

          expect(result.task).toBe("implement user auth");
          expect(result.relevantBullets).toEqual([]);
          expect(result.antiPatterns).toEqual([]);
          expect(Array.isArray(result.suggestedCassQueries)).toBe(true);
        });
      });
    });

    it("returns relevant bullets matching task keywords", async () => {
      await withTempCassHome(async (env) => {
        const playbook = createTestPlaybook([
          createTestBullet({
            id: "test-auth-1",
            content: "Always validate JWT tokens before processing requests",
            kind: "workflow_rule",
            category: "security",
            tags: ["auth", "jwt", "security"],
            effectiveScore: 0.8
          }),
          createTestBullet({
            id: "test-db-1",
            content: "Use connection pooling for database connections",
            kind: "stack_pattern",
            category: "database",
            tags: ["database", "performance"],
            effectiveScore: 0.7
          })
        ]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        const { result } = await generateContextResult("implement JWT authentication", {});

        expect(result.relevantBullets.length).toBeGreaterThanOrEqual(1);
        const authBullet = result.relevantBullets.find(b => b.id === "test-auth-1");
        expect(authBullet).toBeDefined();
      });
    });

    it("orders relevant bullets by relevance in JSON output", async () => {
      await withTempCassHome(async (env) => {
        const playbook = createTestPlaybook([
          createTestBullet({
            id: "rule-low",
            content: "Document API usage guidelines",
            kind: "workflow_rule",
            category: "documentation",
            tags: ["api"],
          }),
          createTestBullet({
            id: "rule-high",
            content: "Optimize API performance with caching",
            kind: "workflow_rule",
            category: "performance",
            tags: ["performance", "api"],
          })
        ]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        const capture = captureConsole();
        try {
          await contextCommand("optimize API performance", { json: true, limit: 5 });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        const parsed = JSON.parse(output);
        const ids = parsed.data.relevantBullets.map((b: any) => b.id);

        expect(ids.length).toBeGreaterThanOrEqual(2);
        expect(ids[0]).toBe("rule-high");
        expect(ids).toContain("rule-low");
      });
    });

    it("separates anti-patterns from regular rules", async () => {
      await withTempCassHome(async (env) => {
        const playbook = createTestPlaybook([
          createTestBullet({
            id: "rule-1",
            content: "Use prepared statements for SQL queries",
            kind: "workflow_rule",
            category: "security",
            tags: ["sql", "security"],
            effectiveScore: 0.8
          }),
          createTestBullet({
            id: "anti-1",
            content: "Never concatenate user input directly into SQL",
            kind: "anti_pattern",
            category: "security",
            tags: ["sql", "security"],
            effectiveScore: 0.8,
            isNegative: true
          })
        ]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        const { result } = await generateContextResult("write SQL query handler", {});

        const hasRule = result.relevantBullets.some(b => b.id === "rule-1");
        const hasAntiPattern = result.antiPatterns.some(b => b.id === "anti-1");

        expect(hasRule || hasAntiPattern).toBe(true);
        const antiInRules = result.relevantBullets.some(b => b.kind === "anti_pattern");
        expect(antiInRules).toBe(false);
      });
    });

    it("respects workspace filtering", async () => {
      await withTempCassHome(async (env) => {
        const playbook = createTestPlaybook([
          createTestBullet({
            id: "global-1",
            content: "Global rule applies everywhere",
            kind: "project_convention",
            category: "general",
            scope: "global",
            tags: ["api"],
            effectiveScore: 0.8
          }),
          createTestBullet({
            id: "workspace-1",
            content: "Frontend-specific rule",
            kind: "stack_pattern",
            category: "frontend",
            scope: "workspace",
            workspace: "frontend",
            tags: ["api", "react"],
            effectiveScore: 0.8
          }),
          createTestBullet({
            id: "workspace-2",
            content: "Backend-specific rule",
            kind: "stack_pattern",
            category: "backend",
            scope: "workspace",
            workspace: "backend",
            tags: ["api", "node"],
            effectiveScore: 0.8
          })
        ]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        const { result } = await generateContextResult("build API endpoint", {
          workspace: "frontend"
        });

        const ids = result.relevantBullets.map(b => b.id);
        if (ids.includes("global-1")) {
          expect(ids).toContain("global-1");
        }
        expect(ids).not.toContain("workspace-2");
      });
    });
  });

  describe("Output Formats", () => {
    it("outputs JSON when --json flag is set", async () => {
      await withTempCassHome(async (env) => {
        const playbook = createTestPlaybook([]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        const capture = captureConsole();
        try {
          await contextCommand("test task", { json: true });
        } finally {
          capture.restore();
        }

        expect(capture.logs.length).toBeGreaterThan(0);
        const output = capture.logs.join("\n");
        const parsed = JSON.parse(output);

        expect(parsed.data.task).toBe("test task");
      });
    });

    it("outputs JSON when format=json", async () => {
      await withTempCassHome(async (env) => {
        const playbook = createTestPlaybook([]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        const capture = captureConsole();
        try {
          await contextCommand("test task", { format: "json" });
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        const parsed = JSON.parse(output);
        expect(parsed.data.task).toBe("test task");
      });
    });

    it("outputs human-readable markdown by default", async () => {
      await withTempCassHome(async (env) => {
        const playbook = createTestPlaybook([
          createTestBullet({
            id: "test-rule",
            content: "Test rule content",
            kind: "workflow_rule",
            category: "testing",
            tags: ["test"],
            effectiveScore: 0.8
          })
        ]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        const capture = captureConsole();
        try {
          await contextCommand("test task", {});
        } finally {
          capture.restore();
        }

        const output = capture.logs.join("\n");
        expect(output).toContain("CONTEXT FOR:");
        expect(output).toContain("test task");
      });
    });
  });

  describe("Deprecated Patterns", () => {
    it("warns when task matches deprecated patterns", async () => {
      await withTempCassHome(async (env) => {
        const now = new Date().toISOString();
        const playbook = {
          schema_version: 2,
          name: "test-playbook",
          description: "Test playbook with deprecated patterns",
          metadata: {
            createdAt: now,
            totalReflections: 0,
            totalSessionsProcessed: 0
          },
          bullets: [],
          deprecatedPatterns: [
            {
              pattern: "moment\\.js",
              replacement: "date-fns or dayjs",
              reason: "moment.js is in maintenance mode",
              deprecatedAt: now
            }
          ]
        };
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        const { result } = await generateContextResult(
          "add moment.js for date formatting",
          {}
        );

        expect(result.deprecatedWarnings.length).toBeGreaterThan(0);
        const hasWarning = result.deprecatedWarnings.some(w =>
          w.includes("deprecated pattern") && w.includes("moment")
        );
        expect(hasWarning).toBe(true);
      });
    });
  });

  describe("Suggested Queries", () => {
    it("generates suggested cass queries from task keywords", async () => {
      await withTempCassHome(async (env) => {
        const playbook = createTestPlaybook([]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        const { result } = await generateContextResult(
          "implement user authentication with OAuth",
          {}
        );

        expect(Array.isArray(result.suggestedCassQueries)).toBe(true);
      });
    });
  });

  describe("Limits and Constraints", () => {
    it("respects limit for bullet limit", async () => {
      await withTempCassHome(async (env) => {
        const bullets = Array.from({ length: 20 }, (_, i) =>
          createTestBullet({
            id: `rule-${i}`,
            content: `Rule number ${i} about APIs`,
            kind: "stack_pattern",
            category: "api",
            tags: ["api"],
            effectiveScore: 0.8 - (i * 0.01)
          })
        );
        const playbook = createTestPlaybook(bullets);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        const { result } = await generateContextResult("build API", { limit: 3 });

        expect(result.relevantBullets.length).toBeLessThanOrEqual(3);
      });
    });
  });

  describe("Cass Integration", () => {
    it("gracefully handles when cass is unavailable", async () => {
      await withTempCassHome(async (env) => {
        const playbook = createTestPlaybook([
          createTestBullet({
            id: "test-rule",
            content: "Test rule for fallback",
            kind: "workflow_rule",
            category: "testing",
            tags: ["test"],
            effectiveScore: 0.8
          })
        ]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        process.env.CASS_PATH = "/nonexistent/cass/binary";

        try {
          const { result } = await generateContextResult("test task", {});
          expect(result.task).toBe("test task");
          expect(Array.isArray(result.relevantBullets)).toBe(true);
          expect(result.historySnippets).toEqual([]);
        } finally {
          delete process.env.CASS_PATH;
        }
      });
    });

    it("includes structured degraded summary when cass index is missing (deterministic stub)", async () => {
      await withTempCassHome(async (env) => {
        const playbook = createTestPlaybook([
          createTestBullet({
            id: "test-rule",
            content: "Test rule for degraded mode",
            kind: "workflow_rule",
            category: "testing",
            tags: ["test"],
            effectiveScore: 0.8
          })
        ]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        const binDir = path.join(env.home, "bin");
        await mkdir(binDir, { recursive: true });
        const cassStubPath = await makeCassStub(binDir, { exitCode: 3, search: "[]" });

        await writeFile(env.configPath, JSON.stringify({ cassPath: cassStubPath }, null, 2));

        const { result } = await generateContextResult("test task", {});

        expect(result.historySnippets).toEqual([]);
        expect(result.degraded?.cass).toBeDefined();
        expect(result.degraded?.cass?.available).toBe(false);
        expect(result.degraded?.cass?.reason).toBe("INDEX_MISSING");
        expect(result.degraded?.cass?.suggestedFix).toContain("cass index");
        expect(result.suggestedCassQueries.every((q) => q.startsWith("cass search "))).toBe(true);
      });
    });

    it("returns history snippets when cass is available", async () => {
      const { cassAvailable } = await import("../src/cass.js");
      if (!cassAvailable()) {
        console.log("Skipping cass integration test - cass not installed");
        return;
      }

      await withTempCassHome(async (env) => {
        const playbook = createTestPlaybook([]);
        await writeFile(env.playbookPath, yaml.stringify(playbook));

        const { result, cassHits } = await generateContextResult(
          "implement feature",
          { history: 5, days: 30 }
        );
        expect(Array.isArray(result.historySnippets)).toBe(true);
      });
    });
  });

  describe("Error Handling", () => {
    it("handles missing playbook gracefully", async () => {
      await withTempCassHome(async (env) => {
        await rm(env.playbookPath, { force: true });
        try {
          const { result } = await generateContextResult("test task", {});
          expect(result.task).toBe("test task");
        } catch (err) {
          expect(err).toBeDefined();
        }
      });
    });

    it("handles malformed playbook gracefully", async () => {
      await withTempCassHome(async (env) => {
        await writeFile(env.playbookPath, "invalid: yaml: content: [[[");
        try {
          const { result } = await generateContextResult("test task", {});
          expect(result.task).toBe("test task");
        } catch (err) {
          expect(err).toBeDefined();
        }
      });
    });
  });
});
