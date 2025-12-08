import { describe, it, expect, beforeEach, afterAll, spyOn } from "bun:test";
import {
  normalizeValidatorVerdict,
  evidenceCountGate,
  validateDelta,
} from "../src/validate.js";
import { ValidatorResult } from "../src/llm.js";
import { createTestBullet, createTestConfig } from "./helpers/factories.js";
import { PlaybookDelta, Config } from "../src/types.js";
import * as cassModule from "../src/cass.js";

// Create spy for safeCassSearch
let safeCassSearchSpy: ReturnType<typeof spyOn>;

describe("validate", () => {
  describe("normalizeValidatorVerdict", () => {
    it("returns result unchanged for ACCEPT verdict", () => {
      const input: ValidatorResult = {
        verdict: "ACCEPT",
        valid: true,
        confidence: 0.9,
        reason: "Strong evidence supports this rule",
        evidence: [],
      };

      const result = normalizeValidatorVerdict(input);

      expect(result.verdict).toBe("ACCEPT");
      expect(result.valid).toBe(true);
      expect(result.confidence).toBe(0.9);
    });

    it("returns result unchanged for REJECT verdict", () => {
      const input: ValidatorResult = {
        verdict: "REJECT",
        valid: false,
        confidence: 0.8,
        reason: "Evidence contradicts this rule",
        evidence: [],
      };

      const result = normalizeValidatorVerdict(input);

      expect(result.verdict).toBe("REJECT");
      expect(result.valid).toBe(false);
      expect(result.confidence).toBe(0.8);
    });

    it("converts REFINE to ACCEPT_WITH_CAUTION with reduced confidence", () => {
      const input: ValidatorResult = {
        verdict: "REFINE",
        valid: true,
        confidence: 1.0,
        reason: "Rule needs refinement",
        evidence: [],
      };

      const result = normalizeValidatorVerdict(input);

      expect(result.verdict).toBe("ACCEPT_WITH_CAUTION");
      expect(result.valid).toBe(true);
      expect(result.confidence).toBe(0.8); // 1.0 * 0.8
    });

    it("applies 0.8 multiplier to confidence when converting REFINE", () => {
      const input: ValidatorResult = {
        verdict: "REFINE",
        valid: true,
        confidence: 0.5,
        reason: "Partial evidence",
        evidence: [],
      };

      const result = normalizeValidatorVerdict(input);

      expect(result.confidence).toBeCloseTo(0.4, 2); // 0.5 * 0.8
    });

    it("preserves evidence array when normalizing", () => {
      const evidence = [
        { sessionPath: "/path/1", snippet: "test", supports: true },
        { sessionPath: "/path/2", snippet: "test2", supports: false },
      ];
      const input: ValidatorResult = {
        verdict: "REFINE",
        valid: true,
        confidence: 0.9,
        reason: "Mixed evidence",
        evidence,
      };

      const result = normalizeValidatorVerdict(input);

      expect(result.evidence).toEqual(evidence);
    });

    it("preserves reason when normalizing REFINE", () => {
      const input: ValidatorResult = {
        verdict: "REFINE",
        valid: true,
        confidence: 0.7,
        reason: "Consider narrowing scope",
        evidence: [],
      };

      const result = normalizeValidatorVerdict(input);

      expect(result.reason).toBe("Consider narrowing scope");
    });

    it("returns result unchanged for ACCEPT_WITH_CAUTION verdict", () => {
      const input: ValidatorResult = {
        verdict: "ACCEPT_WITH_CAUTION",
        valid: true,
        confidence: 0.6,
        reason: "Proceed carefully",
        evidence: [],
      };

      const result = normalizeValidatorVerdict(input);

      expect(result.verdict).toBe("ACCEPT_WITH_CAUTION");
      expect(result.confidence).toBe(0.6);
    });
  });

  describe("evidenceCountGate", () => {
    let config: Config;

    beforeEach(() => {
      config = createTestConfig({
        validationEnabled: true,
        validationLookbackDays: 30,
      });
      // Use spyOn to mock safeCassSearch
      safeCassSearchSpy = spyOn(cassModule, "safeCassSearch");
    });

    it("returns passed=true with draft state when no evidence found", async () => {
      safeCassSearchSpy.mockResolvedValue([]);

      const result = await evidenceCountGate("test content for validation", config);

      expect(result.passed).toBe(true);
      expect(result.suggestedState).toBe("draft");
      expect(result.sessionCount).toBe(0);
      expect(result.reason).toContain("No historical evidence");
    });

    it("auto-accepts with active state when strong success signal (5+ successes, 0 failures)", async () => {
      safeCassSearchSpy.mockResolvedValue([
        { source_path: "/session1", snippet: "Successfully deployed the fix" },
        { source_path: "/session2", snippet: "Fixed the bug correctly" },
        { source_path: "/session3", snippet: "The issue was resolved" },
        { source_path: "/session4", snippet: "It's working now" },
        { source_path: "/session5", snippet: "Works correctly after the change" },
      ]);

      const result = await evidenceCountGate("deployment process", config);

      expect(result.passed).toBe(true);
      expect(result.suggestedState).toBe("active");
      expect(result.successCount).toBeGreaterThanOrEqual(5);
      expect(result.failureCount).toBe(0);
    });

    it("auto-rejects when strong failure signal (3+ failures, 0 successes)", async () => {
      safeCassSearchSpy.mockResolvedValue([
        { source_path: "/session1", snippet: "Failed to compile the code" },
        { source_path: "/session2", snippet: "Error: module not found" },
        { source_path: "/session3", snippet: "The build crashed during tests" },
      ]);

      const result = await evidenceCountGate("build process", config);

      expect(result.passed).toBe(false);
      expect(result.suggestedState).toBe("draft");
      expect(result.failureCount).toBeGreaterThanOrEqual(3);
      expect(result.successCount).toBe(0);
    });

    it("proceeds to LLM validation when evidence is ambiguous", async () => {
      safeCassSearchSpy.mockResolvedValue([
        { source_path: "/session1", snippet: "Successfully deployed" },
        { source_path: "/session2", snippet: "But then it crashed later" },
      ]);

      const result = await evidenceCountGate("deployment", config);

      expect(result.passed).toBe(true);
      expect(result.suggestedState).toBe("draft");
      expect(result.reason).toContain("ambiguous");
    });

    it("counts unique sessions correctly", async () => {
      safeCassSearchSpy.mockResolvedValue([
        { source_path: "/session1", snippet: "Successfully fixed" },
        { source_path: "/session1", snippet: "Works now" },
        { source_path: "/session2", snippet: "Resolved the issue" },
      ]);

      const result = await evidenceCountGate("fix", config);

      expect(result.sessionCount).toBe(2); // Only 2 unique sessions
    });

    // Test word boundary patterns
    describe("pattern matching", () => {
      it("detects 'fixed the bug' as success", async () => {
        safeCassSearchSpy.mockResolvedValue([
          { source_path: "/s1", snippet: "I fixed the bug" },
          { source_path: "/s2", snippet: "fixed the issue yesterday" },
          { source_path: "/s3", snippet: "fixed a typo" },
          { source_path: "/s4", snippet: "fixed this error" },
          { source_path: "/s5", snippet: "fixed it finally" },
        ]);

        const result = await evidenceCountGate("bug fix", config);
        expect(result.successCount).toBeGreaterThanOrEqual(5);
      });

      it("does NOT count 'fixed-width' as success (false positive prevention)", async () => {
        safeCassSearchSpy.mockResolvedValue([
          { source_path: "/s1", snippet: "Using fixed-width font" },
          { source_path: "/s2", snippet: "The fixed-point arithmetic" },
        ]);

        const result = await evidenceCountGate("font", config);
        expect(result.successCount).toBe(0);
      });

      it("detects 'failed to compile' as failure", async () => {
        safeCassSearchSpy.mockResolvedValue([
          { source_path: "/s1", snippet: "failed to compile" },
          { source_path: "/s2", snippet: "failed with error" },
          { source_path: "/s3", snippet: "The process failed to start" },
        ]);

        const result = await evidenceCountGate("compile", config);
        expect(result.failureCount).toBeGreaterThanOrEqual(3);
      });

      it("detects error: prefix as failure", async () => {
        safeCassSearchSpy.mockResolvedValue([
          { source_path: "/s1", snippet: "error: cannot find module" },
          { source_path: "/s2", snippet: "Error: timeout" },
          { source_path: "/s3", snippet: "ERROR: invalid input" },
        ]);

        const result = await evidenceCountGate("module", config);
        expect(result.failureCount).toBe(3);
      });

      it("detects crash variations as failure", async () => {
        safeCassSearchSpy.mockResolvedValue([
          { source_path: "/s1", snippet: "the app crashed" },
          { source_path: "/s2", snippet: "it crashes on startup" },
          { source_path: "/s3", snippet: "crashing intermittently" },
        ]);

        const result = await evidenceCountGate("app", config);
        expect(result.failureCount).toBe(3);
      });
    });
  });

  describe("validateDelta", () => {
    let config: Config;

    beforeEach(() => {
      config = createTestConfig({
        validationEnabled: true,
        validationLookbackDays: 30,
      });
      safeCassSearchSpy = spyOn(cassModule, "safeCassSearch");
    });

    it("skips validation for non-add deltas", async () => {
      const delta: PlaybookDelta = {
        type: "update",
        bulletId: "test-123",
        changes: { maturity: "established" },
      };

      const result = await validateDelta(delta, config);

      expect(result.valid).toBe(true);
      expect(result.result).toBeUndefined();
      expect(result.gate).toBeUndefined();
    });

    it("skips validation when validationEnabled is false", async () => {
      const disabledConfig = createTestConfig({ validationEnabled: false });
      const delta: PlaybookDelta = {
        type: "add",
        bullet: createTestBullet({ content: "A new rule to validate" }),
      };

      const result = await validateDelta(delta, disabledConfig);

      expect(result.valid).toBe(true);
    });

    it("skips validation for content shorter than 20 characters", async () => {
      const delta: PlaybookDelta = {
        type: "add",
        bullet: createTestBullet({ content: "Short" }),
      };

      const result = await validateDelta(delta, config);

      expect(result.valid).toBe(true);
    });

    it("uses gate result for strong success signal", async () => {
      safeCassSearchSpy.mockResolvedValue([
        { source_path: "/s1", snippet: "Successfully implemented" },
        { source_path: "/s2", snippet: "Fixed the issue" },
        { source_path: "/s3", snippet: "Resolved correctly" },
        { source_path: "/s4", snippet: "Works now after fix" },
        { source_path: "/s5", snippet: "Successfully deployed" },
      ]);

      const delta: PlaybookDelta = {
        type: "add",
        bullet: createTestBullet({
          content: "Always validate input before processing to prevent errors",
        }),
      };

      const result = await validateDelta(delta, config);

      expect(result.valid).toBe(true);
      expect(result.gate?.suggestedState).toBe("active");
      expect(result.result?.verdict).toBe("ACCEPT");
      expect(result.result?.confidence).toBe(1.0);
    });

    it("rejects when gate detects strong failure signal", async () => {
      safeCassSearchSpy.mockResolvedValue([
        { source_path: "/s1", snippet: "Failed to compile" },
        { source_path: "/s2", snippet: "Error: type mismatch" },
        { source_path: "/s3", snippet: "The test crashed" },
      ]);

      const delta: PlaybookDelta = {
        type: "add",
        bullet: createTestBullet({
          content: "Use this specific approach for type handling in the codebase",
        }),
      };

      const result = await validateDelta(delta, config);

      expect(result.valid).toBe(false);
      expect(result.gate?.passed).toBe(false);
    });
  });
});
