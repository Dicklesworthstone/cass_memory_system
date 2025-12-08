import { describe, it, expect } from "bun:test";
import {
  calculateDecayedValue,
  getDecayedCounts,
  getEffectiveScore,
  calculateMaturityState,
  checkForPromotion,
  checkForDemotion,
  isStale,
  analyzeScoreDistribution,
} from "../src/scoring.js";
import { FeedbackEvent } from "../src/types.js";
import { createTestBullet, createTestConfig } from "./helpers/factories.js";

const DAY_MS = 86_400_000;

function daysAgo(days: number) {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

function feedback(type: "helpful" | "harmful", days: number): FeedbackEvent {
  return { type, timestamp: daysAgo(days) } as FeedbackEvent;
}

describe("scoring", () => {
  const config = createTestConfig();

  it("calculateDecayedValue returns ~1 for recent and ~0.5 at half-life", () => {
    const now = new Date();
    const recent = calculateDecayedValue({ type: "helpful", timestamp: now.toISOString() }, now, 90);
    expect(recent).toBeCloseTo(1, 2);

    const ninetyDaysAgo = new Date(now.getTime() - 90 * DAY_MS).toISOString();
    const half = calculateDecayedValue({ type: "helpful", timestamp: ninetyDaysAgo }, now, 90);
    expect(half).toBeCloseTo(0.5, 2);
  });

  it("getDecayedCounts separates helpful and harmful", () => {
    const bullet = createTestBullet({
      feedbackEvents: [feedback("helpful", 0), feedback("harmful", 0)],
    });
    const { decayedHelpful, decayedHarmful } = getDecayedCounts(bullet, config);
    expect(decayedHelpful).toBeGreaterThan(0.99);
    expect(decayedHarmful).toBeGreaterThan(0.99);
  });

  it("getEffectiveScore applies harmful multiplier and maturity", () => {
    const bullet = createTestBullet({
      feedbackEvents: [feedback("helpful", 0), feedback("harmful", 0)],
      maturity: "proven",
    });
    const score = getEffectiveScore(bullet, config);
    // helpful (≈1) - 4*harmful (≈4) = ~-3; proven multiplier 1.5 => about -4.5
    expect(score).toBeLessThan(-4);
  });

  it("calculateMaturityState promotes with strong helpful ratio and deprecates on harmful ratio", () => {
    const helpfulHeavy = createTestBullet({
      feedbackEvents: Array.from({ length: 10 }, () => feedback("helpful", 0)),
    });
    expect(calculateMaturityState(helpfulHeavy, config)).toBe("proven");

    const harmfulHeavy = createTestBullet({
      feedbackEvents: [feedback("helpful", 0), feedback("harmful", 0), feedback("harmful", 0)],
    });
    expect(calculateMaturityState(harmfulHeavy, config)).toBe("deprecated");
  });

  it("checkForPromotion only upgrades when threshold met", () => {
    const bullet = createTestBullet({
      maturity: "candidate",
      feedbackEvents: [feedback("helpful", 0), feedback("helpful", 0), feedback("helpful", 0)],
    });
    expect(checkForPromotion(bullet, config)).toBe("established");
  });

  it("checkForDemotion demotes or auto-deprecates based on score", () => {
    const forgivingConfig = createTestConfig({ pruneHarmfulThreshold: 10 });
    const demote = createTestBullet({
      maturity: "proven",
      feedbackEvents: [feedback("harmful", 10)], // decays so score <0 but above prune threshold
    });
    expect(checkForDemotion(demote, forgivingConfig)).toBe("established");

    const autoDep = createTestBullet({
      feedbackEvents: Array.from({ length: 5 }, () => feedback("harmful", 0)),
    });
    expect(checkForDemotion(autoDep, config)).toBe("auto-deprecate");
  });

  it("isStale detects age when no feedback and when last feedback old", () => {
    const oldBullet = createTestBullet({ createdAt: daysAgo(200) });
    expect(isStale(oldBullet, 90)).toBe(true);

    const freshFeedback = createTestBullet({ feedbackEvents: [feedback("helpful", 1)] });
    expect(isStale(freshFeedback, 90)).toBe(false);
  });

  it("analyzeScoreDistribution buckets scores", () => {
    const excellent = createTestBullet({
      maturity: "proven",
      feedbackEvents: Array.from({ length: 10 }, () => feedback("helpful", 0)),
    });
    const good = createTestBullet({
      maturity: "established",
      feedbackEvents: [feedback("helpful", 0), feedback("helpful", 0)],
    });
    const neutral = createTestBullet({});
    const atRisk = createTestBullet({ feedbackEvents: [feedback("harmful", 0), feedback("harmful", 0)] });

    const buckets = analyzeScoreDistribution([excellent, good, neutral, atRisk], config);
    expect(buckets.excellent).toBe(1);
    expect(buckets.good).toBe(1);
    expect(buckets.neutral).toBe(1);
    expect(buckets.atRisk).toBe(1);
  });
});
