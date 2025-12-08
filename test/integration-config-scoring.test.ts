/**
 * Integration Test: Config + Scoring Interaction
 *
 * Tests real integration between config.ts and scoring.ts without mocks.
 * Verifies that scoring functions properly respect config-driven parameters.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { loadConfig, DEFAULT_CONFIG, getDefaultConfig } from "../src/config.js";
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
import { withTempCassHome, TestEnv } from "./helpers/temp.js";
import { createTestBullet, createTestFeedbackEvent, daysAgo } from "./helpers/factories.js";

describe("Integration: Config + Scoring", () => {
  describe("Decay calculation with configurable half-life", () => {
    it("uses config.scoring.decayHalfLifeDays for decay calculation", async () => {
      await withTempCassHome(async (env: TestEnv) => {
        // Write config with custom half-life (45 days instead of default 90)
        const configContent = JSON.stringify({
          scoring: {
            decayHalfLifeDays: 45,
            harmfulMultiplier: 4
          }
        });
        await writeFile(env.configPath, configContent);

        const config = await loadConfig();

        // Create bullet with event 45 days ago
        const bullet = createTestBullet({
          feedbackEvents: [
            createTestFeedbackEvent("helpful", 45)
          ]
        });

        const { decayedHelpful } = getDecayedCounts(bullet, config);

        // With 45-day half-life, event 45 days ago should have ~0.5 decayed value
        expect(decayedHelpful).toBeCloseTo(0.5, 1);
      });
    });

    it("uses default 90-day half-life when not specified in config", async () => {
      await withTempCassHome(async (env: TestEnv) => {
        // Write minimal config without scoring section
        await writeFile(env.configPath, JSON.stringify({}));

        const config = await loadConfig();

        const bullet = createTestBullet({
          feedbackEvents: [
            createTestFeedbackEvent("helpful", 90) // 90 days ago
          ]
        });

        const { decayedHelpful } = getDecayedCounts(bullet, config);

        // With default 90-day half-life, event 90 days ago = 0.5
        expect(decayedHelpful).toBeCloseTo(0.5, 1);
      });
    });

    it("applies different half-lives to same events correctly", async () => {
      // 30-day half-life: event at 30 days = 0.5, at 60 days = 0.25
      const config30 = { ...getDefaultConfig(), scoring: { ...DEFAULT_CONFIG.scoring, decayHalfLifeDays: 30 } };
      // 90-day half-life: event at 30 days = 0.79, at 60 days = 0.63
      const config90 = { ...getDefaultConfig(), scoring: { ...DEFAULT_CONFIG.scoring, decayHalfLifeDays: 90 } };

      const bullet = createTestBullet({
        feedbackEvents: [
          createTestFeedbackEvent("helpful", 30)
        ]
      });

      const result30 = getDecayedCounts(bullet, config30);
      const result90 = getDecayedCounts(bullet, config90);

      // Shorter half-life = more decay = lower value
      expect(result30.decayedHelpful).toBeLessThan(result90.decayedHelpful);
      expect(result30.decayedHelpful).toBeCloseTo(0.5, 1); // 30 days = 1 half-life
      expect(result90.decayedHelpful).toBeCloseTo(0.79, 1); // 30 days = 1/3 half-life
    });
  });

  describe("Effective score with config-driven harmful multiplier", () => {
    it("uses config.scoring.harmfulMultiplier for score calculation", async () => {
      await withTempCassHome(async (env: TestEnv) => {
        // Write config with higher harmful multiplier (8 instead of 4)
        const configContent = JSON.stringify({
          scoring: {
            decayHalfLifeDays: 90,
            harmfulMultiplier: 8
          }
        });
        await writeFile(env.configPath, configContent);

        const config = await loadConfig();

        // 2 helpful events (value ~2) vs 1 harmful event
        // With multiplier 8: score = 2 - (8 * 1) = -6
        // With default 4: score = 2 - (4 * 1) = -2
        const bullet = createTestBullet({
          feedbackEvents: [
            createTestFeedbackEvent("helpful", 0),
            createTestFeedbackEvent("helpful", 0),
            createTestFeedbackEvent("harmful", 0)
          ]
        });

        const score = getEffectiveScore(bullet, config);

        // With harmfulMultiplier=8: 2 - 8*1 = -6, times maturity multiplier 0.5 = -3
        expect(score).toBeCloseTo(-3, 1);
      });
    });

    it("uses default harmfulMultiplier=4 when not specified", async () => {
      await withTempCassHome(async (env: TestEnv) => {
        await writeFile(env.configPath, JSON.stringify({}));
        const config = await loadConfig();

        const bullet = createTestBullet({
          feedbackEvents: [
            createTestFeedbackEvent("helpful", 0),
            createTestFeedbackEvent("helpful", 0),
            createTestFeedbackEvent("harmful", 0)
          ]
        });

        const score = getEffectiveScore(bullet, config);

        // With default harmfulMultiplier=4: 2 - 4*1 = -2, times 0.5 = -1
        expect(score).toBeCloseTo(-1, 1);
      });
    });
  });

  describe("Score thresholds from config", () => {
    it("uses config.pruneHarmfulThreshold for auto-deprecation", async () => {
      await withTempCassHome(async (env: TestEnv) => {
        // Write config with low prune threshold (2 instead of default 3)
        const configContent = JSON.stringify({
          pruneHarmfulThreshold: 2,
          scoring: {
            decayHalfLifeDays: 90,
            harmfulMultiplier: 4
          }
        });
        await writeFile(env.configPath, configContent);

        const config = await loadConfig();

        // Create bullet with effective score of -3 (exceeds threshold of -2)
        // 1 helpful - 4*1 harmful = -3, times 0.5 candidate multiplier = -1.5
        // Wait, we need score < -2 for auto-deprecate
        // Let's make it more harmful: 0 helpful, 2 harmful
        // Score = 0 - 4*2 = -8, times 0.5 = -4, which exceeds threshold 2
        const bullet = createTestBullet({
          feedbackEvents: [
            createTestFeedbackEvent("harmful", 0),
            createTestFeedbackEvent("harmful", 0)
          ]
        });

        const result = checkForDemotion(bullet, config);

        expect(result).toBe("auto-deprecate");
      });
    });

    it("respects default pruneHarmfulThreshold when not set", async () => {
      await withTempCassHome(async (env: TestEnv) => {
        await writeFile(env.configPath, JSON.stringify({}));
        const config = await loadConfig();

        // Create bullet with score just below default threshold (3)
        // Need score between -3 and 0
        // 1 harmful = -4 * 0.5 = -2 (candidate multiplier)
        const bullet = createTestBullet({
          feedbackEvents: [
            createTestFeedbackEvent("harmful", 0)
          ]
        });

        const result = checkForDemotion(bullet, config);

        // Score -2 is less than 0 but not < -3, so should demote but not auto-deprecate
        expect(result).toBe("candidate"); // Already candidate, no demotion possible
      });
    });
  });

  describe("Config merging with defaults for scoring", () => {
    it("merges partial scoring config with defaults", async () => {
      await withTempCassHome(async (env: TestEnv) => {
        // Only override half-life, keep other defaults
        const configContent = JSON.stringify({
          scoring: {
            decayHalfLifeDays: 180
          }
        });
        await writeFile(env.configPath, configContent);

        const config = await loadConfig();

        // Verify half-life is overridden
        expect(config.scoring.decayHalfLifeDays).toBe(180);
        // Verify other scoring defaults are preserved
        expect(config.scoring.harmfulMultiplier).toBe(4);
        expect(config.scoring.minFeedbackForActive).toBe(3);
      });
    });

    it("preserves full scoring config when all fields specified", async () => {
      await withTempCassHome(async (env: TestEnv) => {
        const configContent = JSON.stringify({
          scoring: {
            decayHalfLifeDays: 60,
            harmfulMultiplier: 6,
            minFeedbackForActive: 5,
            minHelpfulForProven: 15,
            maxHarmfulRatioForProven: 0.05
          }
        });
        await writeFile(env.configPath, configContent);

        const config = await loadConfig();

        expect(config.scoring.decayHalfLifeDays).toBe(60);
        expect(config.scoring.harmfulMultiplier).toBe(6);
        expect(config.scoring.minFeedbackForActive).toBe(5);
        expect(config.scoring.minHelpfulForProven).toBe(15);
        expect(config.scoring.maxHarmfulRatioForProven).toBe(0.05);
      });
    });
  });

  describe("Maturity transitions with config", () => {
    it("uses config for maturity state calculations", async () => {
      await withTempCassHome(async (env: TestEnv) => {
        await writeFile(env.configPath, JSON.stringify({}));
        const config = await loadConfig();

        // Create bullet with 3 helpful events (should be "established")
        const bullet = createTestBullet({
          feedbackEvents: [
            createTestFeedbackEvent("helpful", 0),
            createTestFeedbackEvent("helpful", 0),
            createTestFeedbackEvent("helpful", 0)
          ]
        });

        const maturity = calculateMaturityState(bullet, config);
        expect(maturity).toBe("established");
      });
    });

    it("respects decay when determining maturity", async () => {
      await withTempCassHome(async (env: TestEnv) => {
        // Short half-life so old events decay significantly
        const configContent = JSON.stringify({
          scoring: {
            decayHalfLifeDays: 30
          }
        });
        await writeFile(env.configPath, configContent);

        const config = await loadConfig();

        // 3 events from 90 days ago (3 half-lives = 0.125 each, total 0.375)
        const bullet = createTestBullet({
          feedbackEvents: [
            createTestFeedbackEvent("helpful", 90),
            createTestFeedbackEvent("helpful", 90),
            createTestFeedbackEvent("helpful", 90)
          ]
        });

        const maturity = calculateMaturityState(bullet, config);
        // Decayed total < 3, should be candidate
        expect(maturity).toBe("candidate");
      });
    });
  });

  describe("Score distribution analysis with config", () => {
    it("analyzes bullets using config-driven scoring", async () => {
      await withTempCassHome(async (env: TestEnv) => {
        await writeFile(env.configPath, JSON.stringify({}));
        const config = await loadConfig();

        // Create bullets with varying scores
        const bullets = [
          // Excellent: 12 helpful = 12 * 0.5 (candidate) = 6... need established for 1.0 multiplier
          createTestBullet({
            maturity: "established",
            feedbackEvents: Array(12).fill(null).map(() => createTestFeedbackEvent("helpful", 0))
          }),
          // Good: 6 helpful * 1.0 = 6
          createTestBullet({
            maturity: "established",
            feedbackEvents: Array(6).fill(null).map(() => createTestFeedbackEvent("helpful", 0))
          }),
          // Neutral: 2 helpful * 1.0 = 2
          createTestBullet({
            maturity: "established",
            feedbackEvents: [
              createTestFeedbackEvent("helpful", 0),
              createTestFeedbackEvent("helpful", 0)
            ]
          }),
          // At-risk: 2 harmful * 4 = -8 * 1.0 = -8
          createTestBullet({
            maturity: "established",
            feedbackEvents: [
              createTestFeedbackEvent("harmful", 0),
              createTestFeedbackEvent("harmful", 0)
            ]
          })
        ];

        const distribution = analyzeScoreDistribution(bullets, config);

        expect(distribution.excellent).toBe(1);
        expect(distribution.good).toBe(1);
        expect(distribution.neutral).toBe(1);
        expect(distribution.atRisk).toBe(1);
      });
    });
  });

  describe("Staleness detection (config-independent)", () => {
    it("detects stale bullets based on feedback recency", () => {
      // Note: isStale uses direct staleDays parameter, not config
      const staleBullet = createTestBullet({
        createdAt: daysAgo(100),
        feedbackEvents: [
          createTestFeedbackEvent("helpful", 100) // Last feedback 100 days ago
        ]
      });

      const freshBullet = createTestBullet({
        createdAt: daysAgo(100),
        feedbackEvents: [
          createTestFeedbackEvent("helpful", 10) // Recent feedback
        ]
      });

      expect(isStale(staleBullet, 90)).toBe(true);
      expect(isStale(freshBullet, 90)).toBe(false);
    });
  });

  describe("End-to-end: Config file to scoring decision", () => {
    it("complete flow: load config, score bullets, make decisions", async () => {
      await withTempCassHome(async (env: TestEnv) => {
        // Set up realistic config
        const configContent = JSON.stringify({
          pruneHarmfulThreshold: 5,
          scoring: {
            decayHalfLifeDays: 60,
            harmfulMultiplier: 3
          }
        });
        await writeFile(env.configPath, configContent);

        const config = await loadConfig();

        // Verify config loaded correctly
        expect(config.pruneHarmfulThreshold).toBe(5);
        expect(config.scoring.decayHalfLifeDays).toBe(60);
        expect(config.scoring.harmfulMultiplier).toBe(3);

        // Create test bullet
        const bullet = createTestBullet({
          maturity: "established",
          feedbackEvents: [
            createTestFeedbackEvent("helpful", 0),
            createTestFeedbackEvent("helpful", 30), // Half-decayed
            createTestFeedbackEvent("harmful", 0)
          ]
        });

        // Calculate scores using loaded config
        const { decayedHelpful, decayedHarmful } = getDecayedCounts(bullet, config);
        const score = getEffectiveScore(bullet, config);

        // 1 helpful at 0 days = 1.0, 1 helpful at 30 days (half of 60-day half-life) = ~0.71
        // Total helpful ~1.71
        expect(decayedHelpful).toBeCloseTo(1.71, 1);
        expect(decayedHarmful).toBeCloseTo(1.0, 1);

        // Score = (1.71 - 3*1.0) * 1.0 (established) = -1.29
        expect(score).toBeCloseTo(-1.29, 1);

        // Check promotion/demotion
        const promotion = checkForPromotion(bullet, config);
        const demotion = checkForDemotion(bullet, config);

        expect(promotion).toBe("established"); // No promotion with negative score
        expect(demotion).toBe("candidate"); // Should demote due to negative score
      });
    });
  });
});
