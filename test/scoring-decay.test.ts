import { describe, test, expect } from "bun:test";
import {
  calculateDecayedValue,
  getDecayedCounts,
  getEffectiveScore,
  calculateMaturityState,
  checkForPromotion,
  checkForDemotion,
  isStale,
  analyzeScoreDistribution
} from "../src/scoring.js";
import { createTestBullet, createTestConfig, createTestFeedbackEvent } from "./helpers/factories.js";

describe("Confidence Decay", () => {
  const config = createTestConfig();

  // Helper to create date strings relative to now
  const now = Date.now();
  const daysAgo = (d: number) => new Date(now - (d * 24 * 60 * 60 * 1000)).toISOString();
  const daysFromNow = (d: number) => new Date(now + (d * 24 * 60 * 60 * 1000)).toISOString();

  describe("calculateDecayedValue", () => {
    test("should return 1.0 for recent events", () => {
      const event = createTestFeedbackEvent("helpful", 0);
      const value = calculateDecayedValue(event, new Date(now), 90);
      expect(value).toBeCloseTo(1.0, 2);
    });

    test("should return 0.5 for half-life old events", () => {
      const event = createTestFeedbackEvent("helpful", 90);
      const value = calculateDecayedValue(event, new Date(now), 90);
      expect(value).toBeCloseTo(0.5, 2);
    });

    test("should return ~1.0 for 1 day old events", () => {
      const event = createTestFeedbackEvent("helpful", 1);
      const value = calculateDecayedValue(event, new Date(now), 90);
      expect(value).toBeGreaterThan(0.99);
    });

    test("should clamp future events to 1.0", () => {
      const event = createTestFeedbackEvent("helpful", -1); // 1 day in future
      const value = calculateDecayedValue(event, new Date(now), 90);
      expect(value).toBe(1.0);
    });

    test("should return 0 for invalid timestamps or nonpositive half-life", () => {
      const badEvent = { type: "helpful", timestamp: "not-a-date" } as any;
      expect(calculateDecayedValue(badEvent, new Date(now), 90)).toBe(0);

      const event = createTestFeedbackEvent("helpful", 0);
      expect(calculateDecayedValue(event, new Date(now), 0)).toBe(0);
    });
  });

  describe("getEffectiveScore", () => {
    test("should return 0 for no feedback", () => {
      const bullet = createTestBullet({ feedbackEvents: [] });
      const score = getEffectiveScore(bullet, config);
      expect(score).toBe(0);
    });

    test("should account for helpful events", () => {
      const bullet = createTestBullet({ 
        feedbackEvents: [createTestFeedbackEvent("helpful", 0)],
        maturity: "established"
      });
      const score = getEffectiveScore(bullet, config);
      expect(score).toBeCloseTo(1.0, 5);
    });

    test("should apply harmful multiplier (4x)", () => {
      const bullet = createTestBullet({ 
        feedbackEvents: [createTestFeedbackEvent("harmful", 0)],
        maturity: "established"
      });
      const score = getEffectiveScore(bullet, config);
      expect(score).toBeCloseTo(-4.0, 5);
    });

    test("should apply decay to both helpful and harmful", () => {
      // Both 90 days old (half value)
      const baseEvents = [createTestFeedbackEvent("helpful", 0)];
      const oldEvents = [createTestFeedbackEvent("helpful", 90)]; // should be 0.5
      
      const freshBullet = createTestBullet({ feedbackEvents: baseEvents, maturity: "established" });
      const staleBullet = createTestBullet({ feedbackEvents: oldEvents, maturity: "established" });
      
      const freshScore = getEffectiveScore(freshBullet, config);
      const staleScore = getEffectiveScore(staleBullet, config);
      
      expect(freshScore).toBeCloseTo(1.0, 5);
      expect(staleScore).toBeCloseTo(0.5, 2);
    });

    test("should apply maturity multipliers", () => {
      const bullet = createTestBullet({ 
        maturity: "proven",
        feedbackEvents: [createTestFeedbackEvent("helpful", 0)]
      });
      
      // 1.0 (base) * 1.5 (proven multiplier)
      const score = getEffectiveScore(bullet, config);
      expect(score).toBe(1.5);
    });

    test("should honor harmful multiplier overrides from config", () => {
      const base = createTestConfig();
      const configWithMultiplier = createTestConfig({
        scoring: { ...base.scoring, harmfulMultiplier: 2 }
      });
      const bullet = createTestBullet({
        maturity: "established",
        feedbackEvents: [createTestFeedbackEvent("harmful", 0)]
      });
      const score = getEffectiveScore(bullet, configWithMultiplier);
      expect(score).toBeCloseTo(-2, 5);
    });
  });

  describe("Maturity Transitions", () => {
    test("should promote candidate to established with enough helpful", () => {
      // Need 3 for established - providing 4 to be robust against decay
      const bullet = createTestBullet({
        maturity: "candidate",
        feedbackEvents: Array(4).fill(null).map((_, idx) =>
          createTestFeedbackEvent("helpful", 0)
        )
      });

      const newState = calculateMaturityState(bullet, config);
      expect(newState).toBe("established");
    });

    test("should not promote if harmful ratio high", () => {
      const events = [
        createTestFeedbackEvent("helpful", 1),
        createTestFeedbackEvent("harmful", 0),
        createTestFeedbackEvent("harmful", 2),
        createTestFeedbackEvent("harmful", 0) // Added to ensure total > 3
      ];
      
      const bullet = createTestBullet({
        maturity: "candidate",
        feedbackEvents: events
      });
      
      const newState = calculateMaturityState(bullet, config);
      expect(newState).toBe("deprecated");
    });

    test("should promote to proven with 10+ helpful and low harmful", () => {
      const events = Array(12).fill(null).map(() => 
        createTestFeedbackEvent("helpful", 0)
      );
      
      const bullet = createTestBullet({
        maturity: "established",
        feedbackEvents: events
      });
      
      const newState = calculateMaturityState(bullet, config);
      expect(newState).toBe("proven");
    });

    test("should deprecate if harmful feedback overwhelming", () => {
      // Total > 3 needed for deprecation.
      const bullet = createTestBullet({
        maturity: "established",
        feedbackEvents: [
          createTestFeedbackEvent("harmful", 0),
          createTestFeedbackEvent("harmful", 1),
          createTestFeedbackEvent("harmful", 2),
          createTestFeedbackEvent("harmful", 3)
        ]
      });
      
      const newState = calculateMaturityState(bullet, config);
      expect(newState).toBe("deprecated");
    });
  });

  describe("checkForPromotion", () => {
    test("should return new state if promotion criteria met", () => {
      // Need 3 for established - providing 4 to be robust against decay
      const bullet = createTestBullet({
        maturity: "candidate",
        feedbackEvents: Array(4).fill(null).map(() =>
          createTestFeedbackEvent("helpful", 0)
        )
      });

      const result = checkForPromotion(bullet, config);
      expect(result).toBe("established");
    });

    test("should return current state if no promotion", () => {
      // Only 1 helpful (total < 3) stays as candidate
      const bullet = createTestBullet({
        maturity: "candidate",
        feedbackEvents: [createTestFeedbackEvent("helpful", 0)]
      });

      const result = checkForPromotion(bullet, config);
      expect(result).toBe("candidate");
    });
  });

  describe("getDecayedCounts", () => {
    test("should return zeros for no feedback", () => {
      const bullet = createTestBullet({ feedbackEvents: [] });
      const { decayedHelpful, decayedHarmful } = getDecayedCounts(bullet, config);
      expect(decayedHelpful).toBe(0);
      expect(decayedHarmful).toBe(0);
    });

    test("should count recent helpful events at full value", () => {
      const bullet = createTestBullet({
        feedbackEvents: [
          createTestFeedbackEvent("helpful", 0),
          createTestFeedbackEvent("helpful", 0),
          createTestFeedbackEvent("helpful", 0)
        ]
      });
      const { decayedHelpful, decayedHarmful } = getDecayedCounts(bullet, config);
      expect(decayedHelpful).toBeCloseTo(3.0, 1);
      expect(decayedHarmful).toBe(0);
    });

    test("should count recent harmful events at full value", () => {
      const bullet = createTestBullet({
        feedbackEvents: [
          createTestFeedbackEvent("harmful", 0),
          createTestFeedbackEvent("harmful", 0)
        ]
      });
      const { decayedHelpful, decayedHarmful } = getDecayedCounts(bullet, config);
      expect(decayedHelpful).toBe(0);
      expect(decayedHarmful).toBeCloseTo(2.0, 1);
    });

    test("should separate helpful and harmful correctly", () => {
      const bullet = createTestBullet({
        feedbackEvents: [
          createTestFeedbackEvent("helpful", 0),
          createTestFeedbackEvent("harmful", 0),
          createTestFeedbackEvent("helpful", 0)
        ]
      });
      const { decayedHelpful, decayedHarmful } = getDecayedCounts(bullet, config);
      expect(decayedHelpful).toBeCloseTo(2.0, 1);
      expect(decayedHarmful).toBeCloseTo(1.0, 1);
    });

    test("should apply decay to old events", () => {
      const bullet = createTestBullet({
        feedbackEvents: [createTestFeedbackEvent("helpful", 90)] // 90 days = half-life
      });
      const { decayedHelpful } = getDecayedCounts(bullet, config);
      expect(decayedHelpful).toBeCloseTo(0.5, 2);
    });

    test("should honor decayHalfLifeDays overrides from config", () => {
      const base = createTestConfig();
      const fastDecayConfig = createTestConfig({
        scoring: { ...base.scoring, decayHalfLifeDays: 30 }
      });
      const bullet = createTestBullet({
        feedbackEvents: [createTestFeedbackEvent("helpful", 30)]
      });
      const { decayedHelpful } = getDecayedCounts(bullet, fastDecayConfig);
      expect(decayedHelpful).toBeCloseTo(0.5, 2); // 30-day half-life halves value at 30 days
    });
  });

  describe("checkForDemotion", () => {
    test("should return current maturity for pinned bullets", () => {
      const bullet = createTestBullet({
        maturity: "proven",
        pinned: true,
        feedbackEvents: [
          createTestFeedbackEvent("harmful", 0),
          createTestFeedbackEvent("harmful", 0),
          createTestFeedbackEvent("harmful", 0)
        ]
      });
      const result = checkForDemotion(bullet, config);
      expect(result).toBe("proven");
    });

    test("should return auto-deprecate for severely negative score", () => {
      // pruneHarmfulThreshold is 3, so we need score < -3
      // With harmfulMultiplier of 4, 1 harmful = -4 score for established
      const bullet = createTestBullet({
        maturity: "established",
        feedbackEvents: [createTestFeedbackEvent("harmful", 0)]
      });
      const result = checkForDemotion(bullet, config);
      expect(result).toBe("auto-deprecate");
    });

    test("should demote proven to established for negative score", () => {
      // Need score < 0 but not < -3 (pruneHarmfulThreshold)
      // 1 helpful + 1 harmful = 1 - 4 = -3 for established maturity
      // For proven: (-3) * 1.5 = -4.5 which is < -3 so auto-deprecate
      // Let's use 2 helpful + 1 harmful = 2 - 4 = -2 * 1.5 = -3 which equals threshold
      // Try 3 helpful + 1 harmful = 3 - 4 = -1 * 1.5 = -1.5 (negative but not auto-deprecate)
      const bullet = createTestBullet({
        maturity: "proven",
        feedbackEvents: [
          createTestFeedbackEvent("helpful", 0),
          createTestFeedbackEvent("helpful", 0),
          createTestFeedbackEvent("helpful", 0),
          createTestFeedbackEvent("harmful", 0)
        ]
      });
      const result = checkForDemotion(bullet, config);
      expect(result).toBe("established");
    });

    test("should demote established to candidate for negative score", () => {
      // For established: 2 helpful + 1 harmful = 2 - 4 = -2 (negative but > -3)
      const bullet = createTestBullet({
        maturity: "established",
        feedbackEvents: [
          createTestFeedbackEvent("helpful", 0),
          createTestFeedbackEvent("helpful", 0),
          createTestFeedbackEvent("harmful", 0)
        ]
      });
      const result = checkForDemotion(bullet, config);
      expect(result).toBe("candidate");
    });

    test("should keep current maturity for non-negative score", () => {
      const bullet = createTestBullet({
        maturity: "established",
        feedbackEvents: [
          createTestFeedbackEvent("helpful", 0),
          createTestFeedbackEvent("helpful", 0)
        ]
      });
      const result = checkForDemotion(bullet, config);
      expect(result).toBe("established");
    });
  });

  describe("isStale", () => {
    test("should return false for bullet with recent feedback", () => {
      const bullet = createTestBullet({
        feedbackEvents: [createTestFeedbackEvent("helpful", 0)]
      });
      expect(isStale(bullet, 90)).toBe(false);
    });

    test("should return true for bullet with old feedback", () => {
      const bullet = createTestBullet({
        feedbackEvents: [createTestFeedbackEvent("helpful", 100)] // 100 days ago
      });
      expect(isStale(bullet, 90)).toBe(true);
    });

    test("should return true for bullet with no feedback and old creation", () => {
      const oldDate = new Date(Date.now() - 100 * 86_400_000).toISOString();
      const bullet = createTestBullet({
        feedbackEvents: [],
        createdAt: oldDate
      });
      expect(isStale(bullet, 90)).toBe(true);
    });

    test("should return false for new bullet with no feedback", () => {
      const bullet = createTestBullet({
        feedbackEvents: [],
        createdAt: new Date().toISOString()
      });
      expect(isStale(bullet, 90)).toBe(false);
    });

    test("should use most recent feedback for staleness check", () => {
      const bullet = createTestBullet({
        feedbackEvents: [
          createTestFeedbackEvent("helpful", 100), // Old
          createTestFeedbackEvent("helpful", 10),  // Recent
          createTestFeedbackEvent("helpful", 80)   // Medium
        ]
      });
      // Most recent is 10 days ago, so not stale
      expect(isStale(bullet, 90)).toBe(false);
    });

    test("should respect custom staleDays parameter", () => {
      const bullet = createTestBullet({
        feedbackEvents: [createTestFeedbackEvent("helpful", 40)] // 40 days ago
      });
      expect(isStale(bullet, 30)).toBe(true);  // 40 > 30, stale
      expect(isStale(bullet, 60)).toBe(false); // 40 < 60, not stale
    });
  });

  describe("analyzeScoreDistribution", () => {
    test("should return all zeros for empty array", () => {
      const result = analyzeScoreDistribution([], config);
      expect(result).toEqual({ excellent: 0, good: 0, neutral: 0, atRisk: 0 });
    });

    test("should categorize excellent bullets (score >= 10)", () => {
      // Need 10+ effective score
      // For established (1.0 multiplier), need 10+ raw score
      // 10 helpful events = 10 raw score
      const excellentBullet = createTestBullet({
        maturity: "established",
        feedbackEvents: Array(12).fill(null).map(() => createTestFeedbackEvent("helpful", 0))
      });
      const result = analyzeScoreDistribution([excellentBullet], config);
      expect(result.excellent).toBe(1);
    });

    test("should categorize good bullets (5 <= score < 10)", () => {
      // 6 helpful = 6 raw score for established
      const goodBullet = createTestBullet({
        maturity: "established",
        feedbackEvents: Array(6).fill(null).map(() => createTestFeedbackEvent("helpful", 0))
      });
      const result = analyzeScoreDistribution([goodBullet], config);
      expect(result.good).toBe(1);
    });

    test("should categorize neutral bullets (0 <= score < 5)", () => {
      // 2 helpful = 2 raw score for established
      const neutralBullet = createTestBullet({
        maturity: "established",
        feedbackEvents: [
          createTestFeedbackEvent("helpful", 0),
          createTestFeedbackEvent("helpful", 0)
        ]
      });
      const result = analyzeScoreDistribution([neutralBullet], config);
      expect(result.neutral).toBe(1);
    });

    test("should categorize at-risk bullets (score < 0)", () => {
      // 1 harmful = -4 raw score for established
      const atRiskBullet = createTestBullet({
        maturity: "established",
        feedbackEvents: [createTestFeedbackEvent("harmful", 0)]
      });
      const result = analyzeScoreDistribution([atRiskBullet], config);
      expect(result.atRisk).toBe(1);
    });

    test("should correctly categorize mixed bullets", () => {
      const bullets = [
        createTestBullet({ maturity: "established", feedbackEvents: Array(12).fill(null).map(() => createTestFeedbackEvent("helpful", 0)) }), // excellent
        createTestBullet({ maturity: "established", feedbackEvents: Array(6).fill(null).map(() => createTestFeedbackEvent("helpful", 0)) }),  // good
        createTestBullet({ maturity: "established", feedbackEvents: [createTestFeedbackEvent("helpful", 0)] }), // neutral
        createTestBullet({ maturity: "established", feedbackEvents: [createTestFeedbackEvent("harmful", 0)] })  // at-risk
      ];
      const result = analyzeScoreDistribution(bullets, config);
      expect(result.excellent).toBe(1);
      expect(result.good).toBe(1);
      expect(result.neutral).toBe(1);
      expect(result.atRisk).toBe(1);
    });
  });
});