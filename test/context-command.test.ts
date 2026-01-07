/**
 * Tests for the context command input validation and helper functions
 *
 * Tests:
 * - Input validation for task, limit, top, history, days, format, workspace, session
 * - buildContextResult function
 * - contextWithoutCass function
 * - Error handling paths
 */
import { describe, test, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import yaml from "yaml";
import {
  contextCommand,
  buildContextResult,
  contextWithoutCass,
  generateContextResult,
} from "../src/commands/context.js";
import { withTempCassHome } from "./helpers/temp.js";
import { withTempGitRepo } from "./helpers/git.js";
import { createTestPlaybook, createTestBullet, createTestConfig } from "./helpers/factories.js";

/**
 * Capture console output during async function execution.
 */
function captureConsole() {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;

  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };

  return {
    logs,
    errors,
    restore: () => {
      console.log = originalLog;
      console.error = originalError;
    },
    getOutput: () => logs.join("\n"),
    getErrors: () => errors.join("\n"),
  };
}

describe("contextCommand input validation", () => {
  test("rejects empty task", async () => {
    await withTempCassHome(async (env) => {
      writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])));

      const capture = captureConsole();
      try {
        await contextCommand("", { json: true });
        const output = capture.getOutput();
        expect(output).toContain("error");
        expect(output).toContain("task");
      } finally {
        capture.restore();
      }
    });
  });

  test("rejects whitespace-only task", async () => {
    await withTempCassHome(async (env) => {
      writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])));

      const capture = captureConsole();
      try {
        await contextCommand("   ", { json: true });
        const output = capture.getOutput();
        expect(output).toContain("error");
        expect(output).toContain("task");
      } finally {
        capture.restore();
      }
    });
  });

  test("rejects invalid limit (negative)", async () => {
    await withTempCassHome(async (env) => {
      writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])));

      const capture = captureConsole();
      try {
        await contextCommand("fix bug", { limit: -5, json: true });
        const output = capture.getOutput();
        expect(output).toContain("error");
        expect(output).toContain("limit");
      } finally {
        capture.restore();
      }
    });
  });

  test("rejects invalid limit (zero)", async () => {
    await withTempCassHome(async (env) => {
      writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])));

      const capture = captureConsole();
      try {
        await contextCommand("fix bug", { limit: 0, json: true });
        const output = capture.getOutput();
        expect(output).toContain("error");
        expect(output).toContain("limit");
      } finally {
        capture.restore();
      }
    });
  });

  test("rejects invalid top (negative)", async () => {
    await withTempCassHome(async (env) => {
      writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])));

      const capture = captureConsole();
      try {
        await contextCommand("fix bug", { top: -3, json: true });
        const output = capture.getOutput();
        expect(output).toContain("error");
        expect(output).toContain("top");
      } finally {
        capture.restore();
      }
    });
  });

  test("rejects invalid history (negative)", async () => {
    await withTempCassHome(async (env) => {
      writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])));

      const capture = captureConsole();
      try {
        await contextCommand("fix bug", { history: -10, json: true });
        const output = capture.getOutput();
        expect(output).toContain("error");
        expect(output).toContain("history");
      } finally {
        capture.restore();
      }
    });
  });

  test("rejects invalid days (negative)", async () => {
    await withTempCassHome(async (env) => {
      writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])));

      const capture = captureConsole();
      try {
        await contextCommand("fix bug", { days: -7, json: true });
        const output = capture.getOutput();
        expect(output).toContain("error");
        expect(output).toContain("days");
      } finally {
        capture.restore();
      }
    });
  });

  test("rejects invalid days (zero)", async () => {
    await withTempCassHome(async (env) => {
      writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])));

      const capture = captureConsole();
      try {
        await contextCommand("fix bug", { days: 0, json: true });
        const output = capture.getOutput();
        expect(output).toContain("error");
        expect(output).toContain("days");
      } finally {
        capture.restore();
      }
    });
  });

  test("rejects invalid format value", async () => {
    await withTempCassHome(async (env) => {
      writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])));

      const capture = captureConsole();
      try {
        // Don't use json: true so the format validation is triggered
        await contextCommand("fix bug", { format: "xml" as any });
        const output = capture.getOutput();
        const errors = capture.getErrors();
        // Error could be in stdout or stderr
        const combined = output + errors;
        expect(combined.toLowerCase()).toContain("format");
      } finally {
        capture.restore();
      }
    });
  });

  test("rejects empty workspace string", async () => {
    await withTempCassHome(async (env) => {
      writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])));

      const capture = captureConsole();
      try {
        await contextCommand("fix bug", { workspace: "", json: true });
        const output = capture.getOutput();
        expect(output).toContain("error");
        expect(output).toContain("workspace");
      } finally {
        capture.restore();
      }
    });
  });

  test("rejects empty session string", async () => {
    await withTempCassHome(async (env) => {
      writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])));

      const capture = captureConsole();
      try {
        await contextCommand("fix bug", { session: "", json: true });
        const output = capture.getOutput();
        expect(output).toContain("error");
        expect(output).toContain("session");
      } finally {
        capture.restore();
      }
    });
  });

  test("accepts valid inputs and returns success", async () => {
    await withTempCassHome(async (env) => {
      const bullets = [
        createTestBullet({ id: "b-auth", content: "Use JWT for authentication", tags: ["auth"] }),
      ];
      writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook(bullets)));

      const capture = captureConsole();
      try {
        await contextCommand("implement auth", { json: true, limit: 5, days: 30 });
        const output = capture.getOutput();
        const result = JSON.parse(output);

        expect(result.success).toBe(true);
        expect(result.data.task).toBe("implement auth");
      } finally {
        capture.restore();
      }
    });
  });

  test("accepts format=markdown", async () => {
    await withTempCassHome(async (env) => {
      writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])));

      const capture = captureConsole();
      try {
        await contextCommand("test task", { format: "markdown" });
        const output = capture.getOutput();

        expect(output).toContain("# Context for:");
        expect(output).toContain("test task");
      } finally {
        capture.restore();
      }
    });
  });

  test("shows deprecation warning for --top when used with --limit", async () => {
    await withTempCassHome(async (env) => {
      writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])));

      const capture = captureConsole();
      try {
        await contextCommand("test task", { limit: 5, top: 3, json: true });
        const errors = capture.getErrors();

        expect(errors).toContain("deprecated");
        expect(errors).toContain("--top");
      } finally {
        capture.restore();
      }
    });
  });
});

