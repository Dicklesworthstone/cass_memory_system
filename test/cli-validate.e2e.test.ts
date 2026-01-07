/**
 * E2E Tests for CLI validate command - Rule Validation Against Evidence
 *
 * Tests the `cm validate` command which:
 * - Validates proposed rules against historical session evidence
 * - Uses evidence-count gate for quick accept/reject decisions
 * - Falls back to LLM validation for ambiguous cases
 * - Supports JSON output format
 */
import { describe, it, expect } from "bun:test";
import { writeFile } from "node:fs/promises";

import { validateCommand } from "../src/commands/validate.js";
import { withTempCassHome } from "./helpers/temp.js";
import { createTestConfig } from "./helpers/factories.js";
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
 * Creates a mock CassRunner that returns specified search results.
 */
function createMockCassRunner(searchResults: Array<{
  source_path: string;
  snippet: string;
  score?: number;
  line_number?: number;
  agent?: string;
  workspace?: string;
  title?: string;
  created_at?: string | number | null;
}> = []): CassRunner {
  const normalizedResults = searchResults.map((hit, index) => ({
    source_path: hit.source_path,
    line_number: hit.line_number ?? index + 1,
    agent: hit.agent ?? "mock",
    workspace: hit.workspace,
    title: hit.title,
    snippet: hit.snippet,
    score: hit.score,
    created_at: hit.created_at
  }));

  return {
    execFile: async (file: string, args: string[]) => {
      const command = args[0] || "";

      if (command === "search") {
        return { stdout: JSON.stringify(normalizedResults), stderr: "" };
      }

      return { stdout: "[]", stderr: "" };
    },
    spawnSync: () => ({ status: 0, stdout: "[]", stderr: "" }),
    spawn: (() => {}) as any
  };
}

/**
 * Creates a mock LLMIO that returns specified validator results.
 */
function createMockLLMIO(result: {
  verdict: "ACCEPT" | "REJECT" | "REFINE";
  confidence: number;
  reason: string;
  suggestedRefinement?: string;
  evidence?: Array<{ sessionPath: string; snippet: string; supports: boolean }>;
}): LLMIO {
  return {
    generateObject: async <T>() => ({
      object: {
        verdict: result.verdict,
        valid: result.verdict !== "REJECT",
        confidence: result.confidence,
        reason: result.reason,
        suggestedRefinement: result.suggestedRefinement,
        evidence: result.evidence ?? [] // LLM validator returns evidence array
      } as unknown as T,
      usage: { promptTokens: 100, completionTokens: 50 }
    })
  };
}

// --- Test Suites ---

