/**
 * E2E Tests: Confidence Decay Over Time - Scoring Accuracy
 *
 * Tests that bullet confidence decays over time as expected using
 * the exponential decay formula: value = 0.5^(ageDays/halfLifeDays)
 */
import { describe, expect, test } from "bun:test";
import {
  calculateDecayedValue,
  calculateMaturityState,
  getDecayedCounts,
  getEffectiveScore,
} from "../src/scoring.js";
import {
  createTestBullet,
  createTestConfig,
  createTestFeedbackEvent,
  daysAgo,
} from "./helpers/factories.js";

describe("Confidence Decay E2E", () => {
  describe("calculateDecayedValue - Basic Decay", () => {
    test("no decay at creation (0 days ago)", () => {
      const event = createTestFeedbackEvent("helpful", { timestamp: new Date().toISOString() });
      const now = new Date();
      const value = calculateDecayedValue(event, now, 90);

      // Should be 1.0 (no decay)
      expect(value).toBeCloseTo(1.0, 2);
    });

    test("half decay at one half-life (90 days default)", () => {
      const event = createTestFeedbackEvent("helpful", { timestamp: daysAgo(90) });
      const now = new Date();
      const value = calculateDecayedValue(event, now, 90);

      // Should be 0.5 (half decay)
      expect(value).toBeCloseTo(0.5, 2);
    });

    test("quarter decay at two half-lives (180 days)", () => {
      const event = createTestFeedbackEvent("helpful", { timestamp: daysAgo(180) });
      const now = new Date();
      const value = calculateDecayedValue(event, now, 90);

      // Should be 0.25 (2 half-lives = 0.5^2)
      expect(value).toBeCloseTo(0.25, 2);
    });

    test("eighth decay at three half-lives (270 days)", () => {
      const event = createTestFeedbackEvent("helpful", { timestamp: daysAgo(270) });
      const now = new Date();
      const value = calculateDecayedValue(event, now, 90);

      // Should be 0.125 (3 half-lives = 0.5^3)
      expect(value).toBeCloseTo(0.125, 2);
    });

    test("very old event has minimal but non-zero value", () => {
      const event = createTestFeedbackEvent("helpful", { timestamp: daysAgo(365) });
      const now = new Date();
      const value = calculateDecayedValue(event, now, 90);

      // Should be very small but > 0
      expect(value).toBeGreaterThan(0);
      expect(value).toBeLessThan(0.1);
    });
  });

  describe("Custom Half-Life Configuration", () => {
    test("7-day half-life decays faster", () => {
      const event = createTestFeedbackEvent("helpful", { timestamp: daysAgo(7) });
      const now = new Date();
      const value = calculateDecayedValue(event, now, 7);

      // Should be 0.5 at exactly one half-life
      expect(value).toBeCloseTo(0.5, 2);
    });

    test("30-day half-life decay comparison", () => {
      const event = createTestFeedbackEvent("helpful", { timestamp: daysAgo(30) });
      const now = new Date();

      const value30 = calculateDecayedValue(event, now, 30);
      const value90 = calculateDecayedValue(event, now, 90);

      // 30-day half-life should decay more (value should be lower)
      expect(value30).toBeCloseTo(0.5, 2); // Exactly 1 half-life
      expect(value90).toBeGreaterThan(value30); // 90-day decays less
    });

    test("config.scoring.decayHalfLifeDays is respected", () => {
      const config = createTestConfig({
        scoring: {
          decayHalfLifeDays: 30, // Custom 30-day half-life
          harmfulMultiplier: 4,
          minFeedbackForActive: 3,
          minHelpfulForProven: 10,
          maxHarmfulRatioForProven: 0.1,
        },
      });

      const bullet = createTestBullet({
        feedbackEvents: [createTestFeedbackEvent("helpful", { timestamp: daysAgo(30) })],
      });

      const { decayedHelpful } = getDecayedCounts(bullet, config);
      // 30 days = 1 half-life with 30-day config
      expect(decayedHelpful).toBeCloseTo(0.5, 1);
    });
  });

  describe("getDecayedCounts - Aggregate Decay", () => {
    test("sums multiple decayed helpful events", () => {
      const config = createTestConfig();
      const bullet = createTestBullet({
        feedbackEvents: [
          createTestFeedbackEvent("helpful", { timestamp: new Date().toISOString() }), // 1.0
          createTestFeedbackEvent("helpful", { timestamp: daysAgo(90) }), // 0.5
          createTestFeedbackEvent("helpful", { timestamp: daysAgo(180) }), // 0.25
        ],
      });

      const { decayedHelpful, decayedHarmful } = getDecayedCounts(bullet, config);

      expect(decayedHelpful).toBeCloseTo(1.75, 1); // 1.0 + 0.5 + 0.25
      expect(decayedHarmful).toBe(0);
    });

    test("sums multiple decayed harmful events", () => {
      const config = createTestConfig();
      const bullet = createTestBullet({
        feedbackEvents: [
          createTestFeedbackEvent("harmful", { timestamp: new Date().toISOString() }), // 1.0
          createTestFeedbackEvent("harmful", { timestamp: daysAgo(90) }), // 0.5
        ],
      });

      const { decayedHelpful, decayedHarmful } = getDecayedCounts(bullet, config);

      expect(decayedHelpful).toBe(0);
      expect(decayedHarmful).toBeCloseTo(1.5, 1); // 1.0 + 0.5
    });

    test("mixed helpful and harmful events", () => {
      const config = createTestConfig();
      const bullet = createTestBullet({
        feedbackEvents: [
          createTestFeedbackEvent("helpful", { timestamp: new Date().toISOString() }), // 1.0
          createTestFeedbackEvent("harmful", { timestamp: daysAgo(90) }), // 0.5
          createTestFeedbackEvent("helpful", { timestamp: daysAgo(45) }), // ~0.707
        ],
      });

      const { decayedHelpful, decayedHarmful } = getDecayedCounts(bullet, config);

      expect(decayedHelpful).toBeGreaterThan(1.5); // 1.0 + ~0.707
      expect(decayedHarmful).toBeCloseTo(0.5, 1);
    });
  });

  describe("getEffectiveScore - Score with Decay", () => {
    test("recent helpful feedback gives high score", () => {
      const config = createTestConfig();
      const bullet = createTestBullet({
        maturity: "established",
        feedbackEvents: [
          createTestFeedbackEvent("helpful", { timestamp: new Date().toISOString() }),
          createTestFeedbackEvent("helpful", { timestamp: new Date().toISOString() }),
          createTestFeedbackEvent("helpful", { timestamp: new Date().toISOString() }),
        ],
      });

      const score = getEffectiveScore(bullet, config);
      // 3 recent helpful = 3.0, maturity multiplier 1.0
      expect(score).toBeCloseTo(3.0, 1);
    });

    test("old helpful feedback gives lower score", () => {
      const config = createTestConfig();
      const bullet = createTestBullet({
        maturity: "established",
        feedbackEvents: [
          createTestFeedbackEvent("helpful", { timestamp: daysAgo(180) }),
          createTestFeedbackEvent("helpful", { timestamp: daysAgo(180) }),
          createTestFeedbackEvent("helpful", { timestamp: daysAgo(180) }),
        ],
      });

      const score = getEffectiveScore(bullet, config);
      // 3 old helpful = 3 * 0.25 = 0.75, maturity multiplier 1.0
      expect(score).toBeCloseTo(0.75, 1);
    });

    test("harmful feedback reduces score with multiplier", () => {
      const config = createTestConfig();
      const bullet = createTestBullet({
        maturity: "established",
        feedbackEvents: [
          createTestFeedbackEvent("helpful", { timestamp: new Date().toISOString() }), // +1.0
          createTestFeedbackEvent("harmful", { timestamp: new Date().toISOString() }), // -4.0 (multiplier)
        ],
      });

      const score = getEffectiveScore(bullet, config);
      // 1.0 - (4 * 1.0) = -3.0
      expect(score).toBeCloseTo(-3.0, 1);
    });

    test("maturity affects final score", () => {
      const config = createTestConfig();

      const candidateBullet = createTestBullet({
        maturity: "candidate",
        feedbackEvents: [
          createTestFeedbackEvent("helpful", { timestamp: new Date().toISOString() }),
          createTestFeedbackEvent("helpful", { timestamp: new Date().toISOString() }),
        ],
      });

      const provenBullet = createTestBullet({
        maturity: "proven",
        feedbackEvents: [
          createTestFeedbackEvent("helpful", { timestamp: new Date().toISOString() }),
          createTestFeedbackEvent("helpful", { timestamp: new Date().toISOString() }),
        ],
      });

      const candidateScore = getEffectiveScore(candidateBullet, config);
      const provenScore = getEffectiveScore(provenBullet, config);

      // Raw score = 2.0
      // Candidate multiplier = 0.5, Proven multiplier = 1.5
      expect(candidateScore).toBeCloseTo(1.0, 1); // 2.0 * 0.5
      expect(provenScore).toBeCloseTo(3.0, 1); // 2.0 * 1.5
    });
  });

  describe("Decay Impact on Maturity Transitions", () => {
    test("new bullet with helpful feedback stays candidate initially", () => {
      const config = createTestConfig();
      const bullet = createTestBullet({
        maturity: "candidate",
        feedbackEvents: [
          createTestFeedbackEvent("helpful", { timestamp: new Date().toISOString() }),
          createTestFeedbackEvent("helpful", { timestamp: new Date().toISOString() }),
        ],
      });

      const maturity = calculateMaturityState(bullet, config);
      // Only 2 decayed feedback, needs minFeedbackForActive (3)
      expect(maturity).toBe("candidate");
    });

    test("bullet with enough recent feedback becomes established", () => {
      const config = createTestConfig();
      const bullet = createTestBullet({
        maturity: "candidate",
        feedbackEvents: [
          createTestFeedbackEvent("helpful", { timestamp: new Date().toISOString() }),
          createTestFeedbackEvent("helpful", { timestamp: new Date().toISOString() }),
          createTestFeedbackEvent("helpful", { timestamp: new Date().toISOString() }),
        ],
      });

      const maturity = calculateMaturityState(bullet, config);
      // 3 recent helpful = 3.0 decayed, meets minFeedbackForActive
      expect(maturity).toBe("established");
    });

    test("bullet with decayed feedback may not meet threshold", () => {
      const config = createTestConfig();
      const bullet = createTestBullet({
        maturity: "candidate",
        feedbackEvents: [
          // Very old events that decay to nearly nothing
          createTestFeedbackEvent("helpful", { timestamp: daysAgo(365) }),
          createTestFeedbackEvent("helpful", { timestamp: daysAgo(365) }),
          createTestFeedbackEvent("helpful", { timestamp: daysAgo(365) }),
        ],
      });

      const maturity = calculateMaturityState(bullet, config);
      // Old feedback decays, may not meet minFeedbackForActive threshold
      expect(maturity).toBe("candidate");
    });
  });

  describe("Edge Cases", () => {
    test("bullet with no feedback events", () => {
      const config = createTestConfig();
      const bullet = createTestBullet({
        feedbackEvents: [],
      });

      const { decayedHelpful, decayedHarmful } = getDecayedCounts(bullet, config);
      expect(decayedHelpful).toBe(0);
      expect(decayedHarmful).toBe(0);
    });

    test("handles future timestamps gracefully", () => {
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 10);

      const event = createTestFeedbackEvent("helpful", {
        timestamp: futureDate.toISOString(),
      });
      const now = new Date();
      const value = calculateDecayedValue(event, now, 90);

      // Future events should be clamped to 1.0
      expect(value).toBe(1.0);
    });

    test("handles zero half-life gracefully", () => {
      const event = createTestFeedbackEvent("helpful", { timestamp: daysAgo(10) });
      const now = new Date();
      const value = calculateDecayedValue(event, now, 0);

      // Should return 0 for invalid half-life
      expect(value).toBe(0);
    });

    test("handles negative half-life gracefully", () => {
      const event = createTestFeedbackEvent("helpful", { timestamp: daysAgo(10) });
      const now = new Date();
      const value = calculateDecayedValue(event, now, -30);

      // Should return 0 for invalid half-life
      expect(value).toBe(0);
    });
  });

  describe("Precision and Consistency", () => {
    test("decay calculation is deterministic", () => {
      const event = createTestFeedbackEvent("helpful", { timestamp: daysAgo(45) });
      const now = new Date();

      const value1 = calculateDecayedValue(event, now, 90);
      const value2 = calculateDecayedValue(event, now, 90);
      const value3 = calculateDecayedValue(event, now, 90);

      expect(value1).toBe(value2);
      expect(value2).toBe(value3);
    });

    test("45-day decay is approximately 0.707 (sqrt(0.5))", () => {
      const event = createTestFeedbackEvent("helpful", { timestamp: daysAgo(45) });
      const now = new Date();
      const value = calculateDecayedValue(event, now, 90);

      // 45 days = 0.5 half-lives, so 0.5^0.5 = sqrt(0.5) ≈ 0.707
      expect(value).toBeCloseTo(0.707, 2);
    });
  });
});