describe("buildContextResult", () => {
  test("builds result with rules and anti-patterns", () => {
    const rules = [
      { ...createTestBullet({ id: "r-1" }), relevanceScore: 8, effectiveScore: 0.9, finalScore: 7.2 },
      { ...createTestBullet({ id: "r-2" }), relevanceScore: 6, effectiveScore: 0.8, finalScore: 4.8 },
    ];
    const antiPatterns = [
      { ...createTestBullet({ id: "a-1", isNegative: true }), relevanceScore: 7, effectiveScore: 0.85, finalScore: 5.95 },
    ];
    const history = [
      { source_path: "/test/session.jsonl", line_number: 42, timestamp: new Date().toISOString(), agent: "claude", snippet: "test snippet", score: 0.9 },
    ];
    const warnings = ["Test warning"];
    const suggestedQueries = ["cass search 'test'"];

    const result = buildContextResult("test task", rules as any, antiPatterns as any, history as any, warnings, suggestedQueries, { maxBullets: 10, maxHistory: 10 });

    expect(result.task).toBe("test task");
    expect(result.relevantBullets).toHaveLength(2);
    expect(result.antiPatterns).toHaveLength(1);
    expect(result.historySnippets).toHaveLength(1);
    expect(result.deprecatedWarnings).toEqual(["Test warning"]);
    expect(result.suggestedCassQueries).toEqual(["cass search 'test'"]);
  });

  test("respects maxBullets limit", () => {
    const rules = Array.from({ length: 20 }, (_, i) => ({
      ...createTestBullet({ id: `r-${i}` }),
      relevanceScore: 8 - i * 0.1,
      effectiveScore: 0.9,
      finalScore: (8 - i * 0.1) * 0.9,
    }));

    const result = buildContextResult("test", rules as any, [], [], [], [], { maxBullets: 5, maxHistory: 10 });

    expect(result.relevantBullets).toHaveLength(5);
  });

  test("respects maxHistory limit", () => {
    const history = Array.from({ length: 15 }, (_, i) => ({
      source_path: `/test/session-${i}.jsonl`,
      line_number: i,
      timestamp: new Date().toISOString(),
      agent: "claude",
      snippet: `Snippet ${i}`,
      score: 0.9 - i * 0.01,
    }));

    const result = buildContextResult("test", [], [], history as any, [], [], { maxBullets: 10, maxHistory: 3 });

    expect(result.historySnippets).toHaveLength(3);
  });

  test("truncates long snippets", () => {
    const longSnippet = "A".repeat(500);
    const history = [{
      source_path: "/test/session.jsonl",
      line_number: 1,
      timestamp: new Date().toISOString(),
      agent: "claude",
      snippet: longSnippet,
      score: 0.9,
    }];

    const result = buildContextResult("test", [], [], history as any, [], [], { maxBullets: 10, maxHistory: 10 });

    expect(result.historySnippets[0].snippet.length).toBeLessThan(500);
    // truncateWithIndicator uses "..." as the default indicator
    expect(result.historySnippets[0].snippet).toContain("...");
  });

  test("adds lastHelpful and reasoning to bullets", () => {
    const rules = [{
      ...createTestBullet({ id: "r-1" }),
      relevanceScore: 8,
      effectiveScore: 0.9,
      finalScore: 7.2,
      helpfulEvents: [{ timestamp: new Date().toISOString() }],
    }];

    const result = buildContextResult("test", rules as any, [], [], [], [], { maxBullets: 10, maxHistory: 10 });

    expect(result.relevantBullets[0].lastHelpful).toBeDefined();
    expect(result.relevantBullets[0].reasoning).toBeDefined();
  });

  test("handles empty inputs", () => {
    const result = buildContextResult("test", [], [], [], [], [], { maxBullets: 10, maxHistory: 10 });

    expect(result.task).toBe("test");
    expect(result.relevantBullets).toEqual([]);
    expect(result.antiPatterns).toEqual([]);
    expect(result.historySnippets).toEqual([]);
    expect(result.deprecatedWarnings).toEqual([]);
    expect(result.suggestedCassQueries).toEqual([]);
  });

  test("handles invalid maxBullets (uses default)", () => {
    const rules = Array.from({ length: 15 }, (_, i) => ({
      ...createTestBullet({ id: `r-${i}` }),
      relevanceScore: 8,
      effectiveScore: 0.9,
      finalScore: 7.2,
    }));

    const result = buildContextResult("test", rules as any, [], [], [], [], { maxBullets: -5, maxHistory: 10 });

    // Should use default of 10
    expect(result.relevantBullets).toHaveLength(10);
  });
});

