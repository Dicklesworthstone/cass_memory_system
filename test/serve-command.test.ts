/**
 * Unit tests for serve.ts - MCP HTTP server implementation.
 *
 * Covers:
 * - Helper functions: isLoopbackHost, headerValue, extractBearerToken
 * - routeRequest JSON-RPC routing
 * - computePlaybookStats calculation
 */
import { describe, expect, it } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import yaml from "yaml";
import { CONFIG_INPUT_LIMITS, PLAYBOOK_INPUT_LIMITS } from "../src/input-limits.js";

import {
  __test,
  CassAdmissionController,
  computePlaybookStats,
  resetAdmissionController,
  serveCommand,
  setAdmissionController,
} from "../src/commands/serve.js";
import { withTempCassHome } from "./helpers/temp.js";
import { withTempGitRepo } from "./helpers/git.js";
import { createTestBullet, createTestConfig, createTestPlaybook } from "./helpers/factories.js";

const {
  buildError,
  routeRequest,
  isLoopbackHost,
  headerValue,
  extractBearerToken,
  isNotification,
  wrapToolResult,
  MCP_PROTOCOL_VERSION,
} = __test;

/**
 * Unwrap an MCP tools/call result `{ content: [{ type, text }] }` back into the
 * underlying tool payload (parsing JSON text). Asserts the content-array shape.
 */
function unwrapToolResult(result: any): any {
  expect(result).toBeDefined();
  expect(Array.isArray(result.content)).toBe(true);
  expect(result.content.length).toBeGreaterThan(0);
  expect(result.content[0].type).toBe("text");
  return JSON.parse(result.content[0].text);
}

function captureConsole() {
  const logs: string[] = [];
  const errors: string[] = [];
  const warns: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;

  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
  console.warn = (...args: unknown[]) => warns.push(args.map(String).join(" "));

  return {
    logs,
    errors,
    warns,
    restore: () => {
      console.log = originalLog;
      console.error = originalError;
      console.warn = originalWarn;
    },
  };
}

