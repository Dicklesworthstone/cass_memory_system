/**
 * E2E Tests for CLI audit command - Session Violation and Trauma Scanning
 *
 * Tests the `cm audit` command for:
 * 1. Scanning sessions for rule violations (requires LLM)
 * 2. Scanning for trauma candidates (--trauma mode)
 * 3. JSON output format
 * 4. Error handling
 *
 * Uses isolated temp directories and mocked dependencies.
 */
import { describe, it, expect } from "bun:test";
import { writeFile } from "node:fs/promises";

import { auditCommand } from "../src/commands/audit.js";
import { withTempCassHome } from "./helpers/temp.js";
import { createTestBullet, createTestPlaybook, createTestConfig } from "./helpers/factories.js";
import { savePlaybook } from "../src/playbook.js";
import { createE2ELogger } from "./helpers/e2e-logger.js";
import type { CassRunner } from "../src/cass.js";
import type { LLMIO } from "../src/llm.js";

// --- Helper Functions ---

/**
 * Helper to capture console output during command execution.
 */
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
    all: () => [...logs, ...errors].join("\n"),
    restore: () => {
      console.log = originalLog;
      console.error = originalError;
    }
  };
}

/**
 * Creates a mock CassRunner that returns specified timeline and export data.
 */
function createMockCassRunner(options: {
  timeline?: object;
  exportContent?: string;
  searchResults?: object[];
}): CassRunner {
  const timeline = options.timeline ?? {
    groups: [{
      date: "2025-01-01",
      sessions: [{ path: "/sessions/test.jsonl", agent: "claude" }]
    }]
  };
  const exportContent = options.exportContent ?? "# Test session content";
  const searchResults = options.searchResults ?? [];

  return {
    execFile: async (file: string, args: string[]) => {
      const command = args[0] || "";

      if (command === "timeline") {
        return { stdout: JSON.stringify(timeline), stderr: "" };
      }
      if (command === "export") {
        return { stdout: exportContent, stderr: "" };
      }
      if (command === "search") {
        return { stdout: JSON.stringify(searchResults), stderr: "" };
      }

      return { stdout: "", stderr: "" };
    },
    spawnSync: () => ({ status: 0, stdout: "", stderr: "" }),
    spawn: (() => {}) as any
  };
}

/**
 * Creates a mock LLMIO that returns specified audit results.
 */
function createMockLLMIO(results: {
  results: Array<{ ruleId: string; status: string; evidence: string }>;
  summary?: string;
}): LLMIO {
  return {
    generateObject: async <T>() => ({
      object: results as unknown as T,
      usage: { promptTokens: 100, completionTokens: 50 }
    })
  };
}

// --- Test Suites ---

