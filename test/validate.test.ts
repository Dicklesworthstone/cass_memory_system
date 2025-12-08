import { describe, it, expect } from "bun:test";
import { normalizeValidatorVerdict } from "../src/validate";
import type { ValidatorResult } from "../src/llm";

describe("normalizeValidatorVerdict", () => {
  it("maps REFINE to ACCEPT_WITH_CAUTION and keeps it valid with reduced confidence", () => {
    const llmResult: ValidatorResult = {
      valid: false,
      verdict: "REFINE",
      confidence: 0.9,
      reason: "needs refinement",
      evidence: [],
      suggestedRefinement: "Do it slightly differently"
    };

    const mapped = normalizeValidatorVerdict(llmResult);

    expect(mapped.verdict).toBe("ACCEPT_WITH_CAUTION");
    expect(mapped.valid).toBe(true);
    expect(mapped.confidence).toBeCloseTo(0.72, 2); // 0.9 * 0.8
  });

  it("keeps REJECT as invalid without confidence change", () => {
    const llmResult: ValidatorResult = {
      valid: false,
      verdict: "REJECT",
      confidence: 0.4,
      reason: "contradicting evidence",
      evidence: [],
      suggestedRefinement: undefined
    };

    const mapped = normalizeValidatorVerdict(llmResult);

    expect(mapped.verdict).toBe("REJECT");
    expect(mapped.valid).toBe(false);
    expect(mapped.confidence).toBe(0.4);
  });
});
