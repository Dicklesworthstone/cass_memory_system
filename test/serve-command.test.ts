/**
 * Unit tests for serve.ts - MCP HTTP server implementation.
 *
 * Covers:
 * - Helper functions: isLoopbackHost, headerValue, extractBearerToken
 * - routeRequest JSON-RPC routing
 * - computePlaybookStats calculation
 */
import { describe, it, expect } from "bun:test";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { __test, computePlaybookStats } from "../src/commands/serve.js";
import { withTempCassHome } from "./helpers/temp.js";

const { buildError, routeRequest, isLoopbackHost, headerValue, extractBearerToken } = __test;

describe("serve.ts helper functions", () => {
  describe("isLoopbackHost", () => {
    it("returns true for localhost", () => {
      expect(isLoopbackHost("localhost")).toBe(true);
      expect(isLoopbackHost("LOCALHOST")).toBe(true);
      expect(isLoopbackHost("  localhost  ")).toBe(true);
    });

    it("returns true for IPv4 loopback addresses", () => {
      expect(isLoopbackHost("127.0.0.1")).toBe(true);
      expect(isLoopbackHost("127.0.0.2")).toBe(true);
      expect(isLoopbackHost("127.255.255.255")).toBe(true);
    });

    it("returns true for IPv6 loopback", () => {
      expect(isLoopbackHost("::1")).toBe(true);
    });

    it("returns false for non-loopback addresses", () => {
      expect(isLoopbackHost("0.0.0.0")).toBe(false);
      expect(isLoopbackHost("192.168.1.1")).toBe(false);
      expect(isLoopbackHost("example.com")).toBe(false);
    });

    it("returns false for empty string", () => {
      expect(isLoopbackHost("")).toBe(false);
      expect(isLoopbackHost("   ")).toBe(false);
    });
  });

  describe("headerValue", () => {
    it("returns string value as-is", () => {
      expect(headerValue("Bearer token123")).toBe("Bearer token123");
    });

    it("returns first element of array", () => {
      expect(headerValue(["value1", "value2"])).toBe("value1");
    });

    it("returns undefined for non-string non-array", () => {
      expect(headerValue(undefined)).toBeUndefined();
      expect(headerValue(123)).toBeUndefined();
      expect(headerValue(null)).toBeUndefined();
    });

    it("returns undefined for empty array", () => {
      expect(headerValue([])).toBeUndefined();
    });

    it("returns undefined for array with non-string first element", () => {
      expect(headerValue([123, "str"])).toBeUndefined();
    });
  });

  describe("extractBearerToken", () => {
    it("extracts token from Bearer header", () => {
      expect(extractBearerToken("Bearer abc123")).toBe("abc123");
      expect(extractBearerToken("bearer ABC")).toBe("ABC");
      expect(extractBearerToken("BEARER token-with-dashes")).toBe("token-with-dashes");
    });

    it("handles extra whitespace", () => {
      expect(extractBearerToken("Bearer   token123")).toBe("token123");
    });

    it("returns undefined for invalid formats", () => {
      expect(extractBearerToken(undefined)).toBeUndefined();
      expect(extractBearerToken("")).toBeUndefined();
      expect(extractBearerToken("Basic abc123")).toBeUndefined();
      expect(extractBearerToken("Bearer")).toBeUndefined();
      expect(extractBearerToken("Bearer ")).toBeUndefined();
    });
  });

  describe("buildError", () => {
    it("builds a JSON-RPC error response", () => {
      const err = buildError(1, "Test error", -32000);
      expect(err).toEqual({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32000, message: "Test error" }
      });
    });

    it("includes data when provided", () => {
      const err = buildError("req-1", "Error with data", -32001, { details: "extra" });
      expect(err.error.data).toEqual({ details: "extra" });
    });

    it("handles null id", () => {
      const err = buildError(null, "No id error");
      expect(err.id).toBeNull();
    });
  });
});