describe("contextWithoutCass", () => {
  test("returns context with playbook-only rules", async () => {
    await withTempCassHome(async (env) => {
      const bullets = [
        createTestBullet({ id: "b-1", content: "Use TypeScript", tags: ["typescript"] }),
        createTestBullet({ id: "b-2", content: "Write tests", tags: ["testing"] }),
      ];
      writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook(bullets)));

      // Use correct playbook path from the temp environment
      const config = createTestConfig({ playbookPath: env.playbookPath });
      const capture = captureConsole();
      try {
        const result = await contextWithoutCass("write unit tests", config);

        expect(result.task).toBe("write unit tests");
        expect(result.historySnippets).toEqual([]);
        expect(result.deprecatedWarnings).toContain("Context generated without historical data (cass unavailable)");
      } finally {
        capture.restore();
      }
    });
  });

  test("respects workspace filter", async () => {
    await withTempCassHome(async (env) => {
      const bullets = [
        createTestBullet({ id: "b-global", content: "Global rule", scope: "global" }),
        createTestBullet({ id: "b-frontend", content: "Frontend rule", scope: "workspace", workspace: "frontend" }),
        createTestBullet({ id: "b-backend", content: "Backend rule", scope: "workspace", workspace: "backend" }),
      ];
      writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook(bullets)));

      // Use correct playbook path from the temp environment
      const config = createTestConfig({ playbookPath: env.playbookPath });
      const capture = captureConsole();
      try {
        const result = await contextWithoutCass("build API", config, { workspace: "frontend" });

        const ids = result.relevantBullets.map((b) => b.id);
        expect(ids).not.toContain("b-backend");
      } finally {
        capture.restore();
      }
    });
  });

  test("respects maxBullets option", async () => {
    await withTempCassHome(async (env) => {
      const bullets = Array.from({ length: 20 }, (_, i) =>
        createTestBullet({ id: `b-${i}`, content: `Rule ${i} about API`, tags: ["api"] })
      );
      writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook(bullets)));

      // Use correct playbook path from the temp environment
      const config = createTestConfig({ playbookPath: env.playbookPath });
      const capture = captureConsole();
      try {
        const result = await contextWithoutCass("build API", config, { maxBullets: 3 });

        expect(result.relevantBullets.length).toBeLessThanOrEqual(3);
      } finally {
        capture.restore();
      }
    });
  });

  test("handles playbook gracefully when validation fails", async () => {
    await withTempCassHome(async (env) => {
      // Write playbook with invalid schema (missing required fields)
      writeFileSync(env.playbookPath, yaml.stringify({ invalid: true }));

      // Use correct playbook path from the temp environment
      const config = createTestConfig({ playbookPath: env.playbookPath });
      const capture = captureConsole();
      try {
        const result = await contextWithoutCass("test task", config);

        // contextWithoutCass catches playbook errors and returns fallback
        expect(result.task).toBe("test task");
        // Should either have empty bullets OR the fallback warning
        expect(Array.isArray(result.relevantBullets)).toBe(true);
        expect(Array.isArray(result.deprecatedWarnings)).toBe(true);
      } finally {
        capture.restore();
      }
    });
  });

  test("includes deprecated pattern warnings", async () => {
    await withTempCassHome(async (env) => {
      const playbook = {
        ...createTestPlaybook([]),
        deprecatedPatterns: [
          { pattern: "moment", replacement: "date-fns", reason: "maintenance mode", deprecatedAt: new Date().toISOString() },
        ],
      };
      writeFileSync(env.playbookPath, yaml.stringify(playbook));

      // Use correct playbook path from the temp environment
      const config = createTestConfig({ playbookPath: env.playbookPath });
      const capture = captureConsole();
      try {
        const result = await contextWithoutCass("add moment.js", config);

        const hasDeprecatedWarning = result.deprecatedWarnings.some((w) =>
          w.includes("deprecated pattern") && w.includes("moment")
        );
        expect(hasDeprecatedWarning).toBe(true);
      } finally {
        capture.restore();
      }
    });
  });
});