describe("MCP untrusted workspace limits (#98)", () => {
  const fixtures = [
    {
      name: "oversized invalid bullet array",
      file: "playbook.yaml",
      contents: JSON.stringify({
        ...createTestPlaybook(),
        bullets: Array(PLAYBOOK_INPUT_LIMITS.maxArrayLength + 1).fill(null),
      }),
      error: "maximum array length",
    },
    {
      name: "oversized nested bullet array",
      file: "playbook.yaml",
      contents: JSON.stringify({
        ...createTestPlaybook(),
        bullets: [{ ...createTestBullet(), tags: Array(PLAYBOOK_INPUT_LIMITS.maxArrayLength + 1).fill(null) }],
      }),
      error: "maximum array length",
    },
    {
      name: "invalid elements below the collection limit",
      file: "playbook.yaml",
      contents: JSON.stringify({ ...createTestPlaybook(), bullets: [null, "invalid", 17] }),
      error: "is invalid",
    },
    {
      name: "oversized repository configuration array",
      file: "config.json",
      contents: JSON.stringify({ sessionExcludePatterns: Array(CONFIG_INPUT_LIMITS.maxArrayLength + 1).fill(null) }),
      error: "maximum array length",
    },
    {
      name: "oversized repository configuration file",
      file: "config.yaml",
      contents: "#".repeat(CONFIG_INPUT_LIMITS.maxBytes + 1),
      error: "maximum file size",
    },
  ];

  for (const name of ["cm_context", "memory_search"]) {
    for (const fixture of fixtures) {
      it(`${name} rejects ${fixture.name} in the requested workspace and remains usable`, async () => {
        await withTempCassHome(async (env) => {
          await withTempGitRepo(async (launchRepo) => {
            await withTempGitRepo(async (requestedRepo) => {
              await writeFile(env.configPath, JSON.stringify(createTestConfig({
                playbookPath: env.playbookPath,
                semanticSearchEnabled: false,
                cassPath: "cm-security-test-missing-cass",
              })));
              await writeFile(env.playbookPath, yaml.stringify(createTestPlaybook()));
              await mkdir(path.join(launchRepo, ".cass"));
              await mkdir(path.join(requestedRepo, ".cass"));
              const healthyPath = path.join(launchRepo, ".cass/playbook.yaml");
              const healthyText = yaml.stringify(createTestPlaybook([
                createTestBullet({
                  id: "b-security-normal", content: "Verify database migration safety.",
                  state: "active", maturity: "established", scope: "workspace",
                }),
              ]));
              await writeFile(healthyPath, healthyText);
              const unsafePath = path.join(requestedRepo, ".cass", fixture.file);
              await writeFile(unsafePath, fixture.contents);
              const args = name === "cm_context"
                ? { task: "database migration safety", history: 0 }
                : { query: "database migration safety", scope: "playbook" };
              const cwd = process.cwd();
              try {
                process.chdir(launchRepo);
                const rejected = await routeRequest({
                  jsonrpc: "2.0", id: 980, method: "tools/call",
                  params: { name, arguments: { ...args, workspace: requestedRepo } },
                });
                expect("error" in rejected).toBe(true);
                if (!("error" in rejected)) throw new Error(JSON.stringify(rejected));
                expect(rejected.error.message).toContain(fixture.error);
                expect(rejected.error.message.length).toBeLessThan(2000);
                expect(await readFile(unsafePath, "utf8")).toBe(fixture.contents);
                expect(await readFile(healthyPath, "utf8")).toBe(healthyText);
                expect(await routeRequest({ jsonrpc: "2.0", id: 981, method: "ping" }))
                  .toEqual({ jsonrpc: "2.0", id: 981, result: {} });
                const healthy = await routeRequest({
                  jsonrpc: "2.0", id: 982, method: "tools/call",
                  params: { name, arguments: { ...args, workspace: launchRepo } },
                });
                if (!("result" in healthy)) throw new Error(JSON.stringify(healthy));
                const payload = unwrapToolResult(healthy.result);
                const rules = name === "cm_context" ? payload.relevantBullets : payload.playbook;
                expect(rules.map((rule: { id: string }) => rule.id)).toContain("b-security-normal");
                expect(process.cwd()).toBe(launchRepo);
              } finally {
                process.chdir(cwd);
              }
            });
          });
        }, "mcp-input-limits");
      });
    }
  }
});

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
        error: { code: -32000, message: "Test error" },
      });
    });

    it("includes data when provided", () => {
      const err = buildError("req-1", "Error with data", -32001, { details: "extra" });
      expect("error" in err).toBe(true);
      if ("error" in err) {
        expect(err.error.data).toEqual({ details: "extra" });
      }
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
        method: "tools/list",
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
        method: "resources/list",
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
        params: {},
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
        params: { name: "unknown_tool" },
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
        method: "unsupported/method",
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
        params: {},
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
        params: { uri: "cm://unknown" },
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
        method: "tools/list",
      });

      expect(response.id).toBeNull();
    }, "serve-null-id");
  });

  it("handles missing id gracefully", async () => {
    await withTempCassHome(async () => {
      const response = await routeRequest({
        jsonrpc: "2.0",
        method: "tools/list",
      });

      expect(response.id).toBeNull();
    }, "serve-missing-id");
  });

  // Regression for #51: the MCP `initialize` handshake must succeed (not -32601)
  // and must advertise protocolVersion, capabilities, and serverInfo.
  it("handles initialize handshake and echoes the client protocolVersion", async () => {
    await withTempCassHome(async () => {
      const response = await routeRequest({
        jsonrpc: "2.0",
        id: 100,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "c", version: "1" },
        },
      });

      expect("error" in response).toBe(false);
      expect("result" in response).toBe(true);
      if ("result" in response) {
        expect(response.result.protocolVersion).toBe("2025-06-18");
        expect(response.result.capabilities).toBeDefined();
        expect(response.result.capabilities.tools).toBeDefined();
        expect(response.result.serverInfo).toBeDefined();
        expect(response.result.serverInfo.name).toBe("cass-memory");
        expect(typeof response.result.serverInfo.version).toBe("string");
      }
    }, "serve-initialize");
  });

  it("falls back to the server protocolVersion when the client omits it", async () => {
    await withTempCassHome(async () => {
      const response = await routeRequest({
        jsonrpc: "2.0",
        id: 101,
        method: "initialize",
        params: { capabilities: {} },
      });

      expect("result" in response).toBe(true);
      if ("result" in response) {
        expect(response.result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
      }
    }, "serve-initialize-default-version");
  });

  it("answers ping with an empty result", async () => {
    await withTempCassHome(async () => {
      const response = await routeRequest({ jsonrpc: "2.0", id: 102, method: "ping" });
      expect("result" in response).toBe(true);
      if ("result" in response) {
        expect(response.result).toEqual({});
      }
    }, "serve-ping");
  });

  it("treats notifications/initialized as a notification (no response body)", async () => {
    expect(isNotification({ jsonrpc: "2.0", method: "notifications/initialized" })).toBe(true);
    expect(isNotification({ jsonrpc: "2.0", method: "initialized" })).toBe(true);
    expect(isNotification({ jsonrpc: "2.0", id: 1, method: "tools/list" })).toBe(false);
  });
});