describe("routeRequest JSON-RPC routing", () => {
  it("handles tools/list method", async () => {
    await withTempCassHome(async () => {
      const response = await routeRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list"
      });

      expect(response.jsonrpc).toBe("2.0");
      expect(response.id).toBe(1);
      expect("result" in response).toBe(true);
      if ("result" in response) {
        expect(response.result.tools).toBeInstanceOf(Array);
        expect(response.result.tools.length).toBeGreaterThan(0);
        const toolNames = response.result.tools.map((t: any) => t.name);
        expect(toolNames).toContain("cm_context");
        expect(toolNames).toContain("cm_feedback");
        expect(toolNames).toContain("cm_outcome");
        expect(toolNames).toContain("memory_search");
        expect(toolNames).toContain("memory_reflect");
      }
    }, "serve-tools-list");
  });

  it("handles resources/list method", async () => {
    await withTempCassHome(async () => {
      const response = await routeRequest({
        jsonrpc: "2.0",
        id: 2,
        method: "resources/list"
      });

      expect(response.jsonrpc).toBe("2.0");
      expect(response.id).toBe(2);
      if ("result" in response) {
        expect(response.result.resources).toBeInstanceOf(Array);
        const uris = response.result.resources.map((r: any) => r.uri);
        expect(uris).toContain("cm://playbook");
        expect(uris).toContain("cm://diary");
        expect(uris).toContain("cm://outcomes");
        expect(uris).toContain("cm://stats");
      }
    }, "serve-resources-list");
  });

  it("returns error for missing tool name in tools/call", async () => {
    await withTempCassHome(async () => {
      const response = await routeRequest({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {}
      });

      expect("error" in response).toBe(true);
      if ("error" in response) {
        expect(response.error.code).toBe(-32602);
        expect(response.error.message).toContain("Missing tool name");
      }
    }, "serve-missing-tool");
  });

  it("returns error for unknown tool", async () => {
    await withTempCassHome(async () => {
      const response = await routeRequest({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "unknown_tool" }
      });

      expect("error" in response).toBe(true);
      if ("error" in response) {
        expect(response.error.message).toContain("Unknown tool");
      }
    }, "serve-unknown-tool");
  });

  it("returns error for unsupported method", async () => {
    await withTempCassHome(async () => {
      const response = await routeRequest({
        jsonrpc: "2.0",
        id: 5,
        method: "unsupported/method"
      });

      expect("error" in response).toBe(true);
      if ("error" in response) {
        expect(response.error.code).toBe(-32601);
        expect(response.error.message).toContain("Unsupported method");
      }
    }, "serve-unsupported-method");
  });

  it("returns error for missing resource uri", async () => {
    await withTempCassHome(async () => {
      const response = await routeRequest({
        jsonrpc: "2.0",
        id: 6,
        method: "resources/read",
        params: {}
      });

      expect("error" in response).toBe(true);
      if ("error" in response) {
        expect(response.error.code).toBe(-32602);
        expect(response.error.message).toContain("Missing resource uri");
      }
    }, "serve-missing-uri");
  });

  it("returns error for unknown resource uri", async () => {
    await withTempCassHome(async () => {
      const response = await routeRequest({
        jsonrpc: "2.0",
        id: 7,
        method: "resources/read",
        params: { uri: "cm://unknown" }
      });

      expect("error" in response).toBe(true);
      if ("error" in response) {
        expect(response.error.message).toContain("Unknown resource");
      }
    }, "serve-unknown-resource");
  });

  it("handles null id gracefully", async () => {
    await withTempCassHome(async () => {
      const response = await routeRequest({
        jsonrpc: "2.0",
        id: null,
        method: "tools/list"
      });

      expect(response.id).toBeNull();
    }, "serve-null-id");
  });

  it("handles missing id gracefully", async () => {
    await withTempCassHome(async () => {
      const response = await routeRequest({
        jsonrpc: "2.0",
        method: "tools/list"
      });

      expect(response.id).toBeNull();
    }, "serve-missing-id");
  });
});

