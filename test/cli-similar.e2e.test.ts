/**
 * E2E-ish tests for `cm similar`.
 *
 * We keep these deterministic by exercising keyword-mode behavior (no model downloads).
 */
import { describe, it, expect } from "bun:test";
import { writeFile } from "node:fs/promises";
import yaml from "yaml";
import { withTempCassHome } from "./helpers/temp.js";
import { generateSimilarResults, similarCommand } from "../src/commands/similar.js";

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
    },
  };
}

function createTestPlaybook(bullets: any[] = []) {
  const now = new Date().toISOString();
  return {
    schema_version: 2,
    name: "test-playbook",
    description: "Test playbook for similar command",
    metadata: {
      createdAt: now,
      totalReflections: 0,
      totalSessionsProcessed: 0,
    },
    bullets,
    deprecatedPatterns: [],
  };
}

function createBullet(overrides: Partial<{ id: string; content: string; category: string; scope: string }> = {}) {
  const now = new Date().toISOString();
  return {
    id: overrides.id || `b-${Math.random().toString(36).slice(2)}`,
    content: overrides.content || "Test bullet content",
    category: overrides.category || "testing",
    scope: overrides.scope || "global",
    state: "active",
    maturity: "candidate",
    helpfulCount: 0,
    harmfulCount: 0,
    createdAt: now,
    updatedAt: now,
  };
}

describe("generateSimilarResults input validation", () => {
  it("throws error for empty query", async () => {
    await expect(generateSimilarResults("")).rejects.toThrow("Query is required");
    await expect(generateSimilarResults("   ")).rejects.toThrow("Query is required");
  });

  it("throws error for invalid limit (non-integer)", async () => {
    await expect(generateSimilarResults("test", { limit: 1.5 })).rejects.toThrow("--limit must be an integer >= 1");
    await expect(generateSimilarResults("test", { limit: NaN })).rejects.toThrow("--limit must be an integer >= 1");
    await expect(generateSimilarResults("test", { limit: Infinity })).rejects.toThrow("--limit must be an integer >= 1");
  });

  it("throws error for invalid limit (less than 1)", async () => {
    await expect(generateSimilarResults("test", { limit: 0 })).rejects.toThrow("--limit must be an integer >= 1");
    await expect(generateSimilarResults("test", { limit: -1 })).rejects.toThrow("--limit must be an integer >= 1");
  });

  it("throws error for invalid threshold (non-number)", async () => {
    await expect(generateSimilarResults("test", { threshold: NaN })).rejects.toThrow("--threshold must be between 0 and 1");
    await expect(generateSimilarResults("test", { threshold: Infinity })).rejects.toThrow("--threshold must be between 0 and 1");
  });

  it("throws error for threshold out of range", async () => {
    await expect(generateSimilarResults("test", { threshold: -0.1 })).rejects.toThrow("--threshold must be between 0 and 1");
    await expect(generateSimilarResults("test", { threshold: 1.1 })).rejects.toThrow("--threshold must be between 0 and 1");
  });

  it("throws error for invalid scope", async () => {
    await expect(generateSimilarResults("test", { scope: "invalid" as any })).rejects.toThrow('Invalid --scope "invalid"');
  });
});