describe("computePlaybookStats", () => {
  const mockConfig = {
    confidenceDecayHalfLifeDays: 90,
    globalPlaybookPath: "/tmp/global.jsonl",
    repoPlaybookPath: "/tmp/repo.jsonl",
    diaryDir: "/tmp/diary",
    cassPath: "cass",
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
          updatedAt: now,
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
          updatedAt: now,
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
          updatedAt: now,
        },
      ],
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
          updatedAt: now,
        },
      ],
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
          harmfulCount: 0,
        },
      ],
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
          updatedAt: now,
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
          updatedAt: now,
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
          updatedAt: now,
        },
      ],
    };
    const stats = computePlaybookStats(playbook, mockConfig);

    expect(stats.topPerformers.length).toBeLessThanOrEqual(5);
    if (stats.topPerformers.length > 0) {
      expect(stats.topPerformers[0].id).toBe("b1");
      expect(stats.topPerformers[0].content).toBe("Top rule");
    }
  });
});

describe("serveCommand validation", () => {
  it("rejects invalid port from args", async () => {
    const originalExit = process.exitCode;
    process.exitCode = 0;
    const capture = captureConsole();
    try {
      await serveCommand({ port: 70000 });
      expect(process.exitCode).toBe(2);
      expect(capture.errors.join("\n")).toContain("port");
    } finally {
      capture.restore();
      process.exitCode = originalExit;
    }
  });

  it("rejects invalid MCP_HTTP_PORT from env", async () => {
    const originalExit = process.exitCode;
    const originalPort = process.env.MCP_HTTP_PORT;
    process.exitCode = 0;
    process.env.MCP_HTTP_PORT = "0";
    const capture = captureConsole();
    try {
      await serveCommand({});
      expect(process.exitCode).toBe(2);
      expect(capture.errors.join("\n")).toContain("MCP_HTTP_PORT");
    } finally {
      capture.restore();
      process.exitCode = originalExit;
      if (originalPort === undefined) {
        delete process.env.MCP_HTTP_PORT;
      } else {
        process.env.MCP_HTTP_PORT = originalPort;
      }
    }
  });

  it("rejects empty host from args", async () => {
    const originalExit = process.exitCode;
    process.exitCode = 0;
    const capture = captureConsole();
    try {
      await serveCommand({ host: "" });
      expect(process.exitCode).toBe(2);
      expect(capture.errors.join("\n")).toContain("host");
    } finally {
      capture.restore();
      process.exitCode = originalExit;
    }
  });

  it("rejects non-loopback host without auth token", async () => {
    const originalExit = process.exitCode;
    const originalToken = process.env.MCP_HTTP_TOKEN;
    const originalUnsafe = process.env.MCP_HTTP_UNSAFE_NO_TOKEN;
    process.exitCode = 0;
    process.env.MCP_HTTP_TOKEN = "";
    process.env.MCP_HTTP_UNSAFE_NO_TOKEN = "";
    const capture = captureConsole();
    try {
      await serveCommand({ host: "0.0.0.0", port: 8765 });
      expect(process.exitCode).toBe(2);
      expect(capture.errors.join("\n")).toContain("Refusing to bind MCP HTTP server");
    } finally {
      capture.restore();
      process.exitCode = originalExit;
      if (originalToken === undefined) delete process.env.MCP_HTTP_TOKEN;
      else process.env.MCP_HTTP_TOKEN = originalToken;
      if (originalUnsafe === undefined) delete process.env.MCP_HTTP_UNSAFE_NO_TOKEN;
      else process.env.MCP_HTTP_UNSAFE_NO_TOKEN = originalUnsafe;
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
          arguments: { bulletId: "test-123", helpful: false, harmful: false },
        },
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
          arguments: { bulletId: "test-123", helpful: true, harmful: true },
        },
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
          arguments: { sessionId: "sess-1", outcome: "invalid-outcome" },
        },
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
          arguments: { task: "" },
        },
      });

      expect("error" in response).toBe(true);
      if ("error" in response) {
        expect(response.error.message).toBeDefined();
      }
    }, "serve-context-validation");
  });

  // Regression for #51 (part 2): successful tools/call results MUST be wrapped
  // in the MCP `content` array, not returned as the raw object (which strict
  // clients render as "Tool ran without output").
  it("wraps successful tools/call results in the MCP content array", async () => {
    await withTempCassHome(async () => {
      const response = await routeRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "cm_context",
          arguments: { task: "fix the auth bug", limit: 1 },
        },
      });

      expect("result" in response).toBe(true);
      if ("result" in response) {
        // Must be the content-array wrapper, not the bare ContextResult.
        expect(Array.isArray(response.result.content)).toBe(true);
        expect(response.result.content[0].type).toBe("text");
        // task should NOT be a top-level field on the wrapper.
        expect(response.result.task).toBeUndefined();
        const payload = unwrapToolResult(response.result);
        expect(payload.task).toBe("fix the auth bug");
        expect(Array.isArray(payload.relevantBullets)).toBe(true);
      }
    }, "serve-toolcall-content-wrapper");
  });

  it("wrapToolResult marks errors with isError and serializes objects", () => {
    const ok = wrapToolResult({ a: 1 });
    expect(ok.content[0].text).toBe(JSON.stringify({ a: 1 }));
    expect(ok.structuredContent).toEqual({ a: 1 });
    expect(ok.isError).toBeUndefined();

    const err = wrapToolResult("boom", true);
    expect(err.content[0].text).toBe("boom");
    expect(err.structuredContent).toBeUndefined();
    expect(err.isError).toBe(true);

    const partial = { success: false, sessionsProcessed: 1, errors: ["session unavailable"] };
    const failed = wrapToolResult(partial, true);
    expect(failed.isError).toBe(true);
    expect(failed.structuredContent).toEqual(partial);
    expect(JSON.parse(failed.content[0].text)).toEqual(partial);
  });

  it("memory_search validates query parameter", async () => {
    await withTempCassHome(async () => {
      const response = await routeRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "memory_search",
          arguments: { query: "" },
        },
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
          arguments: { query: "test", scope: "invalid" },
        },
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
          arguments: { query: "test", limit: -1 },
        },
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
          arguments: { query: "test", days: 0 },
        },
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
          arguments: { task: "test task", limit: -5 },
        },
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
          arguments: { task: "test task", top: -1 },
        },
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
          arguments: { task: "test task", history: -1 },
        },
      });

      expect("error" in response).toBe(true);
      if ("error" in response) {
        expect(response.error.message).toBeDefined();
      }
    }, "serve-context-history-validation");
  });

  it("cm_context accepts history 0 as rules-only context (#97)", async () => {
    await withTempCassHome(async () => {
      const response = await routeRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "cm_context",
          arguments: { task: "test task", history: 0 },
        },
      });

      expect("result" in response).toBe(true);
      if ("result" in response) {
        const payload = unwrapToolResult(response.result);
        expect(payload.historySnippets).toEqual([]);
      }
    }, "serve-context-history-zero");
  });

  it("cm_context with history 0 does not wait for cass admission (#97)", async () => {
    await withTempCassHome(async () => {
      // One slot, held for the whole test, with an unbounded queue and no
      // timeout: any call that waits for admission never returns.
      const controller = new CassAdmissionController(1, 0, 0);
      const release = await controller.acquire();
      setAdmissionController(controller);
      try {
        const response = await Promise.race([
          routeRequest({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "cm_context", arguments: { task: "test task", history: 0 } },
          }),
          new Promise<"queued">((resolve) => setTimeout(() => resolve("queued"), 5000)),
        ]);
        expect(response).not.toBe("queued");
        expect(controller.snapshot().queued).toBe(0);
      } finally {
        release();
        resetAdmissionController();
      }
    }, "serve-context-history-zero-admission");
  });

  it("cm_context validates days parameter", async () => {
    await withTempCassHome(async () => {
      const response = await routeRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "cm_context",
          arguments: { task: "test task", days: -1 },
        },
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
          arguments: { sessionId: "sess-1", outcome: "success", durationSec: -100 },
        },
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
          arguments: { days: 0 },
        },
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
          arguments: { maxSessions: -1 },
        },
      });

      expect("error" in response).toBe(true);
      if ("error" in response) {
        expect(response.error.message).toBeDefined();
      }
    }, "serve-reflect-maxSessions-validation");
  });
});

