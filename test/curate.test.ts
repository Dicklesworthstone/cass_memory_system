import { describe, it, expect, beforeEach } from "bun:test";
import { curatePlaybook } from "../src/curate";
import { Playbook, PlaybookDelta, Config } from "../src/types";
import {
  createTestConfig,
  createTestBullet,
  createTestPlaybook,
  createFeedbackEvent,
  daysAgo
} from "./helpers/factories";

describe("curatePlaybook", () => {
  let config: Config;
  let emptyPlaybook: Playbook;

  beforeEach(() => {
    config = createTestConfig();
    emptyPlaybook = createTestPlaybook();
  });

  // =========================================================================
  // DELTA HANDLING: ADD
  // =========================================================================
  describe("add delta", () => {
    it("adds a new bullet to empty playbook", () => {
      const delta: PlaybookDelta = {
        type: "add",
        bullet: {
          content: "Always use TypeScript strict mode",
          category: "typescript",
          scope: "global",
          kind: "workflow_rule"
        },
        sourceSession: "/session/1.jsonl",
        reason: "Learned from session"
      };

      const result = curatePlaybook(emptyPlaybook, [delta], config);

      expect(result.applied).toBe(1);
      expect(result.skipped).toBe(0);
      expect(result.playbook.bullets).toHaveLength(1);
      expect(result.playbook.bullets[0].content).toBe("Always use TypeScript strict mode");
      expect(result.playbook.bullets[0].category).toBe("typescript");
    });

    it("skips exact duplicate content", () => {
      const existingBullet = createTestBullet({
        content: "Use const instead of let",
        category: "style"
      });
      const playbook = createTestPlaybook([existingBullet]);

      const delta: PlaybookDelta = {
        type: "add",
        bullet: {
          content: "Use const instead of let", // Exact same content
          category: "style",
          scope: "global",
          kind: "workflow_rule"
        },
        sourceSession: "/session/1.jsonl",
        reason: "Duplicate"
      };

      const result = curatePlaybook(playbook, [delta], config);

      expect(result.applied).toBe(0);
      expect(result.skipped).toBe(1);
      expect(result.playbook.bullets).toHaveLength(1);
    });

    it("reinforces similar bullet instead of adding duplicate", () => {
      const existingBullet = createTestBullet({
        id: "existing-1",
        content: "Always use const for variables that won't change",
        category: "style",
        helpfulCount: 2,
        feedbackEvents: [
          createFeedbackEvent("helpful"),
          createFeedbackEvent("helpful")
        ]
      });
      const playbook = createTestPlaybook([existingBullet]);

      // Similar content (high Jaccard similarity)
      const delta: PlaybookDelta = {
        type: "add",
        bullet: {
          content: "Always use const for variables that will not change",
          category: "style",
          scope: "global",
          kind: "workflow_rule"
        },
        sourceSession: "/session/2.jsonl",
        reason: "Similar insight"
      };

      // Lower threshold to catch similarity
      const configWithLowThreshold = createTestConfig({ dedupSimilarityThreshold: 0.7 });
      const result = curatePlaybook(playbook, [delta], configWithLowThreshold);

      expect(result.applied).toBe(1); // Reinforcement counts as applied
      expect(result.playbook.bullets).toHaveLength(1); // No new bullet
      expect(result.playbook.bullets[0].helpfulCount).toBe(3); // Reinforced
      expect(result.playbook.bullets[0].feedbackEvents).toHaveLength(3);
    });

    it("skips delta with missing content", () => {
      const delta: PlaybookDelta = {
        type: "add",
        bullet: {
          content: "", // Empty content
          category: "style",
          scope: "global",
          kind: "workflow_rule"
        },
        sourceSession: "/session/1.jsonl",
        reason: "Invalid"
      };

      const result = curatePlaybook(emptyPlaybook, [delta], config);

      expect(result.applied).toBe(0);
      expect(result.skipped).toBe(1);
      expect(result.playbook.bullets).toHaveLength(0);
    });

    it("skips delta with missing category", () => {
      const delta: PlaybookDelta = {
        type: "add",
        bullet: {
          content: "Some rule",
          category: "", // Empty category
          scope: "global",
          kind: "workflow_rule"
        },
        sourceSession: "/session/1.jsonl",
        reason: "Invalid"
      };

      const result = curatePlaybook(emptyPlaybook, [delta], config);

      expect(result.applied).toBe(0);
      expect(result.skipped).toBe(1);
    });

    it("adds multiple unique bullets", () => {
      const deltas: PlaybookDelta[] = [
        {
          type: "add",
          bullet: { content: "Always use TypeScript strict mode for type safety", category: "typescript", scope: "global", kind: "workflow_rule" },
          sourceSession: "/s/1.jsonl",
          reason: "r1"
        },
        {
          type: "add",
          bullet: { content: "Prefer async/await over raw promises for readability", category: "javascript", scope: "global", kind: "workflow_rule" },
          sourceSession: "/s/2.jsonl",
          reason: "r2"
        },
        {
          type: "add",
          bullet: { content: "Use meaningful variable names that describe their purpose", category: "style", scope: "global", kind: "workflow_rule" },
          sourceSession: "/s/3.jsonl",
          reason: "r3"
        }
      ];

      const result = curatePlaybook(emptyPlaybook, deltas, config);

      expect(result.applied).toBe(3);
      expect(result.skipped).toBe(0);
      expect(result.playbook.bullets).toHaveLength(3);
    });
  });

  // =========================================================================
  // DELTA HANDLING: HELPFUL
  // =========================================================================
  describe("helpful delta", () => {
    it("records helpful feedback for existing bullet", () => {
      const bullet = createTestBullet({
        id: "bullet-1",
        content: "Test rule",
        helpfulCount: 0,
        feedbackEvents: []
      });
      const playbook = createTestPlaybook([bullet]);

      const delta: PlaybookDelta = {
        type: "helpful",
        bulletId: "bullet-1",
        sourceSession: "/session/1.jsonl",
        context: "Worked great"
      };

      const result = curatePlaybook(playbook, [delta], config);

      expect(result.applied).toBe(1);
      expect(result.playbook.bullets[0].helpfulCount).toBe(1);
      expect(result.playbook.bullets[0].feedbackEvents).toHaveLength(1);
      expect(result.playbook.bullets[0].feedbackEvents[0].type).toBe("helpful");
    });

    it("is idempotent - skips duplicate feedback from same session", () => {
      const bullet = createTestBullet({
        id: "bullet-1",
        content: "Test rule",
        helpfulCount: 1,
        feedbackEvents: [
          createFeedbackEvent("helpful", { sessionPath: "/session/1.jsonl" })
        ]
      });
      const playbook = createTestPlaybook([bullet]);

      const delta: PlaybookDelta = {
        type: "helpful",
        bulletId: "bullet-1",
        sourceSession: "/session/1.jsonl", // Same session
        context: "Duplicate"
      };

      const result = curatePlaybook(playbook, [delta], config);

      expect(result.applied).toBe(0);
      expect(result.skipped).toBe(1);
      expect(result.playbook.bullets[0].helpfulCount).toBe(1); // Unchanged
    });

    it("allows feedback from different sessions", () => {
      const bullet = createTestBullet({
        id: "bullet-1",
        content: "Test rule",
        helpfulCount: 1,
        feedbackEvents: [
          createFeedbackEvent("helpful", { sessionPath: "/session/1.jsonl" })
        ]
      });
      const playbook = createTestPlaybook([bullet]);

      const delta: PlaybookDelta = {
        type: "helpful",
        bulletId: "bullet-1",
        sourceSession: "/session/2.jsonl", // Different session
        context: "Also worked"
      };

      const result = curatePlaybook(playbook, [delta], config);

      expect(result.applied).toBe(1);
      expect(result.playbook.bullets[0].helpfulCount).toBe(2);
      expect(result.playbook.bullets[0].feedbackEvents).toHaveLength(2);
    });

    it("skips feedback for non-existent bullet", () => {
      const playbook = createTestPlaybook([]);

      const delta: PlaybookDelta = {
        type: "helpful",
        bulletId: "non-existent",
        sourceSession: "/session/1.jsonl",
        context: "Does not exist"
      };

      const result = curatePlaybook(playbook, [delta], config);

      expect(result.applied).toBe(0);
      expect(result.skipped).toBe(1);
    });
  });

  // =========================================================================
  // DELTA HANDLING: HARMFUL
  // =========================================================================
  describe("harmful delta", () => {
    it("records harmful feedback for existing bullet", () => {
      const bullet = createTestBullet({
        id: "bullet-1",
        content: "Bad rule",
        harmfulCount: 0,
        feedbackEvents: []
      });
      const playbook = createTestPlaybook([bullet]);

      const delta: PlaybookDelta = {
        type: "harmful",
        bulletId: "bullet-1",
        sourceSession: "/session/1.jsonl",
        reason: "outdated",
        context: "Caused problems"
      };

      const result = curatePlaybook(playbook, [delta], config);

      expect(result.applied).toBe(1);
      expect(result.playbook.bullets[0].harmfulCount).toBe(1);
      expect(result.playbook.bullets[0].feedbackEvents).toHaveLength(1);
      expect(result.playbook.bullets[0].feedbackEvents[0].type).toBe("harmful");
      expect(result.playbook.bullets[0].feedbackEvents[0].reason).toBe("outdated");
    });

    it("is idempotent - skips duplicate harmful feedback", () => {
      const bullet = createTestBullet({
        id: "bullet-1",
        content: "Bad rule",
        harmfulCount: 1,
        feedbackEvents: [
          createFeedbackEvent("harmful", { sessionPath: "/session/1.jsonl" })
        ]
      });
      const playbook = createTestPlaybook([bullet]);

      const delta: PlaybookDelta = {
        type: "harmful",
        bulletId: "bullet-1",
        sourceSession: "/session/1.jsonl",
        reason: "outdated"
      };

      const result = curatePlaybook(playbook, [delta], config);

      expect(result.applied).toBe(0);
      expect(result.skipped).toBe(1);
      expect(result.playbook.bullets[0].harmfulCount).toBe(1);
    });
  });

  // =========================================================================
  // DELTA HANDLING: REPLACE
  // =========================================================================
  describe("replace delta", () => {
    it("replaces bullet content", () => {
      const bullet = createTestBullet({
        id: "bullet-1",
        content: "Old content"
      });
      const playbook = createTestPlaybook([bullet]);

      const delta: PlaybookDelta = {
        type: "replace",
        bulletId: "bullet-1",
        newContent: "New improved content",
        reason: "Updated"
      };

      const result = curatePlaybook(playbook, [delta], config);

      expect(result.applied).toBe(1);
      expect(result.playbook.bullets[0].content).toBe("New improved content");
    });

    it("skips replace for non-existent bullet", () => {
      const playbook = createTestPlaybook([]);

      const delta: PlaybookDelta = {
        type: "replace",
        bulletId: "non-existent",
        newContent: "New content",
        reason: "Does not exist"
      };

      const result = curatePlaybook(playbook, [delta], config);

      expect(result.applied).toBe(0);
      expect(result.skipped).toBe(1);
    });
  });

  // =========================================================================
  // DELTA HANDLING: DEPRECATE
  // =========================================================================
  describe("deprecate delta", () => {
    it("deprecates existing bullet", () => {
      const bullet = createTestBullet({
        id: "bullet-1",
        content: "Old rule",
        deprecated: false
      });
      const playbook = createTestPlaybook([bullet]);

      const delta: PlaybookDelta = {
        type: "deprecate",
        bulletId: "bullet-1",
        reason: "No longer relevant"
      };

      const result = curatePlaybook(playbook, [delta], config);

      expect(result.applied).toBe(1);
      expect(result.playbook.bullets[0].deprecated).toBe(true);
      expect(result.playbook.bullets[0].maturity).toBe("deprecated");
    });

    it("skips deprecate for non-existent bullet", () => {
      const playbook = createTestPlaybook([]);

      const delta: PlaybookDelta = {
        type: "deprecate",
        bulletId: "non-existent",
        reason: "Does not exist"
      };

      const result = curatePlaybook(playbook, [delta], config);

      expect(result.applied).toBe(0);
      expect(result.skipped).toBe(1);
    });
  });

  // =========================================================================
  // DELTA HANDLING: MERGE
  // =========================================================================
  describe("merge delta", () => {
    it("merges multiple bullets into one", () => {
      const bullet1 = createTestBullet({
        id: "bullet-1",
        content: "Use const",
        category: "style",
        tags: ["javascript"]
      });
      const bullet2 = createTestBullet({
        id: "bullet-2",
        content: "Avoid var",
        category: "style",
        tags: ["best-practice"]
      });
      const playbook = createTestPlaybook([bullet1, bullet2]);

      const delta: PlaybookDelta = {
        type: "merge",
        bulletIds: ["bullet-1", "bullet-2"],
        mergedContent: "Use const instead of var for better scoping",
        reason: "Consolidating related rules"
      };

      const result = curatePlaybook(playbook, [delta], config);

      expect(result.applied).toBe(1);
      // Original bullets deprecated + new merged bullet
      expect(result.playbook.bullets).toHaveLength(3);

      const merged = result.playbook.bullets.find(b => !b.deprecated && b.content.includes("const instead of var"));
      expect(merged).toBeDefined();
      expect(merged?.tags).toContain("javascript");
      expect(merged?.tags).toContain("best-practice");

      // Original bullets should be deprecated
      expect(result.playbook.bullets.find(b => b.id === "bullet-1")?.deprecated).toBe(true);
      expect(result.playbook.bullets.find(b => b.id === "bullet-2")?.deprecated).toBe(true);
    });

    it("skips merge if not all bullets exist", () => {
      const bullet1 = createTestBullet({
        id: "bullet-1",
        content: "Rule 1"
      });
      const playbook = createTestPlaybook([bullet1]);

      const delta: PlaybookDelta = {
        type: "merge",
        bulletIds: ["bullet-1", "non-existent"],
        mergedContent: "Merged rule",
        reason: "Missing bullet"
      };

      const result = curatePlaybook(playbook, [delta], config);

      expect(result.applied).toBe(0);
      expect(result.skipped).toBe(1);
      expect(result.playbook.bullets[0].deprecated).toBe(false);
    });

    it("skips merge with fewer than 2 bullets", () => {
      const bullet1 = createTestBullet({ id: "bullet-1" });
      const playbook = createTestPlaybook([bullet1]);

      const delta: PlaybookDelta = {
        type: "merge",
        bulletIds: ["bullet-1"], // Only one bullet
        mergedContent: "Single merge",
        reason: "Invalid"
      };

      const result = curatePlaybook(playbook, [delta], config);

      expect(result.applied).toBe(0);
      expect(result.skipped).toBe(1);
    });
  });

  // =========================================================================
  // ANTI-PATTERN INVERSION
  // =========================================================================
  describe("anti-pattern inversion", () => {
    it("inverts bullet with high harmful count", () => {
      const now = new Date().toISOString();
      const harmfulBullet = createTestBullet({
        id: "harmful-1",
        content: "Use var for all variables",
        category: "style",
        harmfulCount: 5,
        helpfulCount: 0,
        feedbackEvents: [
          createFeedbackEvent("harmful", { timestamp: now }),
          createFeedbackEvent("harmful", { timestamp: now }),
          createFeedbackEvent("harmful", { timestamp: now }),
          createFeedbackEvent("harmful", { timestamp: now }),
          createFeedbackEvent("harmful", { timestamp: now })
        ]
      });
      const playbook = createTestPlaybook([harmfulBullet]);

      const result = curatePlaybook(playbook, [], config);

      expect(result.inversions).toHaveLength(1);
      expect(result.inversions[0].originalId).toBe("harmful-1");

      const antiPattern = result.playbook.bullets.find(b => b.kind === "anti_pattern");
      expect(antiPattern).toBeDefined();
      expect(antiPattern?.content).toContain("AVOID:");
      expect(antiPattern?.isNegative).toBe(true);
      expect(antiPattern?.tags).toContain("inverted");
    });

    it("does not invert bullet with balanced feedback", () => {
      const now = new Date().toISOString();
      const balancedBullet = createTestBullet({
        id: "balanced-1",
        content: "Some rule",
        harmfulCount: 3,
        helpfulCount: 3, // Balanced - harmful not > 2*helpful
        feedbackEvents: [
          createFeedbackEvent("harmful", { timestamp: now }),
          createFeedbackEvent("harmful", { timestamp: now }),
          createFeedbackEvent("harmful", { timestamp: now }),
          createFeedbackEvent("helpful", { timestamp: now }),
          createFeedbackEvent("helpful", { timestamp: now }),
          createFeedbackEvent("helpful", { timestamp: now })
        ]
      });
      const playbook = createTestPlaybook([balancedBullet]);

      const result = curatePlaybook(playbook, [], config);

      expect(result.inversions).toHaveLength(0);
    });

    it("does not invert pinned bullets", () => {
      const now = new Date().toISOString();
      const pinnedBullet = createTestBullet({
        id: "pinned-1",
        content: "Important rule",
        pinned: true, // Pinned
        harmfulCount: 10,
        helpfulCount: 0,
        feedbackEvents: Array(10).fill(null).map(() =>
          createFeedbackEvent("harmful", { timestamp: now })
        )
      });
      const playbook = createTestPlaybook([pinnedBullet]);

      const result = curatePlaybook(playbook, [], config);

      expect(result.inversions).toHaveLength(0);
    });

    it("does not invert already-inverted anti-patterns", () => {
      const now = new Date().toISOString();
      const existingAntiPattern = createTestBullet({
        id: "anti-1",
        content: "AVOID: Using var",
        kind: "anti_pattern",
        harmfulCount: 5,
        feedbackEvents: Array(5).fill(null).map(() =>
          createFeedbackEvent("harmful", { timestamp: now })
        )
      });
      const playbook = createTestPlaybook([existingAntiPattern]);

      const result = curatePlaybook(playbook, [], config);

      expect(result.inversions).toHaveLength(0);
    });

    it("applies configured decay half-life to inverted anti-patterns", () => {
      const now = new Date().toISOString();
      const harmfulBullet = createTestBullet({
        id: "harmful-1",
        content: "Use var",
        harmfulCount: 5,
        feedbackEvents: Array(5).fill(null).map(() =>
          createFeedbackEvent("harmful", { timestamp: now })
        )
      });
      const playbook = createTestPlaybook([harmfulBullet]);

      const customConfig = createTestConfig({
        scoring: {
          ...config.scoring,
          decayHalfLifeDays: 45
        }
      });

      const result = curatePlaybook(playbook, [], customConfig);

      const antiPattern = result.playbook.bullets.find(b => b.kind === "anti_pattern");
      expect(antiPattern?.confidenceDecayHalfLifeDays).toBe(45);
    });

    it("does not invert when harmful events are stale and decayed", () => {
      const staleDate = new Date(Date.now() - 200 * 86_400_000).toISOString(); // ~200 days ago
      const bullet = createTestBullet({
        id: "harmful-stale",
        content: "Use var everywhere",
        harmfulCount: 5,
        helpfulCount: 0,
        feedbackEvents: Array(5).fill(null).map(() =>
          createFeedbackEvent("harmful", { timestamp: staleDate })
        )
      });
      const playbook = createTestPlaybook([bullet]);

      const result = curatePlaybook(playbook, [], config);

      // No inversions because decayed harmful falls below threshold
      expect(result.inversions).toHaveLength(0);
      // Bullet should remain non-deprecated/non-inverted
      const original = result.playbook.bullets.find(b => b.id === "harmful-stale");
      expect(original?.deprecated).toBe(false);
      expect(original?.kind).not.toBe("anti_pattern");
    });
  });

  // =========================================================================
  // MATURITY TRANSITIONS
  // =========================================================================
  describe("maturity transitions", () => {
    it("promotes candidate to established with sufficient feedback", () => {
      const now = new Date().toISOString();
      const bullet = createTestBullet({
        id: "candidate-1",
        content: "Good rule",
        maturity: "candidate",
        helpfulCount: 3,
        harmfulCount: 0,
        feedbackEvents: [
          createFeedbackEvent("helpful", { timestamp: now }),
          createFeedbackEvent("helpful", { timestamp: now }),
          createFeedbackEvent("helpful", { timestamp: now })
        ]
      });
      const playbook = createTestPlaybook([bullet]);

      const result = curatePlaybook(playbook, [], config);

      expect(result.playbook.bullets[0].maturity).toBe("established");
      expect(result.promotions).toHaveLength(1);
      expect(result.promotions[0].from).toBe("candidate");
      expect(result.promotions[0].to).toBe("established");
    });

    it("promotes established to proven with many helpful", () => {
      const now = new Date().toISOString();
      const bullet = createTestBullet({
        id: "established-1",
        content: "Great rule",
        maturity: "established",
        helpfulCount: 12,
        harmfulCount: 0,
        feedbackEvents: Array(12).fill(null).map(() =>
          createFeedbackEvent("helpful", { timestamp: now })
        )
      });
      const playbook = createTestPlaybook([bullet]);

      const result = curatePlaybook(playbook, [], config);

      expect(result.playbook.bullets[0].maturity).toBe("proven");
    });

    it("auto-deprecates bullet with very negative score", () => {
      const now = new Date().toISOString();
      const badBullet = createTestBullet({
        id: "bad-1",
        content: "Terrible rule",
        maturity: "candidate",
        harmfulCount: 10,
        helpfulCount: 0,
        pinned: false, // Not pinned so it can be deprecated
        feedbackEvents: Array(10).fill(null).map(() =>
          createFeedbackEvent("harmful", { timestamp: now })
        )
      });
      const playbook = createTestPlaybook([badBullet]);

      // With harmful multiplier of 4, score = 0 - 4*10 = -40, well below threshold
      const result = curatePlaybook(playbook, [], config);

      // Should either be inverted OR auto-deprecated
      const bullet = result.playbook.bullets.find(b => b.id === "bad-1");
      expect(bullet?.deprecated || result.inversions.length > 0).toBe(true);
    });

    it("increments pruned count when auto-deprecation occurs via demotion", () => {
      const now = new Date().toISOString();
      const badBullet = createTestBullet({
        id: "bad-2",
        content: "Very harmful rule",
        maturity: "established",
        harmfulCount: 5,
        helpfulCount: 3,
        pinned: false,
        feedbackEvents: [
          // Harmful dominant enough to force negative score (< -pruneHarmfulThreshold)
          createFeedbackEvent("harmful", { timestamp: now }),
          createFeedbackEvent("harmful", { timestamp: now }),
          createFeedbackEvent("harmful", { timestamp: now }),
          createFeedbackEvent("harmful", { timestamp: now }),
          createFeedbackEvent("harmful", { timestamp: now }),
          createFeedbackEvent("helpful", { timestamp: now }),
          createFeedbackEvent("helpful", { timestamp: now }),
          createFeedbackEvent("helpful", { timestamp: now }),
        ]
      });
      const playbook = createTestPlaybook([badBullet]);

      const result = curatePlaybook(playbook, [], config);

      const target = result.playbook.bullets.find(b => b.id === "bad-2");
      expect(target?.deprecated).toBe(true);
      expect(result.pruned).toBeGreaterThanOrEqual(1);
    });
  });

  // =========================================================================
  // EDGE CASES
  // =========================================================================
  describe("edge cases", () => {
    it("handles empty deltas array", () => {
      const bullet = createTestBullet({ id: "bullet-1" });
      const playbook = createTestPlaybook([bullet]);

      const result = curatePlaybook(playbook, [], config);

      expect(result.applied).toBe(0);
      expect(result.skipped).toBe(0);
      expect(result.playbook.bullets).toHaveLength(1);
    });

    it("handles empty playbook", () => {
      const result = curatePlaybook(emptyPlaybook, [], config);

      expect(result.applied).toBe(0);
      expect(result.skipped).toBe(0);
      expect(result.playbook.bullets).toHaveLength(0);
    });

    it("uses context playbook for dedup when provided", () => {
      const targetPlaybook = createTestPlaybook([]);
      const contextPlaybook = createTestPlaybook([
        createTestBullet({
          id: "context-1",
          content: "Rule from context"
        })
      ]);

      // Try to add a duplicate of what's in context
      const delta: PlaybookDelta = {
        type: "add",
        bullet: {
          content: "Rule from context", // Same as context
          category: "test",
          scope: "global",
          kind: "workflow_rule"
        },
        sourceSession: "/s/1.jsonl",
        reason: "Dup"
      };

      const result = curatePlaybook(targetPlaybook, [delta], config, contextPlaybook);

      expect(result.skipped).toBe(1);
      expect(result.applied).toBe(0);
      expect(targetPlaybook.bullets).toHaveLength(0);
    });

    it("handles mixed valid and invalid deltas", () => {
      const bullet = createTestBullet({ id: "bullet-1", content: "Existing" });
      const playbook = createTestPlaybook([bullet]);

      const deltas: PlaybookDelta[] = [
        { // Valid add
          type: "add",
          bullet: { content: "New rule", category: "test", scope: "global", kind: "workflow_rule" },
          sourceSession: "/s/1.jsonl",
          reason: "Valid"
        },
        { // Invalid - missing content
          type: "add",
          bullet: { content: "", category: "test", scope: "global", kind: "workflow_rule" },
          sourceSession: "/s/2.jsonl",
          reason: "Invalid"
        },
        { // Valid helpful
          type: "helpful",
          bulletId: "bullet-1",
          sourceSession: "/s/3.jsonl"
        },
        { // Invalid - non-existent bullet
          type: "helpful",
          bulletId: "non-existent",
          sourceSession: "/s/4.jsonl"
        }
      ];

      const result = curatePlaybook(playbook, deltas, config);

      expect(result.applied).toBe(2); // add + helpful
      expect(result.skipped).toBe(2); // invalid add + non-existent helpful
    });

    it("does not double-deprecate inverted bullets", () => {
      const now = new Date().toISOString();
      // Bullet that will be inverted AND would trigger auto-deprecate
      const badBullet = createTestBullet({
        id: "bad-1",
        content: "Very bad rule",
        maturity: "candidate",
        harmfulCount: 10,
        helpfulCount: 0,
        feedbackEvents: Array(10).fill(null).map(() =>
          createFeedbackEvent("harmful", { timestamp: now })
        )
      });
      const playbook = createTestPlaybook([badBullet]);

      const result = curatePlaybook(playbook, [], config);

      // Should be inverted, not double-processed
      const originalBullet = result.playbook.bullets.find(b => b.id === "bad-1");
      expect(originalBullet?.deprecated).toBe(true);

      // Should only have one inversion
      expect(result.inversions.length).toBeLessThanOrEqual(1);
    });
  });

  // =========================================================================
  // RESULT COUNTING
  // =========================================================================
  describe("result counting", () => {
    it("correctly counts applied and skipped", () => {
      const bullet = createTestBullet({ id: "bullet-1", content: "Existing" });
      const playbook = createTestPlaybook([bullet]);

      const deltas: PlaybookDelta[] = [
        { type: "add", bullet: { content: "New 1", category: "c", scope: "global", kind: "workflow_rule" }, sourceSession: "/s/1.jsonl", reason: "r" },
        { type: "add", bullet: { content: "New 2", category: "c", scope: "global", kind: "workflow_rule" }, sourceSession: "/s/2.jsonl", reason: "r" },
        { type: "add", bullet: { content: "Existing", category: "c", scope: "global", kind: "workflow_rule" }, sourceSession: "/s/3.jsonl", reason: "dup" }, // Duplicate
        { type: "helpful", bulletId: "bullet-1", sourceSession: "/s/4.jsonl" },
        { type: "helpful", bulletId: "non-existent", sourceSession: "/s/5.jsonl" } // Skip
      ];

      const result = curatePlaybook(playbook, deltas, config);

      expect(result.applied).toBe(3); // 2 adds + 1 helpful
      expect(result.skipped).toBe(2); // 1 duplicate + 1 non-existent
    });
  });

  // =========================================================================
  // DECISION LOGGING
  // =========================================================================
  describe("decision logging", () => {
    it("includes decisionLog in result", () => {
      const result = curatePlaybook(emptyPlaybook, [], config);

      expect(result.decisionLog).toBeDefined();
      expect(Array.isArray(result.decisionLog)).toBe(true);
    });

    it("logs accepted add decisions", () => {
      const delta: PlaybookDelta = {
        type: "add",
        bullet: {
          content: "Test rule for logging",
          category: "test",
          scope: "global",
          kind: "workflow_rule"
        },
        sourceSession: "/session/1.jsonl",
        reason: "Test"
      };

      const result = curatePlaybook(emptyPlaybook, [delta], config);

      expect(result.decisionLog).toBeDefined();
      const addDecision = result.decisionLog?.find(d =>
        d.phase === "add" && d.action === "accepted"
      );
      expect(addDecision).toBeDefined();
      expect(addDecision?.content).toContain("Test rule");
    });

    it("logs rejected duplicate decisions", () => {
      const existingBullet = createTestBullet({
        content: "Existing rule",
        category: "test"
      });
      const playbook = createTestPlaybook([existingBullet]);

      const delta: PlaybookDelta = {
        type: "add",
        bullet: {
          content: "Existing rule", // Duplicate
          category: "test",
          scope: "global",
          kind: "workflow_rule"
        },
        sourceSession: "/session/1.jsonl",
        reason: "Dup"
      };

      const result = curatePlaybook(playbook, [delta], config);

      expect(result.decisionLog).toBeDefined();
      const dupDecision = result.decisionLog?.find(d =>
        d.phase === "dedup" && d.action === "skipped"
      );
      expect(dupDecision).toBeDefined();
      expect(dupDecision?.reason).toContain("duplicate");
    });

    it("logs feedback recording decisions", () => {
      const bullet = createTestBullet({
        id: "bullet-1",
        content: "Test rule"
      });
      const playbook = createTestPlaybook([bullet]);

      const delta: PlaybookDelta = {
        type: "helpful",
        bulletId: "bullet-1",
        sourceSession: "/session/1.jsonl"
      };

      const result = curatePlaybook(playbook, [delta], config);

      expect(result.decisionLog).toBeDefined();
      const feedbackDecision = result.decisionLog?.find(d =>
        d.phase === "feedback" && d.action === "accepted"
      );
      expect(feedbackDecision).toBeDefined();
      expect(feedbackDecision?.bulletId).toBe("bullet-1");
    });

    it("logs promotion decisions", () => {
      const now = new Date().toISOString();
      const bullet = createTestBullet({
        id: "candidate-1",
        content: "Promotable rule",
        maturity: "candidate",
        helpfulCount: 3,
        feedbackEvents: [
          createFeedbackEvent("helpful", { timestamp: now }),
          createFeedbackEvent("helpful", { timestamp: now }),
          createFeedbackEvent("helpful", { timestamp: now })
        ]
      });
      const playbook = createTestPlaybook([bullet]);

      const result = curatePlaybook(playbook, [], config);

      expect(result.decisionLog).toBeDefined();
      const promotionDecision = result.decisionLog?.find(d =>
        d.phase === "promotion" && d.action === "accepted"
      );
      expect(promotionDecision).toBeDefined();
      expect(promotionDecision?.bulletId).toBe("candidate-1");
    });

    it("logs inversion decisions", () => {
      const now = new Date().toISOString();
      const harmfulBullet = createTestBullet({
        id: "harmful-1",
        content: "Bad rule",
        harmfulCount: 5,
        feedbackEvents: Array(5).fill(null).map(() =>
          createFeedbackEvent("harmful", { timestamp: now })
        )
      });
      const playbook = createTestPlaybook([harmfulBullet]);

      const result = curatePlaybook(playbook, [], config);

      expect(result.decisionLog).toBeDefined();
      const inversionDecision = result.decisionLog?.find(d =>
        d.phase === "inversion" && d.action === "accepted"
      );
      expect(inversionDecision).toBeDefined();
      expect(inversionDecision?.bulletId).toBe("harmful-1");
    });

    it("includes timestamp in all log entries", () => {
      const delta: PlaybookDelta = {
        type: "add",
        bullet: {
          content: "Timestamped rule",
          category: "test",
          scope: "global",
          kind: "workflow_rule"
        },
        sourceSession: "/session/1.jsonl",
        reason: "Test"
      };

      const result = curatePlaybook(emptyPlaybook, [delta], config);

      expect(result.decisionLog).toBeDefined();
      for (const entry of result.decisionLog || []) {
        expect(entry.timestamp).toBeDefined();
        expect(typeof entry.timestamp).toBe("string");
        // Should be a valid ISO date
        expect(new Date(entry.timestamp).getTime()).not.toBeNaN();
      }
    });
  });
});