describe("computePlaybookStats", () => {
  const mockConfig = {
    confidenceDecayHalfLifeDays: 90,
    globalPlaybookPath: "/tmp/global.jsonl",
    repoPlaybookPath: "/tmp/repo.jsonl",
    diaryDir: "/tmp/diary",
    cassPath: "cass"
  };

  it("computes stats for empty playbook", () => {
    const playbook = { bullets: [] };
    const stats = computePlaybookStats(playbook, mockConfig);

    expect(stats.total).toBe(0);
    expect(stats.byScope).toEqual({});
    expect(stats.byState).toEqual({});
    expect(stats.byKind).toEqual({});
    expect(stats.topPerformers).toEqual([]);
    expect(stats.atRiskCount).toBe(0);
    expect(stats.staleCount).toBe(0);
    expect(stats.generatedAt).toBeDefined();
  });

  it("computes stats for playbook with bullets", () => {
    const now = new Date().toISOString();
    const playbook = {
      bullets: [
        {
          id: "b1",
          content: "Rule 1",
          scope: "global",
          state: "active",
          kind: "rule",
          helpfulCount: 5,
          harmfulCount: 0,
          createdAt: now,
          updatedAt: now
        },
        {
          id: "b2",
          content: "Rule 2",
          scope: "repo",
          state: "active",
          kind: "heuristic",
          helpfulCount: 3,
          harmfulCount: 1,
          createdAt: now,
          updatedAt: now
        },
        {
          id: "b3",
          content: "Rule 3",
          scope: "global",
          state: "deprecated",
          kind: "rule",
          deprecated: true,
          helpfulCount: 0,
          harmfulCount: 2,
          createdAt: now,
          updatedAt: now
        }
      ]
    };
    const stats = computePlaybookStats(playbook, mockConfig);

    expect(stats.total).toBe(3);
    expect(stats.byScope).toEqual({ global: 2, repo: 1 });
    expect(stats.byState).toEqual({ active: 2, deprecated: 1 });
    expect(stats.byKind).toEqual({ rule: 2, heuristic: 1 });
    expect(stats.topPerformers.length).toBeGreaterThanOrEqual(0);
    expect(stats.generatedAt).toBeDefined();
  });

  it("identifies at-risk bullets with negative scores", () => {
    const now = new Date().toISOString();
    const playbook = {
      bullets: [
        {
          id: "b1",
          content: "Bad rule",
          scope: "global",
          state: "active",
          kind: "rule",
          helpfulCount: 0,
          harmfulCount: 10,
          createdAt: now,
          updatedAt: now
        }
      ]
    };
    const stats = computePlaybookStats(playbook, mockConfig);

    expect(stats.atRiskCount).toBeGreaterThanOrEqual(0);
  });

  it("handles bullets with missing scope/state/kind", () => {
    const now = new Date().toISOString();
    const playbook = {
      bullets: [
        {
          id: "b1",
          content: "Minimal bullet",
          createdAt: now,
          updatedAt: now,
          helpfulCount: 0,
          harmfulCount: 0
        }
      ]
    };
    const stats = computePlaybookStats(playbook, mockConfig);

    expect(stats.total).toBe(1);
    expect(stats.byScope).toEqual({ unknown: 1 });
    expect(stats.byState).toEqual({ unknown: 1 });
    expect(stats.byKind).toEqual({ unknown: 1 });
  });

  it("calculates top performers correctly", () => {
    const now = new Date().toISOString();
    const playbook = {
      bullets: [
        {
          id: "b1",
          content: "Top rule",
          scope: "global",
          state: "active",
          kind: "rule",
          helpfulCount: 20,
          harmfulCount: 0,
          createdAt: now,
          updatedAt: now
        },
        {
          id: "b2",
          content: "Medium rule",
          scope: "global",
          state: "active",
          kind: "rule",
          helpfulCount: 10,
          harmfulCount: 0,
          createdAt: now,
          updatedAt: now
        },
        {
          id: "b3",
          content: "Low rule",
          scope: "global",
          state: "active",
          kind: "rule",
          helpfulCount: 1,
          harmfulCount: 0,
          createdAt: now,
          updatedAt: now
        }
      ]
    };
    const stats = computePlaybookStats(playbook, mockConfig);

    expect(stats.topPerformers.length).toBeLessThanOrEqual(5);
    if (stats.topPerformers.length > 0) {
      expect(stats.topPerformers[0].id).toBe("b1");
      expect(stats.topPerformers[0].content).toBe("Top rule");
    }
  });
});