describe("contextCommand output modes", () => {
  test("human output mode shows CONTEXT FOR header", async () => {
    await withTempCassHome(async (env) => {
      writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])));

      const capture = captureConsole();
      try {
        await contextCommand("test task", {});
        const output = capture.getOutput();

        expect(output).toContain("CONTEXT FOR:");
        expect(output).toContain("test task");
      } finally {
        capture.restore();
      }
    });
  });

  test("human output mode shows playbook rules section", async () => {
    await withTempCassHome(async (env) => {
      const bullets = [
        createTestBullet({ id: "b-test", content: "Test rule content", tags: ["test"] }),
      ];
      writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook(bullets)));

      const capture = captureConsole();
      try {
        await contextCommand("test task", {});
        const output = capture.getOutput();

        expect(output).toContain("PLAYBOOK RULES");
      } finally {
        capture.restore();
      }
    });
  });

  test("markdown output mode uses markdown headers", async () => {
    await withTempCassHome(async (env) => {
      writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])));

      const capture = captureConsole();
      try {
        await contextCommand("test task", { format: "markdown" });
        const output = capture.getOutput();

        expect(output).toContain("# Context for:");
        expect(output).toContain("## Playbook rules");
      } finally {
        capture.restore();
      }
    });
  });

  test("JSON output includes metadata", async () => {
    await withTempCassHome(async (env) => {
      writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])));

      const capture = captureConsole();
      try {
        await contextCommand("test task", { json: true });
        const output = capture.getOutput();
        const result = JSON.parse(output);

        expect(result.success).toBe(true);
        expect(result.command).toBe("context");
        expect(result.data).toBeDefined();
        expect(result.metadata).toBeDefined();
      } finally {
        capture.restore();
      }
    });
  });
});

