import { describe, it, expect } from "bun:test";
import { checkForDemotion } from "../src/scoring.js";
import { createTestBullet, createTestConfig, createTestFeedbackEvent } from "./helpers/factories.js";

describe("Scoring Thresholds", () => {
  it("does not auto-deprecate on a single failure with default config", () => {
    const config = createTestConfig({ 
        // Explicitly set defaults to match updated config
        pruneHarmfulThreshold: 10,
        scoring: { harmfulMultiplier: 4, decayHalfLifeDays: 90 } 
    } as any);

    const bullet = createTestBullet({
      feedbackEvents: [
        createTestFeedbackEvent("harmful", { timestamp: new Date().toISOString() })
      ]
    });

    // Score should be approx -4. 
    // -4 is NOT < -10.
    expect(checkForDemotion(bullet, config)).not.toBe("auto-deprecate");
  });

  it("auto-deprecates on 3 failures (score -12 < -10)", () => {
    const config = createTestConfig({ 
        pruneHarmfulThreshold: 10,
        scoring: { harmfulMultiplier: 4, decayHalfLifeDays: 90 } 
    } as any);

    const bullet = createTestBullet({
      feedbackEvents: [
        createTestFeedbackEvent("harmful", { timestamp: new Date().toISOString() }),
        createTestFeedbackEvent("harmful", { timestamp: new Date().toISOString() }),
        createTestFeedbackEvent("harmful", { timestamp: new Date().toISOString() })
      ]
    });

    expect(checkForDemotion(bullet, config)).toBe("auto-deprecate");
  });
});