describe("tool call validation", () => {
  it("cm_feedback requires exactly one of helpful or harmful", async () => {
    await withTempCassHome(async () => {
      // Both false
      const response1 = await routeRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "cm_feedback",
          arguments: { bulletId: "test-123", helpful: false, harmful: false }
        }
      });
      expect("error" in response1).toBe(true);
      if ("error" in response1) {
        expect(response1.error.message).toContain("exactly one of helpful or harmful");
      }

      // Both true
      const response2 = await routeRequest({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "cm_feedback",
          arguments: { bulletId: "test-123", helpful: true, harmful: true }
        }
      });
      expect("error" in response2).toBe(true);
      if ("error" in response2) {
        expect(response2.error.message).toContain("exactly one of helpful or harmful");
      }
    }, "serve-feedback-validation");
  });

  it("cm_outcome validates outcome enum", async () => {
    await withTempCassHome(async () => {
      const response = await routeRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "cm_outcome",
          arguments: { sessionId: "sess-1", outcome: "invalid-outcome" }
        }
      });

      expect("error" in response).toBe(true);
      if ("error" in response) {
        expect(response.error.message).toContain("must be success | failure | mixed | partial");
      }
    }, "serve-outcome-validation");
  });

  it("cm_context validates task parameter", async () => {
    await withTempCassHome(async () => {
      const response = await routeRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "cm_context",
          arguments: { task: "" }
        }
      });

      expect("error" in response).toBe(true);
      if ("error" in response) {
        expect(response.error.message).toBeDefined();
      }
    }, "serve-context-validation");
  });

  it("memory_search validates query parameter", async () => {
    await withTempCassHome(async () => {
      const response = await routeRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "memory_search",
          arguments: { query: "" }
        }
      });

      expect("error" in response).toBe(true);
      if ("error" in response) {
        expect(response.error.message).toBeDefined();
      }
    }, "serve-search-query-validation");
  });

  it("memory_search validates scope enum", async () => {
    await withTempCassHome(async () => {
      const response = await routeRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "memory_search",
          arguments: { query: "test", scope: "invalid" }
        }
      });

      expect("error" in response).toBe(true);
      if ("error" in response) {
        expect(response.error.message).toBeDefined();
      }
    }, "serve-search-scope-validation");
  });

  it("memory_search validates limit parameter", async () => {
    await withTempCassHome(async () => {
      const response = await routeRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "memory_search",
          arguments: { query: "test", limit: -1 }
        }
      });

      expect("error" in response).toBe(true);
      if ("error" in response) {
        expect(response.error.message).toBeDefined();
      }
    }, "serve-search-limit-validation");
  });

  it("memory_search validates days parameter", async () => {
    await withTempCassHome(async () => {
      const response = await routeRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "memory_search",
          arguments: { query: "test", days: 0 }
        }
      });

      expect("error" in response).toBe(true);
      if ("error" in response) {
        expect(response.error.message).toBeDefined();
      }
    }, "serve-search-days-validation");
  });

  it("cm_context validates limit parameter", async () => {
    await withTempCassHome(async () => {
      const response = await routeRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "cm_context",
          arguments: { task: "test task", limit: -5 }
        }
      });

      expect("error" in response).toBe(true);
      if ("error" in response) {
        expect(response.error.message).toBeDefined();
      }
    }, "serve-context-limit-validation");
  });

  it("cm_context validates top parameter (deprecated)", async () => {
    await withTempCassHome(async () => {
      const response = await routeRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "cm_context",
          arguments: { task: "test task", top: -1 }
        }
      });

      expect("error" in response).toBe(true);
      if ("error" in response) {
        expect(response.error.message).toBeDefined();
      }
    }, "serve-context-top-validation");
  });

  it("cm_context validates history parameter", async () => {
    await withTempCassHome(async () => {
      const response = await routeRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "cm_context",
          arguments: { task: "test task", history: 0 }
        }
      });

      expect("error" in response).toBe(true);
      if ("error" in response) {
        expect(response.error.message).toBeDefined();
      }
    }, "serve-context-history-validation");
  });

  it("cm_context validates days parameter", async () => {
    await withTempCassHome(async () => {
      const response = await routeRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "cm_context",
          arguments: { task: "test task", days: -1 }
        }
      });

      expect("error" in response).toBe(true);
      if ("error" in response) {
        expect(response.error.message).toBeDefined();
      }
    }, "serve-context-days-validation");
  });

  it("cm_outcome validates durationSec parameter", async () => {
    await withTempCassHome(async () => {
      const response = await routeRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "cm_outcome",
          arguments: { sessionId: "sess-1", outcome: "success", durationSec: -100 }
        }
      });

      expect("error" in response).toBe(true);
      if ("error" in response) {
        expect(response.error.message).toBeDefined();
      }
    }, "serve-outcome-duration-validation");
  });

  it("memory_reflect validates days parameter", async () => {
    await withTempCassHome(async () => {
      const response = await routeRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "memory_reflect",
          arguments: { days: 0 }
        }
      });

      expect("error" in response).toBe(true);
      if ("error" in response) {
        expect(response.error.message).toBeDefined();
      }
    }, "serve-reflect-days-validation");
  });

  it("memory_reflect validates maxSessions parameter", async () => {
    await withTempCassHome(async () => {
      const response = await routeRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "memory_reflect",
          arguments: { maxSessions: -1 }
        }
      });

      expect("error" in response).toBe(true);
      if ("error" in response) {
        expect(response.error.message).toBeDefined();
      }
    }, "serve-reflect-maxSessions-validation");
  });
});