describe("safeDeprecatedPatternMatcher via playbook patterns", () => {
  test("matches simple substring pattern (case-insensitive)", async () => {
    await withTempCassHome(async (env) => {
      const playbook = {
        ...createTestPlaybook([]),
        deprecatedPatterns: [
          { pattern: "moment", replacement: "date-fns", reason: "maintenance mode", deprecatedAt: new Date().toISOString() },
        ],
      };
      writeFileSync(env.playbookPath, yaml.stringify(playbook));

      const capture = captureConsole();
      try {
        await contextCommand("add MOMENT.js to handle dates", { json: true });
        const output = capture.getOutput();
        const result = JSON.parse(output);

        expect(result.success).toBe(true);
        const hasDeprecatedWarning = result.data.deprecatedWarnings.some((w: string) =>
          w.includes("deprecated pattern") && w.includes("moment")
        );
        expect(hasDeprecatedWarning).toBe(true);
      } finally {
        capture.restore();
      }
    });
  });

  test("skips excessively long regex pattern (> 256 chars)", async () => {
    await withTempCassHome(async (env) => {
      // Create a regex pattern > 256 chars
      const longPattern = "/" + "a".repeat(300) + "/";
      const playbook = {
        ...createTestPlaybook([]),
        deprecatedPatterns: [
          { pattern: longPattern, replacement: "shorter", reason: "too long", deprecatedAt: new Date().toISOString() },
        ],
      };
      writeFileSync(env.playbookPath, yaml.stringify(playbook));

      const capture = captureConsole();
      try {
        // Pattern should be skipped - no match even if task contains 'a's
        await contextCommand("aaaaaaa task", { json: true });
        const output = capture.getOutput();
        const errors = capture.getErrors();
        const result = JSON.parse(output);

        expect(result.success).toBe(true);
        // Warning about skipping long pattern should appear in stderr
        expect(errors).toContain("Skipped excessively long");
      } finally {
        capture.restore();
      }
    });
  });

  test("skips potentially unsafe ReDoS pattern", async () => {
    await withTempCassHome(async (env) => {
      // ReDoS-prone pattern: nested quantifiers like (a+)+
      const unsafePattern = "/(a+)+$/";
      const playbook = {
        ...createTestPlaybook([]),
        deprecatedPatterns: [
          { pattern: unsafePattern, replacement: "safe", reason: "redos", deprecatedAt: new Date().toISOString() },
        ],
      };
      writeFileSync(env.playbookPath, yaml.stringify(playbook));

      const capture = captureConsole();
      try {
        await contextCommand("test aaaaaaaa task", { json: true });
        const output = capture.getOutput();
        const errors = capture.getErrors();
        const result = JSON.parse(output);

        expect(result.success).toBe(true);
        // Warning about unsafe pattern should appear in stderr
        expect(errors).toContain("Skipped potentially unsafe");
      } finally {
        capture.restore();
      }
    });
  });

  test("handles invalid regex syntax gracefully", async () => {
    await withTempCassHome(async (env) => {
      // Invalid regex - unclosed bracket
      const invalidPattern = "/[abc/";
      const playbook = {
        ...createTestPlaybook([]),
        deprecatedPatterns: [
          { pattern: invalidPattern, replacement: "valid", reason: "bad regex", deprecatedAt: new Date().toISOString() },
        ],
      };
      writeFileSync(env.playbookPath, yaml.stringify(playbook));

      const capture = captureConsole();
      try {
        await contextCommand("test abc task", { json: true });
        const output = capture.getOutput();
        const errors = capture.getErrors();
        const result = JSON.parse(output);

        expect(result.success).toBe(true);
        // Warning about invalid regex should appear in stderr
        expect(errors).toContain("Invalid deprecated pattern regex");
      } finally {
        capture.restore();
      }
    });
  });

  test("matches valid regex pattern", async () => {
    await withTempCassHome(async (env) => {
      // Valid regex pattern
      const validPattern = "/var\\s+\\w+/";
      const playbook = {
        ...createTestPlaybook([]),
        deprecatedPatterns: [
          { pattern: validPattern, replacement: "const/let", reason: "use const or let", deprecatedAt: new Date().toISOString() },
        ],
      };
      writeFileSync(env.playbookPath, yaml.stringify(playbook));

      const capture = captureConsole();
      try {
        await contextCommand("fix var myVariable issue", { json: true });
        const output = capture.getOutput();
        const result = JSON.parse(output);

        expect(result.success).toBe(true);
        const hasDeprecatedWarning = result.data.deprecatedWarnings.some((w: string) =>
          w.includes("deprecated pattern")
        );
        expect(hasDeprecatedWarning).toBe(true);
      } finally {
        capture.restore();
      }
    });
  });
});