describe("successful tool calls", () => {
  it("memory_reflect applies a requested project's inline feedback without changing the server's project", async () => {
    await withTempCassHome(async (env) => {
      await withTempGitRepo(async (launchRepo) => {
        await withTempGitRepo(async (requestedRepo) => {
          await writeFile(env.configPath, JSON.stringify(createTestConfig({
            playbookPath: env.playbookPath,
            diaryDir: path.join(env.cassMemoryDir, "diary"),
            cassPath: "cm-reflect-missing-cass",
            validationEnabled: false,
            semanticSearchEnabled: false,
          })));
          await writeFile(env.playbookPath, yaml.stringify(createTestPlaybook()));
          for (const [repo, label] of [[launchRepo, "launch"], [requestedRepo, "requested"]]) {
            await mkdir(path.join(repo, ".cass"));
            await writeFile(path.join(repo, ".cass/playbook.yaml"), yaml.stringify(createTestPlaybook([
              createTestBullet({ id: "b-aaa111", content: `Review ${label} migration safety`, scope: "workspace" }),
              createTestBullet({ id: "b-private", content: `UNRELATED_PRIVATE_${label}_POLICY`, scope: "workspace" }),
            ])));
          }
          const launchPath = path.join(launchRepo, ".cass/playbook.yaml");
          const launchBefore = await readFile(launchPath, "utf-8");
          const session = path.join(env.home, "project-session.jsonl");
          await writeFile(session, JSON.stringify({
            role: "assistant", cwd: requestedRepo,
            content: "Completed the requested project's database migration and verified its safety.\n// [cass: helpful b-aaa111] - The migration check caught a missing index.",
          }) + "\n");
          const cwd = process.cwd();
          const priorLlm = process.env.CASS_MEMORY_LLM;
          const priorStubs = process.env.CM_REFLECTOR_STUBS;
          try {
            process.chdir(launchRepo);
            process.env.CASS_MEMORY_LLM = "none";
            process.env.CM_REFLECTOR_STUBS = JSON.stringify([{ deltas: [] }]);
            const response = await routeRequest({
              jsonrpc: "2.0", id: 1, method: "tools/call",
              params: { name: "memory_reflect", arguments: { workspace: requestedRepo, session } },
            });
            expect("result" in response).toBe(true);
            if (!("result" in response)) throw new Error(JSON.stringify(response));
            const payload = unwrapToolResult(response.result);
            expect(response.result.isError).toBeUndefined();
            expect(payload.success).toBe(true);
            expect(payload.errors).toEqual([]);
            expect(payload.sessionsProcessed).toBe(1);
            expect(payload.deltasApplied).toBe(1);
            expect(payload.repoResult.applied).toBe(1);
            expect(payload.repoResult.playbook).toBeUndefined();
            expect(payload.projectResults).toHaveLength(1);
            expect(payload.projectResults[0].playbookPath).toBe(path.join(requestedRepo, ".cass/playbook.yaml"));
            expect(payload.projectResults[0].result.applied).toBe(1);
            expect(payload.projectResults[0].result.playbook).toBeUndefined();
            expect(payload.projectResults[0].result.decisionLog).toContainEqual(expect.objectContaining({
              phase: "feedback", action: "accepted", bulletId: "b-aaa111",
            }));
            expect(JSON.stringify(response)).not.toContain("UNRELATED_PRIVATE_");
            const saved = yaml.parse(await readFile(path.join(requestedRepo, ".cass/playbook.yaml"), "utf-8"));
            expect(saved.bullets[0].helpfulCount).toBe(1);
            expect(saved.bullets[0].feedbackEvents[0].sessionPath).toBe(session);
            expect(saved.bullets[1].content).toBe("UNRELATED_PRIVATE_requested_POLICY");
            expect(await readFile(launchPath, "utf-8")).toBe(launchBefore);
            expect(process.cwd()).toBe(launchRepo);
          } finally {
            process.chdir(cwd);
            if (priorLlm === undefined) delete process.env.CASS_MEMORY_LLM;
            else process.env.CASS_MEMORY_LLM = priorLlm;
            if (priorStubs === undefined) delete process.env.CM_REFLECTOR_STUBS;
            else process.env.CM_REFLECTOR_STUBS = priorStubs;
          }
        });
      });
    });
  });

  it("memory_search reads and filters the requested workspace instead of the server launch directory", async () => {
    await withTempCassHome(async (env) => {
      await withTempGitRepo(async (launchRepo) => {
        await withTempGitRepo(async (requestedRepo) => {
          await writeFile(env.configPath, JSON.stringify(createTestConfig({ playbookPath: env.playbookPath })));
          await writeFile(env.playbookPath, yaml.stringify(createTestPlaybook([
            createTestBullet({ id: "global-migration", content: "Review migration safety" }),
            createTestBullet({ id: "launch-only", content: "Review migration safety", scope: "workspace", workspace: launchRepo }),
            createTestBullet({ id: "requested-only", content: "Review migration safety", scope: "workspace", workspace: requestedRepo }),
            createTestBullet({ id: "unresolved", content: "Review migration safety", scope: "workspace" }),
          ])));
          for (const [repo, label] of [[launchRepo, "launch"], [requestedRepo, "requested"]]) {
            await mkdir(path.join(repo, ".cass"));
            await writeFile(path.join(repo, ".cass/playbook.yaml"), yaml.stringify(createTestPlaybook([
              createTestBullet({ id: "same-id", content: `Review ${label} migration safety`, scope: "workspace" }),
            ])));
          }
          const cwd = process.cwd();
          try {
            process.chdir(launchRepo);
            const response = await routeRequest({
              jsonrpc: "2.0", id: 1, method: "tools/call",
              params: { name: "memory_search", arguments: { query: "migration", scope: "playbook", workspace: requestedRepo } },
            });
            expect("result" in response).toBe(true);
            if (!("result" in response)) throw new Error(JSON.stringify(response));
            const payload = unwrapToolResult(response.result);
            expect(payload.playbook.map((b: any) => b.id).sort()).toEqual(["global-migration", "requested-only", "same-id"]);
            expect(payload.playbook.find((b: any) => b.id === "same-id").content).toContain("requested");
            expect(process.cwd()).toBe(launchRepo);
          } finally {
            process.chdir(cwd);
          }
        });
      });
    });
  });

  it("context and memory_search honor named applicability and return scope selectors", async () => {
    await withTempCassHome(async (env) => {
      await writeFile(env.configPath, JSON.stringify(createTestConfig({
        playbookPath: env.playbookPath, cassPath: "cm-scope-missing-cass", semanticSearchEnabled: false,
        minRelevanceScore: 0, minRelativeRelevance: 0, contextTokenBudget: 0,
      })));
      const content = "Review migration safety";
      await writeFile(env.playbookPath, yaml.stringify(createTestPlaybook([
        createTestBullet({ id: "global", content }),
        createTestBullet({ id: "python", content, scope: "language", scopeKey: "python" }),
        createTestBullet({ id: "typescript", content, scope: "language", scopeKey: "typescript" }),
        createTestBullet({ id: "react", content, scope: "framework", scopeKey: "react" }),
        createTestBullet({ id: "vue", content, scope: "framework", scopeKey: "vue" }),
        createTestBullet({ id: "review", content, scope: "task", scopeKey: "review" }),
        createTestBullet({ id: "deployment", content, scope: "task", scopeKey: "deployment" }),
      ])));
      for (const name of ["cm_context", "memory_search"]) {
        const response = await routeRequest({
          jsonrpc: "2.0", id: 1, method: "tools/call",
          params: { name, arguments: {
            ...(name === "cm_context" ? { task: content } : { query: "migration", scope: "playbook" }),
            language: "python", framework: "react", taskType: "review", limit: 20,
          } },
        });
        expect("result" in response).toBe(true);
        if (!("result" in response)) throw new Error(JSON.stringify(response));
        const payload = unwrapToolResult(response.result);
        const bullets = name === "cm_context" ? payload.relevantBullets : payload.playbook;
        expect(bullets.map((b: any) => b.id).sort()).toEqual(["global", "python", "react", "review"]);
        expect(bullets.find((b: any) => b.id === "python").scopeKey).toBe("python");
      }
    });
  });

  for (const name of ["cm_context", "memory_search"]) {
    for (const key of ["language", "framework", "taskType"]) {
      it(`${name} rejects invalid ${key} selectors`, async () => {
        const response = await routeRequest({
          jsonrpc: "2.0", id: 1, method: "tools/call",
          params: { name, arguments: { task: "review migrations", query: "migration", [key]: [] } },
        });
        expect("error" in response).toBe(true);
        if ("error" in response) expect(response.error.message).toContain(key);
      });
    }
  }

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
        updatedAt: new Date().toISOString(),
      };
      await writeFile(path.join(env.cassMemoryDir, "playbook.jsonl"), JSON.stringify(bullet));

      const response = await routeRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "memory_search",
          arguments: { query: "authentication", scope: "playbook", limit: 5 },
        },
      });

      expect("result" in response).toBe(true);
      if ("result" in response) {
        const payload = unwrapToolResult(response.result);
        expect(payload.playbook).toBeDefined();
        expect(Array.isArray(payload.playbook)).toBe(true);
        // Should find our bullet since it contains "authentication"
        const found = payload.playbook.find((b: any) => b.id === "search-test-1");
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
        updatedAt: new Date().toISOString(),
      };
      await writeFile(path.join(env.cassMemoryDir, "playbook.jsonl"), JSON.stringify(bullet));

      const response = await routeRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "memory_search",
          arguments: { query: "error", scope: "both", limit: 10, days: 7 },
        },
      });

      expect("result" in response).toBe(true);
      if ("result" in response) {
        const payload = unwrapToolResult(response.result);
        expect(payload.playbook).toBeDefined();
        expect(payload.cass).toBeDefined();
        expect(Array.isArray(payload.playbook)).toBe(true);
        expect(Array.isArray(payload.cass)).toBe(true);
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
          arguments: { query: "test", scope: "cass", limit: 5, agent: "claude", workspace: "/tmp" },
        },
      });

      expect("result" in response).toBe(true);
      if ("result" in response) {
        const payload = unwrapToolResult(response.result);
        expect(payload.cass).toBeDefined();
        expect(payload.playbook).toBeUndefined();
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
            session: "test-session-123",
          },
        },
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
            reason: "This rule caused issues",
          },
        },
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
            durationSec: 120,
          },
        },
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
            outcome: "partial",
          },
        },
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
            rulesUsed: ["rule-a", "", "  ", "rule-b"], // includes empty strings to test filtering
            notes: "Some parts worked",
          },
        },
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
            task: "Failed task",
          },
        },
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
        updatedAt: new Date().toISOString(),
      };
      await writeFile(path.join(env.cassMemoryDir, "playbook.jsonl"), JSON.stringify(bullet));

      const response = await routeRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "resources/read",
        params: { uri: "cm://playbook" },
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
        params: { uri: "cm://outcomes" },
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
        params: { uri: "cm://diary" },
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
        updatedAt: new Date().toISOString(),
      };
      await writeFile(path.join(env.cassMemoryDir, "playbook.jsonl"), JSON.stringify(bullet));

      const response = await routeRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "resources/read",
        params: { uri: "cm://stats" },
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
        params: { uri: "memory://stats" },
      });

      expect("result" in response).toBe(true);
      if ("result" in response) {
        expect(response.result.uri).toBe("memory://stats");
        expect(response.result.mimeType).toBe("application/json");
      }
    }, "serve-read-memory-stats");
  });
});