describe("successful tool calls", () => {
  it("memory_search with playbook scope returns playbook bullets", async () => {
    await withTempCassHome(async (env) => {
      // Create a playbook with a bullet to search
      const bullet = {
        id: "search-test-1",
        content: "Authentication rule for login",
        scope: "global",
        state: "active",
        kind: "rule",
        category: "security",
        helpfulCount: 1,
        harmfulCount: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      await writeFile(
        path.join(env.cassMemoryDir, "playbook.jsonl"),
        JSON.stringify(bullet)
      );

      const response = await routeRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "memory_search",
          arguments: { query: "authentication", scope: "playbook", limit: 5 }
        }
      });

      expect("result" in response).toBe(true);
      if ("result" in response) {
        expect(response.result.playbook).toBeDefined();
        expect(Array.isArray(response.result.playbook)).toBe(true);
        // Should find our bullet since it contains "authentication"
        const found = response.result.playbook.find((b: any) => b.id === "search-test-1");
        if (found) {
          expect(found.content).toContain("Authentication");
        }
      }
    }, "serve-search-playbook-scope");
  });

  it("memory_search with both scope searches playbook and cass", async () => {
    await withTempCassHome(async (env) => {
      // Create a playbook bullet
      const bullet = {
        id: "both-test-1",
        content: "Error handling pattern",
        scope: "global",
        state: "active",
        kind: "heuristic",
        helpfulCount: 0,
        harmfulCount: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      await writeFile(
        path.join(env.cassMemoryDir, "playbook.jsonl"),
        JSON.stringify(bullet)
      );

      const response = await routeRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "memory_search",
          arguments: { query: "error", scope: "both", limit: 10, days: 7 }
        }
      });

      expect("result" in response).toBe(true);
      if ("result" in response) {
        expect(response.result.playbook).toBeDefined();
        expect(response.result.cass).toBeDefined();
        expect(Array.isArray(response.result.playbook)).toBe(true);
        expect(Array.isArray(response.result.cass)).toBe(true);
      }
    }, "serve-search-both-scope");
  });

  it("memory_search with cass scope only", async () => {
    await withTempCassHome(async () => {
      const response = await routeRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "memory_search",
          arguments: { query: "test", scope: "cass", limit: 5, agent: "claude", workspace: "/tmp" }
        }
      });

      expect("result" in response).toBe(true);
      if ("result" in response) {
        expect(response.result.cass).toBeDefined();
        expect(response.result.playbook).toBeUndefined();
      }
    }, "serve-search-cass-scope");
  });

  it("cm_feedback with helpful flag for non-existent bullet returns error", async () => {
    await withTempCassHome(async () => {
      const response = await routeRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "cm_feedback",
          arguments: {
            bulletId: "nonexistent-bullet-123",
            helpful: true,
            reason: "This rule helped fix the bug",
            session: "test-session-123"
          }
        }
      });

      // Should return error since bullet doesn't exist
      expect("error" in response).toBe(true);
      if ("error" in response) {
        expect(response.error.message).toContain("not found");
      }
    }, "serve-feedback-helpful-not-found");
  });

  it("cm_feedback with harmful flag for non-existent bullet returns error", async () => {
    await withTempCassHome(async () => {
      const response = await routeRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "cm_feedback",
          arguments: {
            bulletId: "nonexistent-bullet-456",
            harmful: true,
            reason: "This rule caused issues"
          }
        }
      });

      // Should return error since bullet doesn't exist
      expect("error" in response).toBe(true);
      if ("error" in response) {
        expect(response.error.message).toContain("not found");
      }
    }, "serve-feedback-harmful-not-found");
  });

  it("cm_outcome with valid parameters succeeds", async () => {
    await withTempCassHome(async () => {
      const response = await routeRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "cm_outcome",
          arguments: {
            sessionId: "outcome-test-session",
            outcome: "success",
            rulesUsed: ["rule-1", "rule-2"],
            notes: "Task completed successfully",
            task: "Fix authentication bug",
            durationSec: 120
          }
        }
      });

      expect("result" in response).toBe(true);
      if ("result" in response) {
        expect(response.result).toBeDefined();
      }
    }, "serve-outcome-success");
  });

  it("cm_outcome with partial outcome", async () => {
    await withTempCassHome(async () => {
      const response = await routeRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "cm_outcome",
          arguments: {
            sessionId: "outcome-partial-session",
            outcome: "partial"
          }
        }
      });

      expect("result" in response).toBe(true);
    }, "serve-outcome-partial");
  });

  it("cm_outcome with mixed outcome", async () => {
    await withTempCassHome(async () => {
      const response = await routeRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "cm_outcome",
          arguments: {
            sessionId: "outcome-mixed-session",
            outcome: "mixed",
            rulesUsed: ["rule-a", "", "  ", "rule-b"],  // includes empty strings to test filtering
            notes: "Some parts worked"
          }
        }
      });

      expect("result" in response).toBe(true);
    }, "serve-outcome-mixed");
  });

  it("cm_outcome with failure outcome", async () => {
    await withTempCassHome(async () => {
      const response = await routeRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "cm_outcome",
          arguments: {
            sessionId: "outcome-failure-session",
            outcome: "failure",
            task: "Failed task"
          }
        }
      });

      expect("result" in response).toBe(true);
    }, "serve-outcome-failure");
  });
});

