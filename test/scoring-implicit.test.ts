import { describe, expect, test } from "bun:test";
import {
  calculateDecayedValue,
  calculateMaturityState,
  getDecayedCounts,
  getEffectiveScore,
  isStale,
} from "../src/scoring.js";
import {
  createTestBullet,
  createTestConfig,
  createTestFeedbackEvent,
} from "./helpers/factories.js";

describe("Implicit Feedback Scoring", () => {
  const config = createTestConfig();

  test("should calculate score correctly with mixed implicit and explicit feedback", () => {
    const events = [createTestFeedbackEvent("helpful", 0), createTestFeedbackEvent("helpful", 0)];

    const bullet = createTestBullet({ feedbackEvents: events });
    const score = getEffectiveScore(bullet, config);

    expect(score).toBeCloseTo(1.0, 2); // Use closeTo for floating point
  });

  test("should decay old implicit feedback", () => {
    const bullet = createTestBullet({
      feedbackEvents: [
        createTestFeedbackEvent("helpful", 90), // 90 days ago
      ],
    });

    const score = getEffectiveScore(bullet, config);
    expect(score).toBeCloseTo(0.25, 2);
  });

  test("future events should be clamped", () => {
    const bullet = createTestBullet({
      feedbackEvents: [
        createTestFeedbackEvent("helpful", -1), // 1 day in future
      ],
    });

    const score = getEffectiveScore(bullet, config);
    expect(score).toBe(0.5);
  });

  test("calculateDecayedValue follows half-life curve", () => {
    const eventNow = createTestFeedbackEvent("helpful", 0);
    const now = new Date();
    expect(calculateDecayedValue(eventNow, now, 90)).toBeCloseTo(1.0, 2);

    const event90 = createTestFeedbackEvent("helpful", 90);
    expect(calculateDecayedValue(event90, now, 90)).toBeCloseTo(0.5, 2);

    const event180 = createTestFeedbackEvent("helpful", 180);
    expect(calculateDecayedValue(event180, now, 90)).toBeCloseTo(0.25, 2);
  });

  test("getDecayedCounts splits helpful vs harmful", () => {
    const bullet = createTestBullet({
      feedbackEvents: [
        createTestFeedbackEvent("helpful", 0),
        createTestFeedbackEvent("helpful", 1),
        createTestFeedbackEvent("harmful", 0),
      ],
    });
    const { decayedHelpful, decayedHarmful } = getDecayedCounts(bullet, config);
    expect(decayedHelpful).toBeGreaterThan(decayedHarmful);
    expect(decayedHarmful).toBeGreaterThan(0);
  });

  test("calculateMaturityState promotes with sufficient helpful signals", () => {
    const longHalfLifeConfig = createTestConfig({
      scoring: { ...config.scoring, decayHalfLifeDays: 1_000 },
    });
    const helpfulEvents = Array.from({ length: 10 }, () => createTestFeedbackEvent("helpful", 0));
    const bullet = createTestBullet({ feedbackEvents: helpfulEvents, maturity: "candidate" });
    const maturity = calculateMaturityState(bullet, longHalfLifeConfig);
    expect(maturity).toBe("proven");
  });

  test("calculateMaturityState deprecates when harmful ratio high", () => {
    const events = [
      createTestFeedbackEvent("harmful", 0),
      createTestFeedbackEvent("harmful", 0),
      createTestFeedbackEvent("helpful", 0),
    ];
    const bullet = createTestBullet({ feedbackEvents: events, maturity: "established" });
    const maturity = calculateMaturityState(bullet, createTestConfig({ pruneHarmfulThreshold: 1 }));
    expect(maturity).toBe("deprecated");
  });

  test("isStale returns true when feedback absent and old", () => {
    const old = createTestBullet({
      createdAt: new Date(Date.now() - 200 * 86_400_000).toISOString(),
      feedbackEvents: [],
    });
    expect(isStale(old, 90)).toBe(true);
  });

  test("isStale returns false when recent feedback exists", () => {
    const fresh = createTestBullet({
      createdAt: new Date().toISOString(),
      feedbackEvents: [createTestFeedbackEvent("helpful", 0)],
    });
    expect(isStale(fresh, 90)).toBe(false);
  });
});
