import { describe, expect, it } from "bun:test";
import { evidenceCountGate, normalizeValidatorVerdict, validateDelta } from "../src/validate.js";
import type { CassRunner } from "../src/cass.js";
import { createTestConfig } from "./helpers/factories.js";
import { withTempDir } from "./helpers/temp.js";
import type { PlaybookDelta, NewBulletData } from "../src/types.js";

function createCassRunnerForSearch(stdout: string): CassRunner {
  return {
    execFile: async (_file, args) => {
      const cmd = args[0] ?? "";
      if (cmd !== "search") throw new Error(`Unexpected cass execFile command: ${cmd}`);
      return { stdout, stderr: "" };
    },
    spawnSync: () => ({ status: 0, stdout: "", stderr: "" }),
    spawn: (() => {
      throw new Error("spawn not implemented in cass runner stub");
    }) as any,
  };
}

describe("validate.ts evidence gate", () => {
  it("normalizes REFINE verdict to ACCEPT_WITH_CAUTION", () => {
    const input = {
      valid: false,
      verdict: "REFINE",
      confidence: 0.9,
      reason: "Needs adjustments",
      evidence: [],
    } as any;

    const normalized = normalizeValidatorVerdict(input);
    expect(normalized.valid).toBe(true);
    expect(normalized.verdict).toBe("ACCEPT_WITH_CAUTION");
    expect(normalized.confidence).toBeCloseTo(0.72);
  });

  it("returns draft when no meaningful keywords exist (avoids empty cass query)", async () => {
    const config = createTestConfig();
    const result = await evidenceCountGate("the and the and the and the and", config);

    expect(result.passed).toBe(true);
    expect(result.suggestedState).toBe("draft");
    expect(result.sessionCount).toBe(0);
    expect(result.reason).toContain("No meaningful keywords");
  });

  it("counts unique sessions (not hits) for success/failure signals", async () => {
    await withTempDir("validate-gate-unique-sessions", async (dir) => {
      const hits = [
        { source_path: "s1.jsonl", line_number: 1, snippet: "fixed the bug", agent: "stub", score: 0.9 },
        { source_path: "s1.jsonl", line_number: 2, snippet: "fixed the bug", agent: "stub", score: 0.9 },
        { source_path: "s1.jsonl", line_number: 3, snippet: "fixed the bug", agent: "stub", score: 0.9 },
        { source_path: "s1.jsonl", line_number: 4, snippet: "fixed the bug", agent: "stub", score: 0.9 },
        { source_path: "s1.jsonl", line_number: 5, snippet: "fixed the bug", agent: "stub", score: 0.9 },
        { source_path: "s2.jsonl", line_number: 1, snippet: "nothing relevant", agent: "stub", score: 0.1 },
      ];

      const runner = createCassRunnerForSearch(JSON.stringify(hits));
      const config = createTestConfig({ cassPath: "cass" });

      const result = await evidenceCountGate("Validate user input before processing requests", config, runner);

      expect(result.sessionCount).toBe(2);
      expect(result.successCount).toBe(1);
      expect(result.failureCount).toBe(0);
      expect(result.passed).toBe(true);
      expect(result.suggestedState).toBe("draft");
      expect(result.reason).toContain("ambiguous");
    });
  });

  it("auto-rejects on failure signals across unique sessions", async () => {
    await withTempDir("validate-gate-failure-sessions", async (dir) => {
      const hits = [
        { source_path: "s1.jsonl", line_number: 1, snippet: "failed to compile", agent: "stub", score: 0.9 },
        { source_path: "s1.jsonl", line_number: 2, snippet: "failed to compile", agent: "stub", score: 0.9 },
        { source_path: "s2.jsonl", line_number: 1, snippet: "crashed with error", agent: "stub", score: 0.9 },
        { source_path: "s3.jsonl", line_number: 1, snippet: "doesn't work", agent: "stub", score: 0.9 },
      ];

      const runner = createCassRunnerForSearch(JSON.stringify(hits));
      const config = createTestConfig({ cassPath: "cass" });

      const result = await evidenceCountGate("Always use var for everything in TypeScript code", config, runner);

      expect(result.sessionCount).toBe(3);
      expect(result.successCount).toBe(0);
      expect(result.failureCount).toBe(3);
      expect(result.passed).toBe(false);
      expect(result.reason).toContain("Strong failure signal");
    });
  });

  it("auto-accepts on strong success signals across unique sessions", async () => {
    await withTempDir("validate-gate-success-sessions", async () => {
      const hits = [
        { source_path: "s1.jsonl", line_number: 1, snippet: "fixed the bug", agent: "stub", score: 0.9 },
        { source_path: "s2.jsonl", line_number: 1, snippet: "solved the issue", agent: "stub", score: 0.9 },
        { source_path: "s3.jsonl", line_number: 1, snippet: "works correctly", agent: "stub", score: 0.9 },
        { source_path: "s4.jsonl", line_number: 1, snippet: "resolved", agent: "stub", score: 0.9 },
        { source_path: "s5.jsonl", line_number: 1, snippet: "working now", agent: "stub", score: 0.9 },
      ];

      const runner = createCassRunnerForSearch(JSON.stringify(hits));
      const config = createTestConfig({ cassPath: "cass" });

      const result = await evidenceCountGate("Validate user input before processing requests", config, runner);

      expect(result.sessionCount).toBe(5);
      expect(result.successCount).toBe(5);
      expect(result.failureCount).toBe(0);
      expect(result.passed).toBe(true);
      expect(result.suggestedState).toBe("active");
      expect(result.reason).toContain("Auto-accepting");
    });
  });

  it("does not treat fixed-width as a success signal", async () => {
    await withTempDir("validate-gate-fixed-width", async () => {
      const hits = [
        { source_path: "s1.jsonl", line_number: 1, snippet: "fixed-width encoding", agent: "stub", score: 0.9 },
      ];

      const runner = createCassRunnerForSearch(JSON.stringify(hits));
      const config = createTestConfig({ cassPath: "cass" });

      const result = await evidenceCountGate("Investigate fixed-width parsing", config, runner);

      expect(result.sessionCount).toBe(1);
      expect(result.successCount).toBe(0);
      expect(result.failureCount).toBe(0);
      expect(result.passed).toBe(true);
      expect(result.suggestedState).toBe("draft");
      expect(result.reason).toContain("ambiguous");
    });
  });
});