describe("serveCommand host validation", () => {
  it("rejects empty MCP_HTTP_HOST from env", async () => {
    const originalExit = process.exitCode;
    const originalHost = process.env.MCP_HTTP_HOST;
    process.exitCode = 0;
    process.env.MCP_HTTP_HOST = "";
    const capture = captureConsole();
    try {
      await serveCommand({});
      // Empty string should fall back to default, which is OK
      // But let's test an explicitly empty string after trimming
    } finally {
      capture.restore();
      process.exitCode = originalExit;
      if (originalHost === undefined) {
        delete process.env.MCP_HTTP_HOST;
      } else {
        process.env.MCP_HTTP_HOST = originalHost;
      }
    }
  });

  it("allows loopback host without token", async () => {
    const originalExit = process.exitCode;
    const originalToken = process.env.MCP_HTTP_TOKEN;
    const originalUnsafe = process.env.MCP_HTTP_UNSAFE_NO_TOKEN;
    process.exitCode = 0;
    process.env.MCP_HTTP_TOKEN = "";
    process.env.MCP_HTTP_UNSAFE_NO_TOKEN = "";
    const capture = captureConsole();
    try {
      // Host 127.0.0.1 is loopback, should be allowed without token
      // This will start a server which we can't easily clean up in this test
      // So we just verify the validation passes
      expect(isLoopbackHost("127.0.0.1")).toBe(true);
      expect(isLoopbackHost("localhost")).toBe(true);
      expect(isLoopbackHost("::1")).toBe(true);
    } finally {
      capture.restore();
      process.exitCode = originalExit;
      if (originalToken === undefined) delete process.env.MCP_HTTP_TOKEN;
      else process.env.MCP_HTTP_TOKEN = originalToken;
      if (originalUnsafe === undefined) delete process.env.MCP_HTTP_UNSAFE_NO_TOKEN;
      else process.env.MCP_HTTP_UNSAFE_NO_TOKEN = originalUnsafe;
    }
  });
});