describe("E2E: CLI similar command", () => {
  it("returns relevant bullets in keyword mode (semanticSearchEnabled default false)", async () => {
    await withTempCassHome(async (env) => {
      const query = "handle jwt authentication errors";

      const playbook = createTestPlaybook([
        createBullet({
          id: "b-jwt",
          content: "Handle jwt authentication errors gracefully",
          category: "security",
        }),
        createBullet({
          id: "b-db",
          content: "Use connection pooling for database connections",
          category: "database",
        }),
      ]);

      await writeFile(env.playbookPath, yaml.stringify(playbook));

      const result = await generateSimilarResults(query, { limit: 5 });

      expect(result.mode).toBe("keyword");
      expect(result.results.length).toBeGreaterThan(0);
      expect(result.results[0].id).toBe("b-jwt");
    });
  });

  it("forces keyword mode when embeddingModel is 'none' (even if semanticSearchEnabled is true)", async () => {
    await withTempCassHome(async (env) => {
      const query = "handle jwt authentication errors";

      await writeFile(
        env.configPath,
        JSON.stringify({ semanticSearchEnabled: true, embeddingModel: "none" }, null, 2)
      );

      const playbook = createTestPlaybook([
        createBullet({
          id: "b-jwt",
          content: "Handle jwt authentication errors gracefully",
          category: "security",
        }),
      ]);

      await writeFile(env.playbookPath, yaml.stringify(playbook));

      const result = await generateSimilarResults(query, { limit: 5 });
      expect(result.mode).toBe("keyword");
      expect(result.results[0].id).toBe("b-jwt");
    });
  });

  it("respects --scope filtering", async () => {
    await withTempCassHome(async (env) => {
      const query = "handle jwt authentication errors gracefully";

      const playbook = createTestPlaybook([
        createBullet({
          id: "b-global",
          content: query,
          category: "security",
          scope: "global",
        }),
        createBullet({
          id: "b-workspace",
          content: query,
          category: "security",
          scope: "workspace",
        }),
      ]);

      await writeFile(env.playbookPath, yaml.stringify(playbook));

      const result = await generateSimilarResults(query, { scope: "global", limit: 10 });
      expect(result.results.map((r) => r.id)).toEqual(["b-global"]);
    });
  });

  it("prints JSON with mode + results when --json is set", async () => {
    await withTempCassHome(async (env) => {
      const query = "handle jwt authentication errors";
      const playbook = createTestPlaybook([
        createBullet({ id: "b-jwt", content: "Handle jwt authentication errors gracefully", category: "security" }),
      ]);
      await writeFile(env.playbookPath, yaml.stringify(playbook));

      const consoleCapture = captureConsole();
      try {
        await similarCommand(query, { json: true, limit: 5, scope: "all" });
      } finally {
        consoleCapture.restore();
      }

      expect(consoleCapture.errors.length).toBe(0);
      expect(consoleCapture.logs.length).toBeGreaterThan(0);

      const payload = JSON.parse(consoleCapture.logs.join("\n")) as any;
      const parsed = payload.data;
      expect(payload.success).toBe(true);
      expect(parsed.query).toBe(query);
      expect(parsed.mode).toBe("keyword");
      expect(Array.isArray(parsed.results)).toBe(true);
      expect(parsed.results[0].id).toBe("b-jwt");
    });
  });

  it("prints JSON when --format json is set (even without --json)", async () => {
    await withTempCassHome(async (env) => {
      const query = "handle jwt authentication errors";
      const playbook = createTestPlaybook([
        createBullet({ id: "b-jwt", content: "Handle jwt authentication errors gracefully", category: "security" }),
      ]);
      await writeFile(env.playbookPath, yaml.stringify(playbook));

      const consoleCapture = captureConsole();
      try {
        await similarCommand(query, { format: "json", limit: 5, scope: "all" });
      } finally {
        consoleCapture.restore();
      }

      expect(consoleCapture.errors.length).toBe(0);
      expect(consoleCapture.logs.length).toBeGreaterThan(0);

      const payload = JSON.parse(consoleCapture.logs.join("\n")) as any;
      const parsed = payload.data;
      expect(payload.success).toBe(true);
      expect(parsed.query).toBe(query);
      expect(parsed.mode).toBe("keyword");
      expect(Array.isArray(parsed.results)).toBe(true);
      expect(parsed.results[0].id).toBe("b-jwt");
    });
  });

  it("prints human-readable output with matches when --json is not set", async () => {
    await withTempCassHome(async (env) => {
      const query = "handle jwt authentication errors";
      const playbook = createTestPlaybook([
        createBullet({ id: "b-jwt", content: "Handle jwt authentication errors gracefully", category: "security" }),
      ]);
      await writeFile(env.playbookPath, yaml.stringify(playbook));

      const consoleCapture = captureConsole();
      try {
        await similarCommand(query, { limit: 5, scope: "all" });
      } finally {
        consoleCapture.restore();
      }

      const output = consoleCapture.logs.join("\n");
      expect(output).toContain("SIMILAR");
      expect(output).toContain("Query:");
      expect(output).toContain("Matches");
      expect(output).toContain("b-jwt");
      expect(output).toContain("sim");
      expect(output).toContain("score");
    });
  });

  it("prints 'No matches found' in human-readable mode when no results", async () => {
    await withTempCassHome(async (env) => {
      const query = "xyz completely unrelated query";
      const playbook = createTestPlaybook([
        createBullet({ id: "b-other", content: "Something entirely different", category: "other" }),
      ]);
      await writeFile(env.playbookPath, yaml.stringify(playbook));

      const consoleCapture = captureConsole();
      try {
        await similarCommand(query, { limit: 5, threshold: 0.9 });
      } finally {
        consoleCapture.restore();
      }

      const output = consoleCapture.logs.join("\n");
      expect(output).toContain("No matches found");
      expect(output).toContain("Try lowering the threshold");
    });
  });

  it("handles similarCommand errors gracefully and reports them", async () => {
    const consoleCapture = captureConsole();
    try {
      await similarCommand("", { json: true });
    } finally {
      consoleCapture.restore();
    }

    const output = consoleCapture.logs.join("\n");
    const parsed = JSON.parse(output) as any;
    expect(parsed.success).toBe(false);
    expect(parsed.error.message).toContain("Query is required");
  });
});