describe("validateDelta", () => {
  function createAddDelta(content: string): PlaybookDelta {
    const bullet: NewBulletData = {
      content,
      category: "testing"
    };
    return {
      type: "add",
      bullet,
      reason: "test",
      sourceSession: "/tmp/session.jsonl"
    };
  }

  function createHelpfulDelta(): PlaybookDelta {
    return {
      type: "helpful",
      bulletId: "b-test-1",
      sourceSession: "/tmp/session.jsonl"
    };
  }

  function createReplaceDelta(newContent: string): PlaybookDelta {
    return {
      type: "replace",
      bulletId: "b-test-1",
      newContent,
      reason: "test"
    };
  }

  it("skips validation for non-add delta types", async () => {
    const config = createTestConfig({ validationEnabled: true });
    const delta = createHelpfulDelta();

    const result = await validateDelta(delta, config);

    expect(result.valid).toBe(true);
    expect(result.decisionLog).toBeDefined();
    expect(result.decisionLog![0].action).toBe("skipped");
    expect(result.decisionLog![0].reason).toContain("Non-add delta type");
  });

  it("skips validation when validation is disabled in config", async () => {
    const config = createTestConfig({ validationEnabled: false });
    const delta = createAddDelta("Always validate user input before processing");

    const result = await validateDelta(delta, config);

    expect(result.valid).toBe(true);
    expect(result.decisionLog).toBeDefined();
    expect(result.decisionLog![0].action).toBe("skipped");
    expect(result.decisionLog![0].reason).toContain("Validation disabled");
  });

  it("skips validation for content shorter than 15 characters", async () => {
    const config = createTestConfig({ validationEnabled: true });
    const delta = createAddDelta("short");

    const result = await validateDelta(delta, config);

    expect(result.valid).toBe(true);
    expect(result.decisionLog).toBeDefined();
    expect(result.decisionLog![0].action).toBe("skipped");
    expect(result.decisionLog![0].reason).toContain("Content too short");
  });

  it("skips validation when bullet content is empty", async () => {
    const config = createTestConfig({ validationEnabled: true });
    const delta = createAddDelta("");

    const result = await validateDelta(delta, config);

    expect(result.valid).toBe(true);
    expect(result.decisionLog).toBeDefined();
    expect(result.decisionLog![0].action).toBe("skipped");
    expect(result.decisionLog![0].reason).toContain("Content too short");
  });

  it("logs content preview in decision log for disabled validation", async () => {
    const config = createTestConfig({ validationEnabled: false });
    const delta = createAddDelta("Always validate user input before processing requests");

    const result = await validateDelta(delta, config);

    expect(result.valid).toBe(true);
    expect(result.decisionLog).toBeDefined();
    const decisionLog = result.decisionLog ?? [];
    expect(decisionLog[0]?.content).toBe("Always validate user input before processing requests");
  });

  it("includes decision log for replace delta type", async () => {
    const config = createTestConfig({ validationEnabled: true });
    const delta = createReplaceDelta("Update this content");

    const result = await validateDelta(delta, config);

    expect(result.valid).toBe(true);
    expect(result.decisionLog).toBeArray();
    const decisionLog = result.decisionLog ?? [];
    expect(decisionLog.length).toBeGreaterThan(0);
    expect(decisionLog[0]?.phase).toBe("add");
    expect(decisionLog[0]?.timestamp).toBeString();
  });
});