describe("scoreBulletsEnhanced", () => {
  test("returns empty array for empty bullets", async () => {
    const { scoreBulletsEnhanced } = await import("../src/commands/context.js");
    const config = createTestConfig({});
    const result = await scoreBulletsEnhanced([], "test task", ["test"], config);
    expect(result).toEqual([]);
  });

  test("scores bullets with keyword-only when semantic disabled", async () => {
    await withTempCassHome(async (env) => {
      const { scoreBulletsEnhanced } = await import("../src/commands/context.js");
      const bullets = [
        createTestBullet({ id: "b-1", content: "Use TypeScript for type safety", tags: ["typescript"] }),
        createTestBullet({ id: "b-2", content: "Write tests before code", tags: ["testing"] }),
      ];
      const config = createTestConfig({
        semanticSearchEnabled: false,
        playbookPath: env.playbookPath,
      });
      writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook(bullets)));

      const result = await scoreBulletsEnhanced(bullets, "typescript types", ["typescript", "types"], config);

      expect(result.length).toBe(2);
      // TypeScript bullet should score higher
      expect(result[0].id).toBe("b-1");
      expect(result[0].relevanceScore).toBeGreaterThan(0);
      expect(result[0].finalScore).toBeGreaterThan(0);
    });
  });

  test("handles semantic embedding error gracefully", async () => {
    await withTempCassHome(async (env) => {
      const { scoreBulletsEnhanced } = await import("../src/commands/context.js");
      const bullets = [
        createTestBullet({ id: "b-1", content: "Test bullet", tags: ["test"] }),
      ];
      // Enable semantic but with invalid model to trigger error
      const config = createTestConfig({
        semanticSearchEnabled: true,
        embeddingModel: "invalid-nonexistent-model",
        playbookPath: env.playbookPath,
      });
      writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook(bullets)));

      const progressEvents: any[] = [];
      const capture = captureConsole();
      try {
        const result = await scoreBulletsEnhanced(bullets, "test query", ["test"], config, {
          json: false,
          onSemanticProgress: (event) => progressEvents.push(event),
        });

        // Should still return scored bullets using keyword-only fallback
        expect(result.length).toBe(1);
        expect(result[0].relevanceScore).toBeGreaterThanOrEqual(0);
      } finally {
        capture.restore();
      }
    });
  });

  test("uses queryEmbedding from options when provided", async () => {
    await withTempCassHome(async (env) => {
      const { scoreBulletsEnhanced } = await import("../src/commands/context.js");
      const bullets = [
        { ...createTestBullet({ id: "b-1", content: "Test bullet" }), embedding: [0.1, 0.2, 0.3] },
      ];
      const config = createTestConfig({
        semanticSearchEnabled: true,
        embeddingModel: "none", // Disable actual embedding but enable semantic scoring
        playbookPath: env.playbookPath,
      });
      writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook(bullets)));

      const capture = captureConsole();
      try {
        // Providing queryEmbedding skips embedText call
        const result = await scoreBulletsEnhanced(bullets as any, "test", ["test"], config, {
          queryEmbedding: [0.1, 0.2, 0.3],
          skipEmbeddingLoad: true,
        });

        expect(result.length).toBe(1);
      } finally {
        capture.restore();
      }
    });
  });
});