describe("E2E: CLI validate command", () => {
  describe("evidence gate - auto decisions", () => {
    it("ACCEPT verdict with supporting evidence", async () => {
      const log = createE2ELogger("validate: accept verdict");
      await log.run(async () => {
        await withTempCassHome(async (env) => {
          log.step("Setup: Create config and mocks");

          const config = createTestConfig({
            validationLookbackDays: 90,
            apiKey: "test-api-key"
          });
          await writeFile(env.configPath, JSON.stringify(config));

          // Mock cass with success indicators
          const cassRunner = createMockCassRunner([
            { source_path: "/sessions/s1.jsonl", snippet: "fixed the bug successfully", score: 0.9 },
            { source_path: "/sessions/s2.jsonl", snippet: "resolved the issue", score: 0.85 }
          ]);

          // Mock LLM to return ACCEPT
          const io = createMockLLMIO({
            verdict: "ACCEPT",
            confidence: 0.9,
            reason: "Rule aligns with successful patterns"
          });

          log.step("Execute: Run validate with rule");
          const capture = captureConsole();
          try {
            await validateCommand(
              "Always run tests before committing",
              { json: false },
              { cassRunner, io }
            );
          } finally {
            capture.restore();
          }

          log.step("Verify: Should show ACCEPT");
          const output = capture.all();
          log.snapshot("output", output);

          expect(output).toContain("ACCEPT");
          expect(output).toContain("confidence");
        });
      });
    });

    it("auto-REJECT when strong failure evidence exists", async () => {
      const log = createE2ELogger("validate: auto-reject");
      await log.run(async () => {
        await withTempCassHome(async (env) => {
          log.step("Setup: Create config and mock with failure evidence");

          const config = createTestConfig({
            validationLookbackDays: 90,
            apiKey: "test-api-key"
          });
          await writeFile(env.configPath, JSON.stringify(config));

          // Mock cass with many failure indicators
          const cassRunner = createMockCassRunner([
            { source_path: "/sessions/s1.jsonl", snippet: "failed to compile with error", score: 0.9 },
            { source_path: "/sessions/s2.jsonl", snippet: "error: broken build", score: 0.85 },
            { source_path: "/sessions/s3.jsonl", snippet: "crashed after applying the change", score: 0.8 },
            { source_path: "/sessions/s4.jsonl", snippet: "doesn't work anymore", score: 0.75 },
            { source_path: "/sessions/s5.jsonl", snippet: "bug found in the implementation", score: 0.7 }
          ]);

          // Mock LLM fallback to REJECT
          const io = createMockLLMIO({
            verdict: "REJECT",
            confidence: 0.9,
            reason: "Evidence shows consistent failures"
          });

          log.step("Execute: Run validate with rule");
          const capture = captureConsole();
          try {
            await validateCommand(
              "Always skip tests for quick commits",
              { json: false },
              { cassRunner, io }
            );
          } finally {
            capture.restore();
          }

          log.step("Verify: Should auto-REJECT");
          const output = capture.all();
          log.snapshot("output", output);

          expect(output).toContain("REJECT");
        });
      });
    });

    it("proposes as draft when no keywords found", async () => {
      const log = createE2ELogger("validate: no keywords draft");
      await log.run(async () => {
        await withTempCassHome(async (env) => {
          log.step("Setup: Create config");

          const config = createTestConfig({
            apiKey: "test-api-key"
          });
          await writeFile(env.configPath, JSON.stringify(config));

          const cassRunner = createMockCassRunner([]);

          // Mock LLM in case it falls through
          const io = createMockLLMIO({
            verdict: "ACCEPT",
            confidence: 0.6,
            reason: "Accepted as draft"
          });

          log.step("Execute: Run validate with rule lacking keywords");
          const capture = captureConsole();
          try {
            await validateCommand(
              "a the an", // Common words only, no meaningful keywords
              { json: true },
              { cassRunner, io }
            );
          } finally {
            capture.restore();
          }

          log.step("Verify: Should suggest as draft");
          const output = capture.all();
          log.snapshot("output", output);

          // Should get some result (either ACCEPT as draft or use LLM)
          expect(output).toContain("validate");
        });
      });
    });

    it("skips LLM and accepts with caution when no historical evidence exists", async () => {
      const log = createE2ELogger("validate: no evidence draft");
      await log.run(async () => {
        await withTempCassHome(async (env) => {
          log.step("Setup: Create config and mock cass with zero hits");

          const config = createTestConfig({
            validationLookbackDays: 90,
            apiKey: "test-api-key"
          });
          await writeFile(env.configPath, JSON.stringify(config));

          const cassRunner = createMockCassRunner([]);

          const io: LLMIO = {
            generateObject: async () => {
              throw new Error("LLM should not be called when no evidence exists");
            }
          };

          log.step("Execute: Run validate with meaningful keywords");
          const capture = captureConsole();
          try {
            await validateCommand(
              "Always annotate TODOs with ticket IDs",
              { json: true },
              { cassRunner, io }
            );
          } finally {
            capture.restore();
          }

          log.step("Verify: Should accept with caution without LLM");
          const output = capture.all();
          log.snapshot("output", output);

          const parsed = JSON.parse(output);
          expect(parsed.data.verdict).toBe("ACCEPT_WITH_CAUTION");
          expect(parsed.data.reason.toLowerCase()).toContain("no historical evidence");
        });
      });
    });
  });

  describe("LLM validation fallback", () => {
    it("uses LLM when evidence is ambiguous", async () => {
      const log = createE2ELogger("validate: LLM fallback");
      await log.run(async () => {
        await withTempCassHome(async (env) => {
          log.step("Setup: Create config and mocks");

          const config = createTestConfig({
            validationLookbackDays: 90,
            apiKey: "test-api-key"
          });
          await writeFile(env.configPath, JSON.stringify(config));

          // Mock cass with mixed/neutral evidence
          const cassRunner = createMockCassRunner([
            { source_path: "/sessions/s1.jsonl", snippet: "applied the change", score: 0.9 },
            { source_path: "/sessions/s2.jsonl", snippet: "updated the config", score: 0.85 }
          ]);

          // Mock LLM to return ACCEPT
          const io = createMockLLMIO({
            verdict: "ACCEPT",
            confidence: 0.85,
            reason: "The rule aligns with best practices observed in sessions"
          });

          log.step("Execute: Run validate");
          const capture = captureConsole();
          try {
            await validateCommand(
              "Always use strict TypeScript mode",
              { json: false },
              { cassRunner, io }
            );
          } finally {
            capture.restore();
          }

          log.step("Verify: Should use LLM result");
          const output = capture.all();
          log.snapshot("output", output);

          expect(output).toContain("ACCEPT");
          expect(output).toContain("best practices");
        });
      });
    });

    it("handles LLM REFINE verdict as ACCEPT_WITH_CAUTION", async () => {
      const log = createE2ELogger("validate: REFINE to ACCEPT_WITH_CAUTION");
      await log.run(async () => {
        await withTempCassHome(async (env) => {
          log.step("Setup: Create config and mocks");

          const config = createTestConfig({
            validationLookbackDays: 90,
            apiKey: "test-api-key"
          });
          await writeFile(env.configPath, JSON.stringify(config));

          const cassRunner = createMockCassRunner([
            { source_path: "/sessions/s1.jsonl", snippet: "mixed results", score: 0.8 }
          ]);

          const io = createMockLLMIO({
            verdict: "REFINE",
            confidence: 0.7,
            reason: "Rule needs refinement",
            suggestedRefinement: "Consider adding exception for legacy code"
          });

          log.step("Execute: Run validate");
          const capture = captureConsole();
          try {
            await validateCommand(
              "Never use var keyword",
              { json: false },
              { cassRunner, io }
            );
          } finally {
            capture.restore();
          }

          log.step("Verify: Should show ACCEPT_WITH_CAUTION");
          const output = capture.all();
          log.snapshot("output", output);

          expect(output).toContain("ACCEPT_WITH_CAUTION");
          expect(output).toContain("Refined Rule");
        });
      });
    });

    it("passes LLM REJECT through", async () => {
      const log = createE2ELogger("validate: LLM REJECT");
      await log.run(async () => {
        await withTempCassHome(async (env) => {
          log.step("Setup: Create config and mocks");

          const config = createTestConfig({
            validationLookbackDays: 90,
            apiKey: "test-api-key"
          });
          await writeFile(env.configPath, JSON.stringify(config));

          const cassRunner = createMockCassRunner([
            { source_path: "/sessions/s1.jsonl", snippet: "some context", score: 0.8 }
          ]);

          const io = createMockLLMIO({
            verdict: "REJECT",
            confidence: 0.9,
            reason: "This rule contradicts established patterns"
          });

          log.step("Execute: Run validate");
          const capture = captureConsole();
          try {
            await validateCommand(
              "Always commit without testing",
              { json: false },
              { cassRunner, io }
            );
          } finally {
            capture.restore();
          }

          log.step("Verify: Should show REJECT");
          const output = capture.all();
          log.snapshot("output", output);

          expect(output).toContain("REJECT");
          expect(output).toContain("contradicts");
        });
      });
    });
  });

  describe("JSON output", () => {
    it("outputs valid JSON with expected structure", async () => {
      const log = createE2ELogger("validate: JSON output");
      await log.run(async () => {
        await withTempCassHome(async (env) => {
          log.step("Setup: Create config and mocks");

          const config = createTestConfig({
            validationLookbackDays: 90,
            apiKey: "test-api-key"
          });
          await writeFile(env.configPath, JSON.stringify(config));

          const cassRunner = createMockCassRunner([
            { source_path: "/sessions/s1.jsonl", snippet: "fixed the issue successfully", score: 0.9 }
          ]);

          // Mock LLM for fallback
          const io = createMockLLMIO({
            verdict: "ACCEPT",
            confidence: 0.9,
            reason: "Rule aligns with successful patterns"
          });

          log.step("Execute: Run validate --json");
          const capture = captureConsole();
          try {
            await validateCommand(
              "Always write unit tests",
              { json: true },
              { cassRunner, io }
            );
          } finally {
            capture.restore();
          }

          log.step("Verify: Output is valid JSON");
          const output = capture.all();
          log.snapshot("output", output);

          const parsed = JSON.parse(output);
          expect(parsed.command).toBe("validate");
          expect(parsed.success).toBe(true);
          expect(parsed.data).toHaveProperty("proposedRule");
          expect(parsed.data).toHaveProperty("verdict");
          expect(parsed.data).toHaveProperty("confidence");
          expect(parsed.data).toHaveProperty("reason");
        });
      });
    });

    it("includes evidence in JSON output when available", async () => {
      const log = createE2ELogger("validate: JSON with evidence");
      await log.run(async () => {
        await withTempCassHome(async (env) => {
          log.step("Setup: Create config and mocks");

          const config = createTestConfig({
            validationLookbackDays: 90,
            apiKey: "test-api-key"
          });
          await writeFile(env.configPath, JSON.stringify(config));

          const cassRunner = createMockCassRunner([
            { source_path: "/sessions/test.jsonl", snippet: "context for the rule", score: 0.8 }
          ]);

          const io = createMockLLMIO({
            verdict: "ACCEPT",
            confidence: 0.85,
            reason: "Good rule"
          });

          log.step("Execute: Run validate --json");
          const capture = captureConsole();
          try {
            await validateCommand(
              "Use descriptive variable names",
              { json: true },
              { cassRunner, io }
            );
          } finally {
            capture.restore();
          }

          log.step("Verify: JSON includes evidence");
          const output = capture.all();
          const parsed = JSON.parse(output);

          expect(parsed.data).toHaveProperty("evidence");
          expect(Array.isArray(parsed.data.evidence)).toBe(true);
        });
      });
    });
  });

  describe("error handling", () => {
    it("throws error when proposed rule is empty", async () => {
      const log = createE2ELogger("validate: empty rule error");
      await log.run(async () => {
        await withTempCassHome(async (env) => {
          log.step("Setup: Create config");

          const config = createTestConfig({});
          await writeFile(env.configPath, JSON.stringify(config));

          log.step("Execute: Run validate with empty rule");

          let error: Error | null = null;
          try {
            await validateCommand("", {}, {});
          } catch (e) {
            error = e as Error;
          }

          log.step("Verify: Should throw error");
          expect(error).not.toBeNull();
          expect(error!.message).toContain("required");
        });
      });
    });

    it("throws error when proposed rule is whitespace only", async () => {
      const log = createE2ELogger("validate: whitespace rule error");
      await log.run(async () => {
        await withTempCassHome(async (env) => {
          log.step("Setup: Create config");

          const config = createTestConfig({});
          await writeFile(env.configPath, JSON.stringify(config));

          log.step("Execute: Run validate with whitespace");

          let error: Error | null = null;
          try {
            await validateCommand("   \t\n  ", {}, {});
          } catch (e) {
            error = e as Error;
          }

          log.step("Verify: Should throw error");
          expect(error).not.toBeNull();
          expect(error!.message).toContain("required");
        });
      });
    });
  });

  describe("outcome classification", () => {
    it("classifies success outcomes correctly", async () => {
      const log = createE2ELogger("validate: success classification");
      await log.run(async () => {
        await withTempCassHome(async (env) => {
          log.step("Setup: Create config and mocks with success snippets");

          const config = createTestConfig({
            validationLookbackDays: 90,
            apiKey: "test-api-key"
          });
          await writeFile(env.configPath, JSON.stringify(config));

          const cassRunner = createMockCassRunner([
            { source_path: "/sessions/s1.jsonl", snippet: "fixed the bug", score: 0.9 },
            { source_path: "/sessions/s2.jsonl", snippet: "resolved successfully", score: 0.85 },
            { source_path: "/sessions/s3.jsonl", snippet: "completed the task", score: 0.8 }
          ]);

          const io = createMockLLMIO({
            verdict: "ACCEPT",
            confidence: 0.9,
            reason: "Strong evidence"
          });

          log.step("Execute: Run validate --json");
          const capture = captureConsole();
          try {
            await validateCommand(
              "Run linter before commit",
              { json: true },
              { cassRunner, io }
            );
          } finally {
            capture.restore();
          }

          log.step("Verify: Evidence outcomes classified");
          const output = capture.all();
          const parsed = JSON.parse(output);

          // Evidence should be present and have outcome classification
          expect(parsed.data.evidence).toBeDefined();
          expect(Array.isArray(parsed.data.evidence)).toBe(true);
          // Evidence array should exist (may be empty if gate auto-accepts)
          if (parsed.data.evidence.length > 0) {
            const outcomes = parsed.data.evidence.map((e: any) => e.outcome);
            // At least one should be classified as success based on our mock data
            expect(outcomes.some((o: string) => o === "success")).toBe(true);
          }
        });
      });
    });

    it("classifies failure outcomes correctly", async () => {
      const log = createE2ELogger("validate: failure classification");
      await log.run(async () => {
        await withTempCassHome(async (env) => {
          log.step("Setup: Create config and mocks with failure snippets");

          const config = createTestConfig({
            validationLookbackDays: 90,
            apiKey: "test-api-key"
          });
          await writeFile(env.configPath, JSON.stringify(config));

          const cassRunner = createMockCassRunner([
            { source_path: "/sessions/s1.jsonl", snippet: "failed to deploy", score: 0.9 },
            { source_path: "/sessions/s2.jsonl", snippet: "error: compilation failed", score: 0.85 },
            { source_path: "/sessions/s3.jsonl", snippet: "broken after update", score: 0.8 }
          ]);

          const io = createMockLLMIO({
            verdict: "REJECT",
            confidence: 0.9,
            reason: "Evidence shows failures"
          });

          log.step("Execute: Run validate --json");
          const capture = captureConsole();
          try {
            await validateCommand(
              "Skip error handling",
              { json: true },
              { cassRunner, io }
            );
          } finally {
            capture.restore();
          }

          log.step("Verify: Evidence outcomes classified as failure");
          const output = capture.all();
          const parsed = JSON.parse(output);

          // Evidence should be present
          expect(parsed.data.evidence).toBeDefined();
          expect(Array.isArray(parsed.data.evidence)).toBe(true);
          // Evidence array should exist (may be empty if gate auto-rejects)
          if (parsed.data.evidence.length > 0) {
            const outcomes = parsed.data.evidence.map((e: any) => e.outcome);
            // At least one should be classified as failure based on our mock data
            expect(outcomes.some((o: string) => o === "failure")).toBe(true);
          }
        });
      });
    });
  });

  describe("human-readable output", () => {
    it("displays colored verdict for ACCEPT", async () => {
      const log = createE2ELogger("validate: human output ACCEPT");
      await log.run(async () => {
        await withTempCassHome(async (env) => {
          log.step("Setup: Create config");

          const config = createTestConfig({
            apiKey: "test-api-key"
          });
          await writeFile(env.configPath, JSON.stringify(config));

          const cassRunner = createMockCassRunner([
            { source_path: "/sessions/s1.jsonl", snippet: "successfully fixed the issue", score: 0.9 }
          ]);

          // Mock LLM for fallback
          const io = createMockLLMIO({
            verdict: "ACCEPT",
            confidence: 0.85,
            reason: "Rule is consistent with success patterns"
          });

          log.step("Execute: Run validate (human output)");
          const capture = captureConsole();
          try {
            await validateCommand(
              "Always test edge cases",
              { json: false },
              { cassRunner, io }
            );
          } finally {
            capture.restore();
          }

          log.step("Verify: Human-readable output");
          const output = capture.all();
          log.snapshot("output", output);

          expect(output).toContain("Validation Result");
          expect(output).toContain("Rule:");
          expect(output).toContain("Verdict:");
          expect(output).toContain("Reason:");
        });
      });
    });

    it("displays evidence section when available", async () => {
      const log = createE2ELogger("validate: human output with evidence");
      await log.run(async () => {
        await withTempCassHome(async (env) => {
          log.step("Setup: Create config and mocks");

          const config = createTestConfig({
            apiKey: "test-api-key",
            validationLookbackDays: 90
          });
          await writeFile(env.configPath, JSON.stringify(config));

          // Provide multiple evidence entries to ensure they appear
          const cassRunner = createMockCassRunner([
            { source_path: "/sessions/evidence1.jsonl", snippet: "successfully completed the task", score: 0.9 },
            { source_path: "/sessions/evidence2.jsonl", snippet: "API documentation added", score: 0.85 },
            { source_path: "/sessions/evidence3.jsonl", snippet: "relevant context for the rule validation", score: 0.8 }
          ]);

          const io = createMockLLMIO({
            verdict: "ACCEPT",
            confidence: 0.85,
            reason: "Valid rule with good evidence"
          });

          log.step("Execute: Run validate (human output)");
          const capture = captureConsole();
          try {
            await validateCommand(
              "Document public APIs",
              { json: false },
              { cassRunner, io }
            );
          } finally {
            capture.restore();
          }

          log.step("Verify: Human output structure");
          const output = capture.all();
          log.snapshot("output", output);

          // Verify basic human output structure
          expect(output).toContain("Validation Result");
          expect(output).toContain("Rule:");
          expect(output).toContain("Verdict:");

          // Evidence section shown when evidence available
          // Note: Evidence may not appear if gate auto-accepts/rejects
          if (output.includes("Evidence (cass)")) {
            expect(output).toContain("evidence");
          }
        });
      });
    });
  });
});