describe("E2E: CLI audit command", () => {
  describe("audit --trauma mode", () => {
    it("finds no trauma candidates when sessions are clean", async () => {
      const log = createE2ELogger("audit --trauma: clean sessions");
      await log.run(async () => {
        await withTempCassHome(async (env) => {
          log.step("Setup: Create config and playbook");

          const config = createTestConfig({
            playbookPath: env.playbookPath,
            cassPath: "cass"
          });
          await writeFile(env.configPath, JSON.stringify(config));
          await savePlaybook(createTestPlaybook([]), env.playbookPath);

          // Mock cass runner with clean session content (no dangerous patterns)
          const cassRunner = createMockCassRunner({
            exportContent: "This is a normal session with no dangerous commands."
          });

          log.step("Execute: Run audit --trauma");
          const capture = captureConsole();
          try {
            await auditCommand(
              { days: 7, trauma: true, json: false },
              { cassRunner }
            );
          } finally {
            capture.restore();
          }

          log.step("Verify: Should find no traumas");
          const output = capture.all();
          log.snapshot("output", output);

          expect(output).toContain("No potential traumas found");
        });
      });
    });

    it("finds trauma candidates when dangerous patterns exist", async () => {
      const log = createE2ELogger("audit --trauma: dangerous patterns");
      await log.run(async () => {
        await withTempCassHome(async (env) => {
          log.step("Setup: Create config and playbook");

          const config = createTestConfig({
            playbookPath: env.playbookPath,
            cassPath: "cass"
          });
          await writeFile(env.configPath, JSON.stringify(config));
          await savePlaybook(createTestPlaybook([]), env.playbookPath);

          // Mock cass runner with dangerous patterns in session content
          const cassRunner = createMockCassRunner({
            exportContent: `
              User: Let me clean up the system
              Assistant: I'll help clean up.
              $ rm -rf /home/user/important
              This removed the important files.
              $ git push --force
              Force pushed to main.
            `
          });

          log.step("Execute: Run audit --trauma");
          const capture = captureConsole();
          try {
            await auditCommand(
              { days: 7, trauma: true, json: false },
              { cassRunner }
            );
          } finally {
            capture.restore();
          }

          log.step("Verify: Should find trauma candidates");
          const output = capture.all();
          log.snapshot("output", output);

          // Should find rm -rf or git push --force patterns
          expect(output).toMatch(/candidate|trauma|TRAUMA/i);
        });
      });
    });

    it("outputs JSON format for trauma scan", async () => {
      const log = createE2ELogger("audit --trauma --json");
      await log.run(async () => {
        await withTempCassHome(async (env) => {
          log.step("Setup: Create config and playbook");

          const config = createTestConfig({
            playbookPath: env.playbookPath,
            cassPath: "cass"
          });
          await writeFile(env.configPath, JSON.stringify(config));
          await savePlaybook(createTestPlaybook([]), env.playbookPath);

          const cassRunner = createMockCassRunner({
            exportContent: "Normal session content."
          });

          log.step("Execute: Run audit --trauma --json");
          const capture = captureConsole();
          try {
            await auditCommand(
              { days: 7, trauma: true, json: true },
              { cassRunner }
            );
          } finally {
            capture.restore();
          }

          log.step("Verify: Output is valid JSON");
          const output = capture.all();
          log.snapshot("output", output);

          const parsed = JSON.parse(output);
          expect(parsed.command).toBe("audit");
          expect(parsed.success).toBe(true);
          expect(parsed.data).toHaveProperty("candidates");
          expect(Array.isArray(parsed.data.candidates)).toBe(true);
        });
      });
    });
  });

  describe("audit (normal mode with LLM)", () => {
    it("scans sessions and finds no violations", async () => {
      const log = createE2ELogger("audit: no violations");
      await log.run(async () => {
        await withTempCassHome(async (env) => {
          log.step("Setup: Create config, playbook, and mocks");

          const bullet = createTestBullet({
            id: "b-test-rule",
            content: "Always use TypeScript strict mode",
            maturity: "proven"
          });
          const config = createTestConfig({
            playbookPath: env.playbookPath,
            cassPath: "cass",
            apiKey: "test-api-key"
          });
          await writeFile(env.configPath, JSON.stringify(config));
          await savePlaybook(createTestPlaybook([bullet]), env.playbookPath);

          const cassRunner = createMockCassRunner({
            timeline: {
              groups: [{
                date: "2025-01-01",
                sessions: [{ path: "/sessions/s1.jsonl", agent: "claude" }]
              }]
            },
            exportContent: "Session with strict TypeScript code."
          });

          const io = createMockLLMIO({
            results: [
              { ruleId: "b-test-rule", status: "followed", evidence: "Strict mode was used" }
            ]
          });

          log.step("Execute: Run audit");
          const capture = captureConsole();
          try {
            await auditCommand(
              { days: 7, json: false },
              { cassRunner, io }
            );
          } finally {
            capture.restore();
          }

          log.step("Verify: Should report 0 violations");
          const output = capture.all();
          log.snapshot("output", output);

          expect(output).toContain("Violations found: 0");
        });
      });
    });

    it("scans sessions and finds violations", async () => {
      const log = createE2ELogger("audit: with violations");
      await log.run(async () => {
        await withTempCassHome(async (env) => {
          log.step("Setup: Create config, playbook, and mocks");

          const bullet = createTestBullet({
            id: "b-strict-mode",
            content: "Always use TypeScript strict mode",
            maturity: "proven"
          });
          const config = createTestConfig({
            playbookPath: env.playbookPath,
            cassPath: "cass",
            apiKey: "test-api-key"
          });
          await writeFile(env.configPath, JSON.stringify(config));
          await savePlaybook(createTestPlaybook([bullet]), env.playbookPath);

          const cassRunner = createMockCassRunner({
            timeline: {
              groups: [{
                date: "2025-01-01",
                sessions: [{ path: "/sessions/violation.jsonl", agent: "claude" }]
              }]
            },
            exportContent: "Session where strict mode was not used."
          });

          const io = createMockLLMIO({
            results: [
              {
                ruleId: "b-strict-mode",
                status: "violated",
                evidence: "TypeScript config had strict: false"
              }
            ]
          });

          log.step("Execute: Run audit");
          const capture = captureConsole();
          try {
            await auditCommand(
              { days: 7, json: false },
              { cassRunner, io }
            );
          } finally {
            capture.restore();
          }

          log.step("Verify: Should find the violation");
          const output = capture.all();
          log.snapshot("output", output);

          expect(output).toContain("Violations found: 1");
          expect(output.toUpperCase()).toContain("HIGH");
          expect(output).toContain("b-strict-mode");
        });
      });
    });

    it("outputs JSON format for audit results", async () => {
      const log = createE2ELogger("audit --json");
      await log.run(async () => {
        await withTempCassHome(async (env) => {
          log.step("Setup: Create config, playbook, and mocks");

          const bullet = createTestBullet({
            id: "b-test-json",
            content: "Test rule for JSON output",
            maturity: "candidate"
          });
          const config = createTestConfig({
            playbookPath: env.playbookPath,
            cassPath: "cass",
            apiKey: "test-api-key"
          });
          await writeFile(env.configPath, JSON.stringify(config));
          await savePlaybook(createTestPlaybook([bullet]), env.playbookPath);

          const cassRunner = createMockCassRunner({
            timeline: {
              groups: [{
                date: "2025-01-01",
                sessions: [{ path: "/sessions/s1.jsonl", agent: "claude" }]
              }]
            },
            exportContent: "Test session content."
          });

          const io = createMockLLMIO({
            results: [
              {
                ruleId: "b-test-json",
                status: "violated",
                evidence: "Rule was not followed"
              }
            ]
          });

          log.step("Execute: Run audit --json");
          const capture = captureConsole();
          try {
            await auditCommand(
              { days: 7, json: true },
              { cassRunner, io }
            );
          } finally {
            capture.restore();
          }

          log.step("Verify: Output is valid JSON with expected structure");
          const output = capture.all();
          log.snapshot("output", output);

          const parsed = JSON.parse(output);
          expect(parsed.command).toBe("audit");
          expect(parsed.success).toBe(true);
          expect(parsed.data).toHaveProperty("violations");
          expect(parsed.data).toHaveProperty("stats");
          expect(parsed.data.stats).toHaveProperty("sessionsScanned");
          expect(parsed.data.stats).toHaveProperty("rulesChecked");
          expect(parsed.data.stats).toHaveProperty("violationsFound");
          expect(parsed.data.stats).toHaveProperty("bySeverity");
        });
      });
    });
  });

  describe("error handling", () => {
    it("handles no sessions gracefully", async () => {
      const log = createE2ELogger("audit: no sessions");
      await log.run(async () => {
        await withTempCassHome(async (env) => {
          log.step("Setup: Create config with empty timeline");

          const config = createTestConfig({
            playbookPath: env.playbookPath,
            cassPath: "cass",
            apiKey: "test-api-key"
          });
          await writeFile(env.configPath, JSON.stringify(config));
          await savePlaybook(createTestPlaybook([]), env.playbookPath);

          const cassRunner = createMockCassRunner({
            timeline: { groups: [] }
          });

          log.step("Execute: Run audit");
          const capture = captureConsole();
          try {
            await auditCommand(
              { days: 7, json: false },
              { cassRunner }
            );
          } finally {
            capture.restore();
          }

          log.step("Verify: Should handle empty timeline gracefully");
          const output = capture.all();
          log.snapshot("output", output);

          expect(output).toMatch(/no sessions|No sessions/i);
        });
      });
    });

    it("handles no sessions with JSON output", async () => {
      const log = createE2ELogger("audit: no sessions --json");
      await log.run(async () => {
        await withTempCassHome(async (env) => {
          log.step("Setup: Create config with empty timeline");

          const config = createTestConfig({
            playbookPath: env.playbookPath,
            cassPath: "cass",
            apiKey: "test-api-key"
          });
          await writeFile(env.configPath, JSON.stringify(config));
          await savePlaybook(createTestPlaybook([]), env.playbookPath);

          const cassRunner = createMockCassRunner({
            timeline: { groups: [] }
          });

          log.step("Execute: Run audit --json");
          const capture = captureConsole();
          try {
            await auditCommand(
              { days: 7, json: true },
              { cassRunner }
            );
          } finally {
            capture.restore();
          }

          log.step("Verify: JSON output shows empty results");
          const output = capture.all();
          log.snapshot("output", output);

          const parsed = JSON.parse(output);
          expect(parsed.success).toBe(true);
          expect(parsed.data.stats.sessionsScanned).toBe(0);
          expect(parsed.data.violations).toEqual([]);
        });
      });
    });

    it("rejects invalid days parameter", async () => {
      const log = createE2ELogger("audit: invalid days");
      await log.run(async () => {
        await withTempCassHome(async (env) => {
          log.step("Setup: Create basic config");

          const config = createTestConfig({
            playbookPath: env.playbookPath,
            cassPath: "cass"
          });
          await writeFile(env.configPath, JSON.stringify(config));
          await savePlaybook(createTestPlaybook([]), env.playbookPath);

          log.step("Execute: Run audit with invalid days");
          const capture = captureConsole();
          try {
            await auditCommand(
              { days: -5, json: false },
              {}
            );
          } finally {
            capture.restore();
          }

          log.step("Verify: Should show error for invalid days");
          const output = capture.all();
          log.snapshot("output", output);

          expect(output.toLowerCase()).toContain("error");
          expect(output).toMatch(/days|invalid/i);
        });
      });
    });

    it("rejects invalid days parameter with JSON output", async () => {
      const log = createE2ELogger("audit: invalid days --json");
      await log.run(async () => {
        await withTempCassHome(async (env) => {
          log.step("Setup: Create basic config");

          const config = createTestConfig({
            playbookPath: env.playbookPath,
            cassPath: "cass"
          });
          await writeFile(env.configPath, JSON.stringify(config));
          await savePlaybook(createTestPlaybook([]), env.playbookPath);

          log.step("Execute: Run audit --json with invalid days");
          const capture = captureConsole();
          try {
            await auditCommand(
              { days: 0, json: true },
              {}
            );
          } finally {
            capture.restore();
          }

          log.step("Verify: JSON error output");
          const output = capture.all();
          log.snapshot("output", output);

          const parsed = JSON.parse(output);
          expect(parsed.success).toBe(false);
          expect(parsed.error).toBeDefined();
        });
      });
    });

    it("handles missing timeline gracefully", async () => {
      const log = createE2ELogger("audit: null timeline");
      await log.run(async () => {
        await withTempCassHome(async (env) => {
          log.step("Setup: Create config with null timeline response");

          const config = createTestConfig({
            playbookPath: env.playbookPath,
            cassPath: "cass",
            apiKey: "test-api-key"
          });
          await writeFile(env.configPath, JSON.stringify(config));
          await savePlaybook(createTestPlaybook([]), env.playbookPath);

          // Simulate timeline returning null/undefined
          const cassRunner: CassRunner = {
            execFile: async (file: string, args: string[]) => {
              const command = args[0] || "";
              if (command === "timeline") {
                return { stdout: "null", stderr: "" };
              }
              return { stdout: "", stderr: "" };
            },
            spawnSync: () => ({ status: 0, stdout: "", stderr: "" }),
            spawn: (() => {}) as any
          };

          log.step("Execute: Run audit");
          const capture = captureConsole();
          try {
            await auditCommand(
              { days: 7, json: false },
              { cassRunner }
            );
          } finally {
            capture.restore();
          }

          log.step("Verify: Should handle gracefully");
          const output = capture.all();
          log.snapshot("output", output);

          // Should not throw, should indicate no sessions
          expect(output).toMatch(/no session|No session/i);
        });
      });
    });
  });

  describe("days parameter", () => {
    it("uses default 7 days when not specified", async () => {
      const log = createE2ELogger("audit: default days");
      await log.run(async () => {
        await withTempCassHome(async (env) => {
          log.step("Setup: Create config");

          const config = createTestConfig({
            playbookPath: env.playbookPath,
            cassPath: "cass",
            apiKey: "test-api-key"
          });
          await writeFile(env.configPath, JSON.stringify(config));
          await savePlaybook(createTestPlaybook([]), env.playbookPath);

          const cassRunner = createMockCassRunner({
            timeline: { groups: [] }
          });

          log.step("Execute: Run audit without days");
          const capture = captureConsole();
          try {
            await auditCommand(
              { json: false },
              { cassRunner }
            );
          } finally {
            capture.restore();
          }

          log.step("Verify: Should use 7 days default");
          const output = capture.all();
          log.snapshot("output", output);

          // Output should mention 7 days (default)
          expect(output).toMatch(/7 days|last 7/i);
        });
      });
    });

    it("respects custom days parameter", async () => {
      const log = createE2ELogger("audit: custom days");
      await log.run(async () => {
        await withTempCassHome(async (env) => {
          log.step("Setup: Create config");

          const config = createTestConfig({
            playbookPath: env.playbookPath,
            cassPath: "cass",
            apiKey: "test-api-key"
          });
          await writeFile(env.configPath, JSON.stringify(config));
          await savePlaybook(createTestPlaybook([]), env.playbookPath);

          const cassRunner = createMockCassRunner({
            timeline: { groups: [] }
          });

          log.step("Execute: Run audit with 30 days");
          const capture = captureConsole();
          try {
            await auditCommand(
              { days: 30, json: false },
              { cassRunner }
            );
          } finally {
            capture.restore();
          }

          log.step("Verify: Should use 30 days");
          const output = capture.all();
          log.snapshot("output", output);

          expect(output).toMatch(/30 days|last 30/i);
        });
      });
    });
  });

  describe("severity classification", () => {
    it("classifies violations from proven rules as high severity", async () => {
      const log = createE2ELogger("audit: proven rule severity");
      await log.run(async () => {
        await withTempCassHome(async (env) => {
          log.step("Setup: Create proven rule");

          const bullet = createTestBullet({
            id: "b-proven-rule",
            content: "Critical security rule",
            maturity: "proven"
          });
          const config = createTestConfig({
            playbookPath: env.playbookPath,
            cassPath: "cass",
            apiKey: "test-api-key"
          });
          await writeFile(env.configPath, JSON.stringify(config));
          await savePlaybook(createTestPlaybook([bullet]), env.playbookPath);

          const cassRunner = createMockCassRunner({
            timeline: {
              groups: [{
                date: "2025-01-01",
                sessions: [{ path: "/sessions/s1.jsonl", agent: "claude" }]
              }]
            },
            exportContent: "Session content."
          });

          const io = createMockLLMIO({
            results: [
              { ruleId: "b-proven-rule", status: "violated", evidence: "Security issue" }
            ]
          });

          log.step("Execute: Run audit --json");
          const capture = captureConsole();
          try {
            await auditCommand(
              { days: 7, json: true },
              { cassRunner, io }
            );
          } finally {
            capture.restore();
          }

          log.step("Verify: Violation has high severity");
          const output = capture.all();
          const parsed = JSON.parse(output);

          expect(parsed.data.violations[0].severity).toBe("high");
          expect(parsed.data.stats.bySeverity.high).toBe(1);
        });
      });
    });

    it("classifies violations from candidate rules as medium severity", async () => {
      const log = createE2ELogger("audit: candidate rule severity");
      await log.run(async () => {
        await withTempCassHome(async (env) => {
          log.step("Setup: Create candidate rule");

          const bullet = createTestBullet({
            id: "b-candidate-rule",
            content: "New experimental rule",
            maturity: "candidate"
          });
          const config = createTestConfig({
            playbookPath: env.playbookPath,
            cassPath: "cass",
            apiKey: "test-api-key"
          });
          await writeFile(env.configPath, JSON.stringify(config));
          await savePlaybook(createTestPlaybook([bullet]), env.playbookPath);

          const cassRunner = createMockCassRunner({
            timeline: {
              groups: [{
                date: "2025-01-01",
                sessions: [{ path: "/sessions/s1.jsonl", agent: "claude" }]
              }]
            },
            exportContent: "Session content."
          });

          const io = createMockLLMIO({
            results: [
              { ruleId: "b-candidate-rule", status: "violated", evidence: "Rule not followed" }
            ]
          });

          log.step("Execute: Run audit --json");
          const capture = captureConsole();
          try {
            await auditCommand(
              { days: 7, json: true },
              { cassRunner, io }
            );
          } finally {
            capture.restore();
          }

          log.step("Verify: Violation has medium severity");
          const output = capture.all();
          const parsed = JSON.parse(output);

          expect(parsed.data.violations[0].severity).toBe("medium");
          expect(parsed.data.stats.bySeverity.medium).toBe(1);
        });
      });
    });
  });
});