describe("generateContextResult", () => {
  test("calls onProgress callback during execution", async () => {
    await withTempCassHome(async (env) => {
      writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])));

      const progressEvents: any[] = [];
      const capture = captureConsole();
      try {
        await generateContextResult("test task", { json: true }, {
          onProgress: (event) => progressEvents.push(event),
        });

        // Should have at least cass_search events
        const cassEvents = progressEvents.filter((e) => e.phase === "cass_search");
        expect(cassEvents.length).toBeGreaterThanOrEqual(1);
      } finally {
        capture.restore();
      }
    });
  });

  test("filters bullets by workspace when provided", async () => {
    await withTempCassHome(async (env) => {
      const bullets = [
        createTestBullet({ id: "b-global", content: "Global API rule", scope: "global" }),
        createTestBullet({ id: "b-frontend", content: "Frontend API rule", scope: "workspace", workspace: "frontend" }),
        createTestBullet({ id: "b-backend", content: "Backend API rule", scope: "workspace", workspace: "backend" }),
      ];
      writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook(bullets)));

      const capture = captureConsole();
      try {
        const { result } = await generateContextResult("build API", { workspace: "frontend" });

        const ids = result.relevantBullets.map((b) => b.id);
        // Global should be included, frontend should be included, backend should be excluded
        expect(ids).not.toContain("b-backend");
      } finally {
        capture.restore();
      }
    });
  });

  test("orders relevant bullets by relevance score", async () => {
    await withTempCassHome(async (env) => {
      const bullets = [
        createTestBullet({
          id: "b-low",
          content: "Document API usage guidelines",
          tags: ["documentation"]
        }),
        createTestBullet({
          id: "b-high",
          content: "Optimize API performance with caching",
          tags: ["performance", "api"]
        }),
      ];
      writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook(bullets)));

      const capture = captureConsole();
      try {
        const { result } = await generateContextResult("optimize API performance", { limit: 5, json: true });
        const ids = result.relevantBullets.map((b) => b.id);

        expect(ids.length).toBeGreaterThanOrEqual(2);
        expect(ids[0]).toBe("b-high");
        expect(ids).toContain("b-low");
      } finally {
        capture.restore();
      }
    });
  });
});

describe("contextCommand markdown output", () => {
  test("markdown output shows rules with scores", async () => {
    await withTempCassHome(async (env) => {
      const bullets = [
        createTestBullet({ id: "b-api", content: "Use REST for API design", category: "api", tags: ["api", "rest"] }),
      ];
      writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook(bullets)));

      const capture = captureConsole();
      try {
        await contextCommand("build REST API", { format: "markdown" });
        const output = capture.getOutput();

        expect(output).toContain("## Playbook rules");
        expect(output).toContain("b-api");
        expect(output).toContain("score");
      } finally {
        capture.restore();
      }
    });
  });

  test("markdown output shows pitfalls section", async () => {
    await withTempCassHome(async (env) => {
      const bullets = [
        createTestBullet({ id: "ap-1", content: "Never use eval for API input", isNegative: true, kind: "anti_pattern", tags: ["api", "security"] }),
      ];
      writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook(bullets)));

      const capture = captureConsole();
      try {
        await contextCommand("handle API input", { format: "markdown" });
        const output = capture.getOutput();

        expect(output).toContain("## Pitfalls");
      } finally {
        capture.restore();
      }
    });
  });

  test("markdown output shows history section placeholder", async () => {
    await withTempCassHome(async (env) => {
      writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])));

      const capture = captureConsole();
      try {
        await contextCommand("test task", { format: "markdown" });
        const output = capture.getOutput();

        expect(output).toContain("## History");
      } finally {
        capture.restore();
      }
    });
  });

  test("markdown output shows empty state for no rules", async () => {
    await withTempCassHome(async (env) => {
      writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])));

      const capture = captureConsole();
      try {
        await contextCommand("random obscure task xyz123", { format: "markdown" });
        const output = capture.getOutput();

        expect(output).toContain("No relevant playbook rules found");
      } finally {
        capture.restore();
      }
    });
  });

  test("markdown output shows warnings when present", async () => {
    await withTempCassHome(async (env) => {
      const playbook = {
        ...createTestPlaybook([]),
        deprecatedPatterns: [
          { pattern: "legacy", replacement: "modern", reason: "outdated", deprecatedAt: new Date().toISOString() },
        ],
      };
      writeFileSync(env.playbookPath, yaml.stringify(playbook));

      const capture = captureConsole();
      try {
        await contextCommand("fix legacy code", { format: "markdown" });
        const output = capture.getOutput();

        expect(output).toContain("## Warnings");
        expect(output).toContain("legacy");
      } finally {
        capture.restore();
      }
    });
  });

  test("markdown output shows suggested searches", async () => {
    await withTempCassHome(async (env) => {
      writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])));

      const capture = captureConsole();
      try {
        await contextCommand("fix authentication bug", { format: "markdown" });
        const output = capture.getOutput();

        expect(output).toContain("## Suggested searches");
      } finally {
        capture.restore();
      }
    });
  });
});