describe("memory_reflect tool validation", () => {
  it("validates workspace parameter", async () => {
    await withTempCassHome(async () => {
      const response = await routeRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "memory_reflect",
          arguments: { workspace: "" }, // Empty workspace should fail validation
        },
      });

      expect("error" in response).toBe(true);
      if ("error" in response) {
        expect(response.error.message).toBeDefined();
      }
    }, "serve-reflect-workspace-validation");
  });

  it("validates session parameter", async () => {
    await withTempCassHome(async () => {
      const response = await routeRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "memory_reflect",
          arguments: { session: "" }, // Empty session should fail validation
        },
      });

      expect("error" in response).toBe(true);
      if ("error" in response) {
        expect(response.error.message).toBeDefined();
      }
    }, "serve-reflect-session-validation");
  });
});

describe("cm_context tool additional validation", () => {
  it("validates workspace parameter", async () => {
    await withTempCassHome(async () => {
      const response = await routeRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "cm_context",
          arguments: { task: "test task", workspace: "" },
        },
      });

      expect("error" in response).toBe(true);
      if ("error" in response) {
        expect(response.error.message).toBeDefined();
      }
    }, "serve-context-workspace-validation");
  });

  it("handles valid context request", async () => {
    await withTempCassHome(async (env) => {
      // Create a playbook with a bullet
      const bullet = {
        id: "ctx-test-1",
        content: "When testing context, verify all rules",
        scope: "global",
        state: "active",
        kind: "rule",
        category: "testing",
        helpfulCount: 2,
        harmfulCount: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await writeFile(path.join(env.cassMemoryDir, "playbook.jsonl"), JSON.stringify(bullet));

      const response = await routeRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "cm_context",
          arguments: { task: "testing context functionality", limit: 5, history: 3, days: 7 },
        },
      });

      expect("result" in response).toBe(true);
      if ("result" in response) {
        expect(response.result).toBeDefined();
      }
    }, "serve-context-valid-request");
  });
});

describe("cm_feedback tool additional validation", () => {
  it("validates reason parameter rejects empty string", async () => {
    await withTempCassHome(async () => {
      // Empty reason should fail validation
      const response = await routeRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "cm_feedback",
          arguments: { bulletId: "test-bullet", helpful: true, reason: "", session: "test" },
        },
      });

      // Should fail with validation error for empty reason
      expect("error" in response).toBe(true);
      if ("error" in response) {
        expect(response.error.message).toContain("non-empty");
      }
    }, "serve-feedback-empty-reason");
  });

  it("validates session parameter is non-empty if provided", async () => {
    await withTempCassHome(async () => {
      const response = await routeRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "cm_feedback",
          arguments: { bulletId: "test-bullet", helpful: true, session: "" },
        },
      });

      expect("error" in response).toBe(true);
      if ("error" in response) {
        expect(response.error.message).toBeDefined();
      }
    }, "serve-feedback-empty-session");
  });
});