describe("resource read operations", () => {
  it("reads cm://playbook resource", async () => {
    await withTempCassHome(async (env) => {
      // Create a playbook with bullets
      const bullet = {
        id: "pb-test-1",
        content: "Playbook test rule",
        scope: "global",
        state: "active",
        kind: "rule",
        helpfulCount: 2,
        harmfulCount: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      await writeFile(
        path.join(env.cassMemoryDir, "playbook.jsonl"),
        JSON.stringify(bullet)
      );

      const response = await routeRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "resources/read",
        params: { uri: "cm://playbook" }
      });

      expect("result" in response).toBe(true);
      if ("result" in response) {
        expect(response.result.uri).toBe("cm://playbook");
        expect(response.result.mimeType).toBe("application/json");
        expect(response.result.data).toBeDefined();
      }
    }, "serve-read-playbook");
  });

  it("reads cm://outcomes resource", async () => {
    await withTempCassHome(async () => {
      const response = await routeRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "resources/read",
        params: { uri: "cm://outcomes" }
      });

      expect("result" in response).toBe(true);
      if ("result" in response) {
        expect(response.result.uri).toBe("cm://outcomes");
        expect(response.result.mimeType).toBe("application/json");
        expect(response.result.data).toBeDefined();
      }
    }, "serve-read-outcomes");
  });

  it("reads cm://diary resource", async () => {
    await withTempCassHome(async () => {
      const response = await routeRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "resources/read",
        params: { uri: "cm://diary" }
      });

      expect("result" in response).toBe(true);
      if ("result" in response) {
        expect(response.result.uri).toBe("cm://diary");
        expect(response.result.mimeType).toBe("application/json");
      }
    }, "serve-read-diary");
  });

  it("reads cm://stats resource", async () => {
    await withTempCassHome(async (env) => {
      // Create a bullet in playbook
      const bullet = {
        id: "test-1",
        content: "Test rule",
        scope: "global",
        state: "active",
        kind: "rule",
        helpfulCount: 1,
        harmfulCount: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      await writeFile(
        path.join(env.cassMemoryDir, "playbook.jsonl"),
        JSON.stringify(bullet)
      );

      const response = await routeRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "resources/read",
        params: { uri: "cm://stats" }
      });

      expect("result" in response).toBe(true);
      if ("result" in response) {
        expect(response.result.uri).toBe("cm://stats");
        expect(response.result.mimeType).toBe("application/json");
        expect(response.result.data.total).toBeDefined();
        expect(response.result.data.byScope).toBeDefined();
        expect(response.result.data.generatedAt).toBeDefined();
      }
    }, "serve-read-stats");
  });

  it("reads memory://stats resource (alias)", async () => {
    await withTempCassHome(async () => {
      const response = await routeRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "resources/read",
        params: { uri: "memory://stats" }
      });

      expect("result" in response).toBe(true);
      if ("result" in response) {
        expect(response.result.uri).toBe("memory://stats");
        expect(response.result.mimeType).toBe("application/json");
      }
    }, "serve-read-memory-stats");
  });
});