describe("contextCommand human output", () => {
  test("human output shows PLAYBOOK RULES section with bullets", async () => {
    await withTempCassHome(async (env) => {
      const bullets = [
        createTestBullet({ id: "b-test", content: "Test rule for human output", category: "testing", tags: ["test"] }),
      ];
      writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook(bullets)));

      const capture = captureConsole();
      try {
        await contextCommand("test code", {});
        const output = capture.getOutput();

        expect(output).toContain("PLAYBOOK RULES");
        expect(output).toContain("b-test");
        expect(output).toContain("testing");
      } finally {
        capture.restore();
      }
    });
  });

  test("human output shows empty playbook guidance", async () => {
    await withTempCassHome(async (env) => {
      writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])));

      const capture = captureConsole();
      try {
        await contextCommand("random obscure task xyz789", {});
        const output = capture.getOutput();

        expect(output).toContain("PLAYBOOK RULES (0)");
        expect(output).toContain("No relevant playbook rules found");
      } finally {
        capture.restore();
      }
    });
  });

  test("human output shows PITFALLS section for anti-patterns", async () => {
    await withTempCassHome(async (env) => {
      const bullets = [
        createTestBullet({
          id: "ap-sql",
          content: "Never concatenate user input into SQL queries",
          isNegative: true,
          kind: "anti_pattern",
          tags: ["sql", "security"]
        }),
      ];
      writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook(bullets)));

      const capture = captureConsole();
      try {
        await contextCommand("fix SQL query", {});
        const output = capture.getOutput();

        expect(output).toContain("PITFALLS");
        expect(output).toContain("ap-sql");
      } finally {
        capture.restore();
      }
    });
  });

  test("human output shows HISTORY section or degraded warning when empty", async () => {
    await withTempCassHome(async (env) => {
      writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])));

      const capture = captureConsole();
      try {
        await contextCommand("test task", {});
        const output = capture.getOutput();

        // When cass is available but empty, shows "HISTORY (0)"
        // When cass is unavailable/degraded, shows warning about local history
        const hasHistorySection = output.includes("HISTORY (0)") || output.includes("HISTORY (");
        const hasDegradedWarning = output.includes("Local history unavailable");
        expect(hasHistorySection || hasDegradedWarning).toBe(true);
      } finally {
        capture.restore();
      }
    });
  });

  test("human output shows WARNINGS section when present", async () => {
    await withTempCassHome(async (env) => {
      const playbook = {
        ...createTestPlaybook([]),
        deprecatedPatterns: [
          { pattern: "callback", replacement: "async/await", reason: "modernize", deprecatedAt: new Date().toISOString() },
        ],
      };
      writeFileSync(env.playbookPath, yaml.stringify(playbook));

      const capture = captureConsole();
      try {
        await contextCommand("add callback function", {});
        const output = capture.getOutput();

        expect(output).toContain("WARNINGS");
        expect(output).toContain("callback");
      } finally {
        capture.restore();
      }
    });
  });

  test("human output shows SUGGESTED SEARCHES section", async () => {
    await withTempCassHome(async (env) => {
      writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])));

      const capture = captureConsole();
      try {
        await contextCommand("fix user login bug", {});
        const output = capture.getOutput();

        expect(output).toContain("SUGGESTED SEARCHES");
      } finally {
        capture.restore();
      }
    });
  });
});

describe("getContext wrapper", () => {
  test("returns same structure as generateContextResult", async () => {
    await withTempCassHome(async (env) => {
      const { getContext } = await import("../src/commands/context.js");
      writeFileSync(env.playbookPath, yaml.stringify(createTestPlaybook([])));

      const capture = captureConsole();
      try {
        const result = await getContext("test task", { json: true });

        expect(result.result).toBeDefined();
        expect(result.rules).toBeDefined();
        expect(result.antiPatterns).toBeDefined();
        expect(result.cassHits).toBeDefined();
        expect(result.warnings).toBeDefined();
        expect(result.suggestedQueries).toBeDefined();
      } finally {
        capture.restore();
      }
    });
  });
});
