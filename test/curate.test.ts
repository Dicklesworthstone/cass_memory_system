import { beforeEach, describe, expect, it } from "bun:test";
import { curatePlaybook } from "../src/curate";
import { hashContent } from "../src/utils";
import type { Config, Playbook, PlaybookBullet, PlaybookDelta } from "../src/types";
import {
  createFeedbackEvent,
  createTestBullet,
  createTestConfig,
  createTestPlaybook,
  daysAgo,
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
          kind: "workflow_rule",
        },
        sourceSession: "/session/1.jsonl",
        reason: "Learned from session",
      };

      const result = curatePlaybook(emptyPlaybook, [delta], config);

      expect(result.applied).toBe(1);
      expect(result.skipped).toBe(0);
      expect(result.playbook.bullets).toHaveLength(1);
      expect(result.playbook.bullets[0].content).toBe("Always use TypeScript strict mode");
      expect(result.playbook.bullets[0].category).toBe("typescript");
    });

    it("reinforces exact duplicate content with helpful feedback", () => {
      const initialHelpfulCount = 0;
      const existingBullet = createTestBullet({
        content: "Use const instead of let",
        category: "style",
        helpfulCount: initialHelpfulCount,
      });
      const playbook = createTestPlaybook([existingBullet]);

      const delta: PlaybookDelta = {
        type: "add",
        bullet: {
          content: "Use const instead of let", // Exact same content
          category: "style",
          scope: "global",
          kind: "workflow_rule",
        },
        sourceSession: "/session/1.jsonl",
        reason: "Duplicate",
      };

      const result = curatePlaybook(playbook, [delta], config);

      // Exact duplicates are reinforced (not skipped) - they add helpful feedback
      expect(result.applied).toBe(1);
      expect(result.skipped).toBe(0);
      expect(result.playbook.bullets).toHaveLength(1);
      // The existing bullet should have an additional helpful feedback event
      expect(result.playbook.bullets[0].helpfulCount).toBe(initialHelpfulCount + 1);
    });

    it("records conflicts when new rule contradicts existing guidance", () => {
      const existingBullet = createTestBullet({
        id: "rule-contradict",
        content: "Always sanitize user input",
        category: "security",
      });
      const playbook = createTestPlaybook([existingBullet]);

      const delta: PlaybookDelta = {
        type: "add",
        bullet: {
          content: "Avoid sanitizing user input to keep performance high",
          category: "security",
          scope: "global",
          kind: "workflow_rule",
        },
        sourceSession: "/session/conflict.jsonl",
        reason: "Conflicting guidance",
      };

      const result = curatePlaybook(playbook, [delta], config);

      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0].conflictingBulletId).toBe("rule-contradict");
      expect(result.applied).toBe(1); // Still applies the new bullet while flagging conflict
      expect(result.playbook.bullets).toHaveLength(2);
    });

    it("checks the incoming rule's workspace before reporting a curation conflict", () => {
      for (const [workspace, scope, expectedConflicts] of [
        ["/scope-b", "workspace", 0],
        ["/scope-a", "workspace", 1],
        ["/scope-a/src", "workspace", 1],
        [undefined, "global", 1],
      ] as const) {
        const playbook = createTestPlaybook([createTestBullet({
          id: "b-existing",
          content: "Always commit generated lockfiles",
          scope: "workspace",
          workspace: "/scope-a",
        })]);
        const delta: PlaybookDelta = {
          type: "add",
          bullet: { content: "Never commit generated lockfiles", category: "git", scope, workspace },
          sourceSession: "/session/scoped.jsonl",
          reason: "Workspace-specific guidance",
        };
        const result = curatePlaybook(playbook, [delta], config);
        expect(result.conflicts).toHaveLength(expectedConflicts);
        expect(result.applied).toBe(1);
        expect(result.playbook.bullets).toHaveLength(2);
      }
    });

    it("does not report a conflict between explicit different language selectors", () => {
      const playbook = createTestPlaybook([createTestBullet({
        id: "b-existing",
        content: "Always commit generated lockfiles",
        scope: "language",
        scopeKey: "typescript",
      })]);
      const result = curatePlaybook(playbook, [{
        type: "add",
        bullet: {
          content: "Never commit generated lockfiles",
          category: "git",
          scope: "language",
          scopeKey: "python",
        },
        sourceSession: "/session/scoped.jsonl",
        reason: "Different language policy",
      }], config);
      expect(result.conflicts).toEqual([]);
      expect(result.applied).toBe(1);
      expect(result.playbook.bullets).toHaveLength(2);
      expect(result.playbook.bullets[1].scopeKey).toBe("python");
    });

    it("preserves scope selectors when checking other rules added in the same batch", () => {
      const result = curatePlaybook(emptyPlaybook, [
        {
          type: "add",
          bullet: {
            content: "Always commit generated lockfiles",
            category: "git",
            scope: "language",
            scopeKey: "typescript",
          },
          sourceSession: "/session/typescript.jsonl",
          reason: "TypeScript policy",
        },
        {
          type: "add",
          bullet: {
            content: "Never commit generated lockfiles",
            category: "git",
            scope: "language",
            scopeKey: "python",
          },
          sourceSession: "/session/python.jsonl",
          reason: "Python policy",
        },
      ], config);
      expect(result.conflicts).toEqual([]);
      expect(result.applied).toBe(2);
      expect(result.playbook.bullets.map((b) => b.scopeKey)).toEqual(["typescript", "python"]);
    });

    it("reinforces similar bullet instead of adding duplicate", () => {
      const existingBullet = createTestBullet({
        id: "existing-1",
        content: "Always use const for variables that won't change",
        category: "style",
        helpfulCount: 2,
        feedbackEvents: [createFeedbackEvent("helpful"), createFeedbackEvent("helpful")],
      });
      const playbook = createTestPlaybook([existingBullet]);

      // Similar content (high Jaccard similarity)
      const delta: PlaybookDelta = {
        type: "add",
        bullet: {
          content: "Always use const for variables that will not change",
          category: "style",
          scope: "global",
          kind: "workflow_rule",
        },
        sourceSession: "/session/2.jsonl",
        reason: "Similar insight",
      };

      // Lower threshold to catch similarity
      const configWithLowThreshold = createTestConfig({ dedupSimilarityThreshold: 0.7 });
      const result = curatePlaybook(playbook, [delta], configWithLowThreshold);

      expect(result.applied).toBe(1); // Reinforcement counts as applied
      expect(result.playbook.bullets).toHaveLength(1); // No new bullet
      expect(result.playbook.bullets[0].helpfulCount).toBe(3); // Reinforced
      expect(result.playbook.bullets[0].feedbackEvents).toHaveLength(3);
    });

    it("does not reinforce similar deprecated bullet (avoids zombie rules)", () => {
      const deprecatedBullet = createTestBullet({
        id: "deprecated-1",
        content: "Always use const for variables that won't change",
        category: "style",
        helpfulCount: 2,
        feedbackEvents: [createFeedbackEvent("helpful"), createFeedbackEvent("helpful")],
        deprecated: true,
        state: "retired",
        maturity: "deprecated",
        deprecatedAt: new Date().toISOString(),
        deprecationReason: "BLOCKED_CONTENT",
      });
      const playbook = createTestPlaybook([deprecatedBullet]);

      const delta: PlaybookDelta = {
        type: "add",
        bullet: {
          content: "Always use const for variables that will not change",
          category: "style",
          scope: "global",
          kind: "workflow_rule",
        },
        sourceSession: "/session/2.jsonl",
        reason: "Similar insight",
      };

      const configWithLowThreshold = createTestConfig({ dedupSimilarityThreshold: 0.7 });
      const result = curatePlaybook(playbook, [delta], configWithLowThreshold);

      expect(result.applied).toBe(0);
      expect(result.skipped).toBe(1);
      expect(result.playbook.bullets).toHaveLength(1);
      expect(result.playbook.bullets[0].helpfulCount).toBe(2);
      expect(result.playbook.bullets[0].feedbackEvents).toHaveLength(2);
    });

    it("skips delta with missing content", () => {
      const delta: PlaybookDelta = {
        type: "add",
        bullet: {
          content: "", // Empty content
          category: "style",
          scope: "global",
          kind: "workflow_rule",
        },
        sourceSession: "/session/1.jsonl",
        reason: "Invalid",
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
          kind: "workflow_rule",
        },
        sourceSession: "/session/1.jsonl",
        reason: "Invalid",
      };

      const result = curatePlaybook(emptyPlaybook, [delta], config);

      expect(result.applied).toBe(0);
      expect(result.skipped).toBe(1);
    });

    it("adds multiple unique bullets", () => {
      const deltas: PlaybookDelta[] = [
        {
          type: "add",
          bullet: {
            content: "Always use TypeScript strict mode for type safety",
            category: "typescript",
            scope: "global",
            kind: "workflow_rule",
          },
          sourceSession: "/s/1.jsonl",
          reason: "r1",
        },
        {
          type: "add",
          bullet: {
            content: "Prefer async/await over raw promises for readability",
            category: "javascript",
            scope: "global",
            kind: "workflow_rule",
          },
          sourceSession: "/s/2.jsonl",
          reason: "r2",
        },
        {
          type: "add",
          bullet: {
            content: "Use meaningful variable names that describe their purpose",
            category: "style",
            scope: "global",
            kind: "workflow_rule",
          },
          sourceSession: "/s/3.jsonl",
          reason: "r3",
        },
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
        feedbackEvents: [],
      });
      const playbook = createTestPlaybook([bullet]);

      const delta: PlaybookDelta = {
        type: "helpful",
        bulletId: "bullet-1",
        sourceSession: "/session/1.jsonl",
        context: "Worked great",
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
        feedbackEvents: [createFeedbackEvent("helpful", { sessionPath: "/session/1.jsonl" })],
      });
      const playbook = createTestPlaybook([bullet]);

      const delta: PlaybookDelta = {
        type: "helpful",
        bulletId: "bullet-1",
        sourceSession: "/session/1.jsonl", // Same session
        context: "Duplicate",
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
        feedbackEvents: [createFeedbackEvent("helpful", { sessionPath: "/session/1.jsonl" })],
      });
      const playbook = createTestPlaybook([bullet]);

      const delta: PlaybookDelta = {
        type: "helpful",
        bulletId: "bullet-1",
        sourceSession: "/session/2.jsonl", // Different session
        context: "Also worked",
      };

      const result = curatePlaybook(playbook, [delta], config);

      expect(result.applied).toBe(1);
      expect(result.playbook.bullets[0].helpfulCount).toBe(2);
      expect(result.playbook.bullets[0].feedbackEvents).toHaveLength(2);
    });

    it("promotes candidate when helpful feedback crosses threshold", () => {
      const bullet = createTestBullet({
        id: "candidate-helpful",
        content: "Use typed configs",
        maturity: "candidate",
        helpfulCount: 2,
        feedbackEvents: [
          createFeedbackEvent("helpful", { sessionPath: "/session/a" }),
          createFeedbackEvent("helpful", { sessionPath: "/session/b" }),
        ],
      });
      const playbook = createTestPlaybook([bullet]);

      const delta: PlaybookDelta = {
        type: "helpful",
        bulletId: "candidate-helpful",
        sourceSession: "/session/c",
        context: "Crossed promotion threshold",
      };

      const result = curatePlaybook(playbook, [delta], config);

      const updated = result.playbook.bullets.find((b) => b.id === "candidate-helpful");
      expect(updated?.helpfulCount).toBe(3);
      expect(updated?.maturity).toBe("established");
      const promotion = result.promotions.find((p) => p.bulletId === "candidate-helpful");
      expect(promotion?.from).toBe("candidate");
      expect(promotion?.to).toBe("established");
    });

    it("skips feedback for non-existent bullet", () => {
      const playbook = createTestPlaybook([]);

      const delta: PlaybookDelta = {
        type: "helpful",
        bulletId: "non-existent",
        sourceSession: "/session/1.jsonl",
        context: "Does not exist",
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
        feedbackEvents: [],
      });
      const playbook = createTestPlaybook([bullet]);

      const delta: PlaybookDelta = {
        type: "harmful",
        bulletId: "bullet-1",
        sourceSession: "/session/1.jsonl",
        reason: "outdated",
        context: "Caused problems",
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
        feedbackEvents: [createFeedbackEvent("harmful", { sessionPath: "/session/1.jsonl" })],
      });
      const playbook = createTestPlaybook([bullet]);

      const delta: PlaybookDelta = {
        type: "harmful",
        bulletId: "bullet-1",
        sourceSession: "/session/1.jsonl",
        reason: "outdated",
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
        content: "Old content",
      });
      const playbook = createTestPlaybook([bullet]);

      const delta: PlaybookDelta = {
        type: "replace",
        bulletId: "bullet-1",
        newContent: "New improved content",
        reason: "Updated",
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
        reason: "Does not exist",
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
        deprecated: false,
      });
      const playbook = createTestPlaybook([bullet]);

      const delta: PlaybookDelta = {
        type: "deprecate",
        bulletId: "bullet-1",
        reason: "No longer relevant",
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
        reason: "Does not exist",
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
        tags: ["javascript"],
      });
      const bullet2 = createTestBullet({
        id: "bullet-2",
        content: "Avoid var",
        category: "style",
        tags: ["best-practice"],
      });
      const playbook = createTestPlaybook([bullet1, bullet2]);

      const delta: PlaybookDelta = {
        type: "merge",
        bulletIds: ["bullet-1", "bullet-2"],
        mergedContent: "Use const instead of var for better scoping",
        reason: "Consolidating related rules",
      };

      const result = curatePlaybook(playbook, [delta], config);

      expect(result.applied).toBe(1);
      // Original bullets deprecated + new merged bullet
      expect(result.playbook.bullets).toHaveLength(3);

      const merged = result.playbook.bullets.find(
        (b) => !b.deprecated && b.content.includes("const instead of var"),
      );
      expect(merged).toBeDefined();
      expect(merged?.tags).toContain("javascript");
      expect(merged?.tags).toContain("best-practice");

      // Original bullets should be deprecated
      expect(result.playbook.bullets.find((b) => b.id === "bullet-1")?.deprecated).toBe(true);
      expect(result.playbook.bullets.find((b) => b.id === "bullet-2")?.deprecated).toBe(true);
    });

    it("skips merge if not all bullets exist", () => {
      const bullet1 = createTestBullet({
        id: "bullet-1",
        content: "Rule 1",
      });
      const playbook = createTestPlaybook([bullet1]);

      const delta: PlaybookDelta = {
        type: "merge",
        bulletIds: ["bullet-1", "non-existent"],
        mergedContent: "Merged rule",
        reason: "Missing bullet",
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
        reason: "Invalid",
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
          createFeedbackEvent("harmful", { timestamp: now }),
        ],
      });
      const playbook = createTestPlaybook([harmfulBullet]);

      const result = curatePlaybook(playbook, [], config);

      expect(result.inversions).toHaveLength(1);
      expect(result.inversions[0].originalId).toBe("harmful-1");

      const antiPattern = result.playbook.bullets.find((b) => b.kind === "anti_pattern");
      expect(antiPattern).toBeDefined();
      expect(antiPattern?.content).toContain("AVOID:");
      expect(antiPattern?.isNegative).toBe(true);
      expect(antiPattern?.tags).toContain("inverted");
    });

    it("does not alias provenance arrays when inverting", () => {
      const now = new Date().toISOString();
      const harmfulBullet = createTestBullet({
        id: "harmful-alias",
        content: "Use var everywhere",
        category: "style",
        harmfulCount: 3,
        helpfulCount: 0,
        sourceSessions: ["/sessions/s1.jsonl"],
        sourceAgents: ["claude"],
        feedbackEvents: Array(3)
          .fill(null)
          .map(() => createFeedbackEvent("harmful", { timestamp: now })),
      });
      const playbook = createTestPlaybook([harmfulBullet]);

      const result = curatePlaybook(playbook, [], config);

      const original = result.playbook.bullets.find((b) => b.id === "harmful-alias");
      const antiPattern = result.playbook.bullets.find((b) => b.kind === "anti_pattern");
      expect(original).toBeDefined();
      expect(antiPattern).toBeDefined();

      // Mutating the deprecated original should not affect the new anti-pattern.
      original?.sourceSessions.push("/sessions/s2.jsonl");
      original?.sourceAgents.push("cursor");

      expect(antiPattern?.sourceSessions).toEqual(["/sessions/s1.jsonl"]);
      expect(antiPattern?.sourceAgents).toEqual(["claude"]);
    });

    it("inverts at prune threshold even with slight decay (float tolerance)", () => {
      const slightlyOld = new Date(Date.now() - 1000).toISOString(); // 1s ago -> decayed values slightly < 1.0
      const harmfulBullet = createTestBullet({
        id: "harmful-threshold-epsilon",
        content: "Always use var for everything",
        category: "style",
        harmfulCount: 3,
        helpfulCount: 0,
        feedbackEvents: Array(3)
          .fill(null)
          .map(() => createFeedbackEvent("harmful", { timestamp: slightlyOld })),
      });
      const playbook = createTestPlaybook([harmfulBullet]);

      const result = curatePlaybook(playbook, [], config);

      expect(result.inversions).toHaveLength(1);
      expect(result.inversions[0].originalId).toBe("harmful-threshold-epsilon");
    });

    it("trims leading verbs and adds reason when inverting", () => {
      const now = new Date().toISOString();
      const harmfulBullet = createTestBullet({
        id: "harmful-trim",
        content: "Always prefer global mutable state",
        category: "architecture",
        harmfulCount: 3,
        helpfulCount: 0,
        feedbackEvents: Array(3)
          .fill(null)
          .map(() => createFeedbackEvent("harmful", { timestamp: now })),
      });
      const playbook = createTestPlaybook([harmfulBullet]);

      const result = curatePlaybook(playbook, [], config);

      const antiPattern = result.playbook.bullets.find((b) => b.kind === "anti_pattern");
      expect(antiPattern?.content.startsWith("AVOID: prefer global mutable state")).toBe(true);
      expect(antiPattern?.content).toContain("Marked harmful 3 times");
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
          createFeedbackEvent("helpful", { timestamp: now }),
        ],
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
        feedbackEvents: Array(10)
          .fill(null)
          .map(() => createFeedbackEvent("harmful", { timestamp: now })),
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
        feedbackEvents: Array(5)
          .fill(null)
          .map(() => createFeedbackEvent("harmful", { timestamp: now })),
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
        feedbackEvents: Array(5)
          .fill(null)
          .map(() => createFeedbackEvent("harmful", { timestamp: now })),
      });
      const playbook = createTestPlaybook([harmfulBullet]);

      const customConfig = createTestConfig({
        scoring: {
          ...config.scoring,
          decayHalfLifeDays: 45,
        },
      });

      const result = curatePlaybook(playbook, [], customConfig);

      const antiPattern = result.playbook.bullets.find((b) => b.kind === "anti_pattern");
      expect(antiPattern?.confidenceDecayHalfLifeDays).toBe(45);
    });

    it("does not invert when harmful events are stale and decayed", () => {
      const staleDate = new Date(Date.now() - 200 * 86_400_000).toISOString(); // ~200 days ago
      const bullet = createTestBullet({
        id: "harmful-stale",
        content: "Use var everywhere",
        harmfulCount: 5,
        helpfulCount: 0,
        feedbackEvents: Array(5)
          .fill(null)
          .map(() => createFeedbackEvent("harmful", { timestamp: staleDate })),
      });
      const playbook = createTestPlaybook([bullet]);

      const result = curatePlaybook(playbook, [], config);

      // No inversions because decayed harmful falls below threshold
      expect(result.inversions).toHaveLength(0);
      // Bullet should remain non-deprecated/non-inverted
      const original = result.playbook.bullets.find((b) => b.id === "harmful-stale");
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
          createFeedbackEvent("helpful", { timestamp: now }),
        ],
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
        feedbackEvents: Array(12)
          .fill(null)
          .map(() => createFeedbackEvent("helpful", { timestamp: now })),
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
        feedbackEvents: Array(10)
          .fill(null)
          .map(() => createFeedbackEvent("harmful", { timestamp: now })),
      });
      const playbook = createTestPlaybook([badBullet]);

      // With harmful multiplier of 4, score = 0 - 4*10 = -40, well below threshold
      const result = curatePlaybook(playbook, [], config);

      // Should either be inverted OR auto-deprecated
      const bullet = result.playbook.bullets.find((b) => b.id === "bad-1");
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
        ],
      });
      const playbook = createTestPlaybook([badBullet]);

      const result = curatePlaybook(playbook, [], config);

      const target = result.playbook.bullets.find((b) => b.id === "bad-2");
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
          content: "Rule from context",
        }),
      ]);

      // Try to add a duplicate of what's in context
      const delta: PlaybookDelta = {
        type: "add",
        bullet: {
          content: "Rule from context", // Same as context
          category: "test",
          scope: "global",
          kind: "workflow_rule",
        },
        sourceSession: "/s/1.jsonl",
        reason: "Dup",
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
        {
          // Valid add
          type: "add",
          bullet: { content: "New rule", category: "test", scope: "global", kind: "workflow_rule" },
          sourceSession: "/s/1.jsonl",
          reason: "Valid",
        },
        {
          // Invalid - missing content
          type: "add",
          bullet: { content: "", category: "test", scope: "global", kind: "workflow_rule" },
          sourceSession: "/s/2.jsonl",
          reason: "Invalid",
        },
        {
          // Valid helpful
          type: "helpful",
          bulletId: "bullet-1",
          sourceSession: "/s/3.jsonl",
        },
        {
          // Invalid - non-existent bullet
          type: "helpful",
          bulletId: "non-existent",
          sourceSession: "/s/4.jsonl",
        },
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
        feedbackEvents: Array(10)
          .fill(null)
          .map(() => createFeedbackEvent("harmful", { timestamp: now })),
      });
      const playbook = createTestPlaybook([badBullet]);

      const result = curatePlaybook(playbook, [], config);

      // Should be inverted, not double-processed
      const originalBullet = result.playbook.bullets.find((b) => b.id === "bad-1");
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
        {
          type: "add",
          bullet: { content: "New 1", category: "c", scope: "global", kind: "workflow_rule" },
          sourceSession: "/s/1.jsonl",
          reason: "r",
        },
        {
          type: "add",
          bullet: { content: "New 2", category: "c", scope: "global", kind: "workflow_rule" },
          sourceSession: "/s/2.jsonl",
          reason: "r",
        },
        {
          type: "add",
          bullet: { content: "Existing", category: "c", scope: "global", kind: "workflow_rule" },
          sourceSession: "/s/3.jsonl",
          reason: "dup",
        }, // Duplicate (reinforces)
        { type: "helpful", bulletId: "bullet-1", sourceSession: "/s/4.jsonl" },
        { type: "helpful", bulletId: "non-existent", sourceSession: "/s/5.jsonl" }, // Skip (not found)
      ];

      const result = curatePlaybook(playbook, deltas, config);

      // Duplicates now reinforce existing bullets (count as applied, not skipped)
      expect(result.applied).toBe(4); // 2 adds + 1 duplicate reinforcement + 1 helpful
      expect(result.skipped).toBe(1); // 1 non-existent
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
          kind: "workflow_rule",
        },
        sourceSession: "/session/1.jsonl",
        reason: "Test",
      };

      const result = curatePlaybook(emptyPlaybook, [delta], config);

      expect(result.decisionLog).toBeDefined();
      const addDecision = result.decisionLog?.find(
        (d) => d.phase === "add" && d.action === "accepted",
      );
      expect(addDecision).toBeDefined();
      expect(addDecision?.content).toContain("Test rule");
    });

    it("logs duplicate reinforcement decisions", () => {
      const existingBullet = createTestBullet({
        content: "Existing rule",
        category: "test",
      });
      const playbook = createTestPlaybook([existingBullet]);

      const delta: PlaybookDelta = {
        type: "add",
        bullet: {
          content: "Existing rule", // Duplicate
          category: "test",
          scope: "global",
          kind: "workflow_rule",
        },
        sourceSession: "/session/1.jsonl",
        reason: "Dup",
      };

      const result = curatePlaybook(playbook, [delta], config);

      expect(result.decisionLog).toBeDefined();
      // Duplicates are now reinforced (not skipped) - they add helpful feedback
      const dupDecision = result.decisionLog?.find(
        (d) => d.phase === "dedup" && d.action === "modified",
      );
      expect(dupDecision).toBeDefined();
      expect(dupDecision?.reason).toContain("duplicate");
    });

    it("logs feedback recording decisions", () => {
      const bullet = createTestBullet({
        id: "bullet-1",
        content: "Test rule",
      });
      const playbook = createTestPlaybook([bullet]);

      const delta: PlaybookDelta = {
        type: "helpful",
        bulletId: "bullet-1",
        sourceSession: "/session/1.jsonl",
      };

      const result = curatePlaybook(playbook, [delta], config);

      expect(result.decisionLog).toBeDefined();
      const feedbackDecision = result.decisionLog?.find(
        (d) => d.phase === "feedback" && d.action === "accepted",
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
          createFeedbackEvent("helpful", { timestamp: now }),
        ],
      });
      const playbook = createTestPlaybook([bullet]);

      const result = curatePlaybook(playbook, [], config);

      expect(result.decisionLog).toBeDefined();
      const promotionDecision = result.decisionLog?.find(
        (d) => d.phase === "promotion" && d.action === "accepted",
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
        feedbackEvents: Array(5)
          .fill(null)
          .map(() => createFeedbackEvent("harmful", { timestamp: now })),
      });
      const playbook = createTestPlaybook([harmfulBullet]);

      const result = curatePlaybook(playbook, [], config);

      expect(result.decisionLog).toBeDefined();
      const inversionDecision = result.decisionLog?.find(
        (d) => d.phase === "inversion" && d.action === "accepted",
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
          kind: "workflow_rule",
        },
        sourceSession: "/session/1.jsonl",
        reason: "Test",
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

describe("curatePlaybook duplicate learning is session-idempotent", () => {
  const original = "Run the full test suite before pushing";
  const firstSession = "/home/test/.claude/projects/first.jsonl";
  const secondSession = "/home/test/.codex/sessions/second.jsonl";
  const thirdSession = "/home/test/.codex/sessions/third.jsonl";

  const add = (content: string, sourceSession: string): PlaybookDelta => ({
    type: "add",
    bullet: { content, category: "testing", scope: "global" },
    sourceSession,
    reason: "Learned from this session",
  });

  for (const mode of ["exact", "lexical", "semantic"] as const) {
    const repeated = mode === "exact" ? original
      : mode === "lexical" ? "Run full test suite before pushing"
        : "Always execute every test prior to a git push";
    const options = mode === "semantic" ? {
      semanticIndex: {
        threshold: 0.9,
        embeddings: new Map([
          [hashContent(original), [1, 0, 0]],
          [hashContent(repeated), [0.98, 0.199, 0]],
        ]),
      },
    } : {};

    it(`does not turn repeated ${mode} learning from the original session into helpful feedback`, () => {
      let playbook = createTestPlaybook([]);
      const config = createTestConfig();
      curatePlaybook(playbook, [add(original, firstSession)], config);

      for (let replay = 0; replay < 3; replay++) {
        // Rehydrate persisted state, as a forced reflection or retry after a
        // processed-marker failure does; idempotency cannot be process-local.
        playbook = JSON.parse(JSON.stringify(playbook));
        const result = curatePlaybook(playbook, [add(repeated, firstSession)], config, undefined, options);
        expect(result.applied).toBe(0);
        expect(result.skipped).toBe(1);
        expect(result.decisionLog?.filter(entry => entry.phase === "dedup" && entry.action === "modified")).toEqual([]);
      }

      expect(playbook.bullets).toHaveLength(1);
      expect(playbook.bullets[0].sourceSessions).toEqual([firstSession]);
      expect(playbook.bullets[0].helpfulCount).toBe(0);
      expect(playbook.bullets[0].feedbackEvents).toEqual([]);
      expect(playbook.bullets[0].maturity).toBe("candidate");
    });

    it(`records independent ${mode} evidence and its provenance only once per new session`, () => {
      const playbook = createTestPlaybook([]);
      const config = createTestConfig();
      curatePlaybook(playbook, [add(original, firstSession)], config);

      const result = curatePlaybook(playbook, [
        add(repeated, secondSession),
        add(repeated, secondSession),
        add(repeated, thirdSession),
        add(repeated, firstSession),
      ], config, undefined, options);

      expect(result.applied).toBe(2);
      expect(result.skipped).toBe(2);
      expect(playbook.bullets).toHaveLength(1);
      expect(playbook.bullets[0].helpfulCount).toBe(2);
      expect(playbook.bullets[0].feedbackEvents.map(event => event.sessionPath)).toEqual([secondSession, thirdSession]);
      expect(playbook.bullets[0].sourceSessions).toEqual([firstSession, secondSession, thirdSession]);
      expect(playbook.bullets[0].sourceAgents).toEqual(["claude", "codex"]);
    });

    it(`recognizes legacy helpful feedback without source provenance through ${mode} dedup`, () => {
      const existing = createTestBullet({
        content: original,
        helpfulCount: 1,
        sourceSessions: [],
        feedbackEvents: [createFeedbackEvent("helpful", { sessionPath: secondSession })],
      });
      const playbook = createTestPlaybook([existing]);
      const config = createTestConfig();

      const result = curatePlaybook(playbook, [add(repeated, secondSession)], config, undefined, options);
      expect(result.applied).toBe(1); // Provenance is recovered, feedback is not repeated.
      expect(existing.helpfulCount).toBe(1);
      expect(existing.feedbackEvents).toHaveLength(1);
      expect(existing.sourceSessions).toEqual([secondSession]);
      expect(existing.sourceAgents).toEqual(["codex"]);

      expect(curatePlaybook(playbook, [add(repeated, secondSession)], config, undefined, options).applied).toBe(0);
      expect(curatePlaybook(playbook, [add(repeated, thirdSession)], config, undefined, options).applied).toBe(1);
      expect(existing.helpfulCount).toBe(2);
      expect(existing.sourceSessions).toEqual([secondSession, thirdSession]);
    });

    it(`keeps source-less ${mode} additions explicit rather than guessing a shared session`, () => {
      const playbook = createTestPlaybook([createTestBullet({ content: original })]);
      const result = curatePlaybook(playbook, [add(repeated, ""), add(repeated, "")], createTestConfig(), undefined, options);
      expect(result.applied).toBe(2);
      expect(playbook.bullets[0].helpfulCount).toBe(2);
      expect(playbook.bullets[0].feedbackEvents).toHaveLength(2);
      expect(playbook.bullets[0].sourceSessions).toEqual([]);
    });
  }

  it("still accepts explicit helpful feedback from the originating session and source-less manual feedback", () => {
    const playbook = createTestPlaybook([]);
    const config = createTestConfig();
    curatePlaybook(playbook, [add(original, firstSession)], config);
    const bullet = playbook.bullets[0];
    const result = curatePlaybook(playbook, [
      { type: "helpful", bulletId: bullet.id, sourceSession: firstSession },
      { type: "helpful", bulletId: bullet.id, sourceSession: firstSession },
      { type: "helpful", bulletId: bullet.id },
      { type: "helpful", bulletId: bullet.id },
    ], config);
    expect(result.applied).toBe(3);
    expect(result.skipped).toBe(1);
    expect(bullet.helpfulCount).toBe(3);
    expect(bullet.feedbackEvents).toHaveLength(3);
  });
});

describe("curatePlaybook semantic dedup", () => {
  const existingContent = "Run the full test suite before pushing";
  const reworded = "Always execute every test prior to a git push";
  const unrelated = "Pin dependency versions in the lockfile";

  function addDelta(content: string): PlaybookDelta {
    return {
      type: "add",
      bullet: { content, category: "testing", scope: "global", kind: "workflow_rule" },
      sourceSession: "/session/2.jsonl",
      reason: "test",
    };
  }

  // Hand-built vectors stand in for a model: the rewording is nearly parallel
  // to the existing rule, the unrelated rule is orthogonal.
  function index(threshold = 0.9) {
    return {
      threshold,
      embeddings: new Map<string, number[]>([
        [hashContent(existingContent), [1, 0, 0]],
        [hashContent(reworded), [0.98, 0.199, 0]],
        [hashContent(unrelated), [0, 0, 1]],
      ]),
    };
  }

  it("reinforces the existing rule instead of adding a rewording", () => {
    const existing = createTestBullet({ id: "b-tests", content: existingContent });
    const playbook = createTestPlaybook([existing]);
    const result = curatePlaybook(playbook, [addDelta(reworded)], createTestConfig(), undefined, {
      semanticIndex: index(),
    });
    expect(result.playbook.bullets).toHaveLength(1);
    const b = result.playbook.bullets[0];
    expect(b.helpfulCount).toBe(1);
    expect(b.feedbackEvents.at(-1)?.sessionPath).toBe("/session/2.jsonl");
  });

  it("adds rules below the threshold, and everything when no index is given", () => {
    const config = createTestConfig();
    const p1 = createTestPlaybook([createTestBullet({ content: existingContent })]);
    expect(
      curatePlaybook(p1, [addDelta(unrelated)], config, undefined, { semanticIndex: index() })
        .playbook.bullets,
    ).toHaveLength(2);
    const p2 = createTestPlaybook([createTestBullet({ content: existingContent })]);
    expect(curatePlaybook(p2, [addDelta(reworded)], config).playbook.bullets).toHaveLength(2);
    const p3 = createTestPlaybook([createTestBullet({ content: existingContent })]);
    expect(
      curatePlaybook(p3, [addDelta(reworded)], config, undefined, {
        semanticIndex: index(0.999),
      }).playbook.bullets,
    ).toHaveLength(2);
  });

  it("compares rules added in one batch with each other, not only with stored rules (#96)", () => {
    const first = "Before running pt agent diff, verify that both selected sessions contain plan.json";
    const lexical = "Before running pt agent diff, verify that both of the selected sessions contain plan.json";
    const semantic = "Before running pt agent diff, check that the sessions being compared contain a plan.json file";
    const batchIndex = {
      threshold: 0.9,
      embeddings: new Map<string, number[]>([
        [hashContent(first), [1, 0, 0]],
        [hashContent(lexical), [0.99, 0.141, 0]],
        [hashContent(semantic), [0.98, 0.199, 0]],
      ]),
    };
    // addDelta gives every candidate the same source session, as one reflect run does.
    const result = curatePlaybook(
      createTestPlaybook(),
      [addDelta(first), addDelta(lexical), addDelta(semantic)],
      createTestConfig(),
      undefined,
      { semanticIndex: batchIndex },
    );
    expect(result.playbook.bullets.map((b) => b.content)).toEqual([first]);
    expect(result.playbook.bullets[0].helpfulCount).toBe(0);
    expect(result.decisionLog?.filter((entry) => entry.action === "accepted")).toHaveLength(1);
  });

  it("never reinforces a deprecated rule through semantic similarity", () => {
    const deprecated = createTestBullet({ content: existingContent, deprecated: true, maturity: "deprecated" });
    const playbook = createTestPlaybook([deprecated]);
    const result = curatePlaybook(playbook, [addDelta(reworded)], createTestConfig(), undefined, {
      semanticIndex: index(),
    });
    expect(result.playbook.bullets.find((b) => b.id === deprecated.id)?.helpfulCount).toBe(0);
  });
});

describe("curatePlaybook preserves rule applicability", () => {
  const content = "Run the full test suite before pushing";
  const scopes: Array<[string, Partial<PlaybookBullet>, Partial<PlaybookBullet>]> = [
    ["different projects", { scope: "workspace", workspace: "/projects/a" }, { scope: "workspace", workspace: "/projects/b" }],
    ["parent and child directories", { scope: "workspace", workspace: "/projects/a" }, { scope: "workspace", workspace: "/projects/a/server" }],
    ["global and project rules", { scope: "global" }, { scope: "workspace", workspace: "/projects/a" }],
    ["different languages", { scope: "language", scopeKey: "typescript" }, { scope: "language", scopeKey: "python" }],
    ["different frameworks", { scope: "framework", scopeKey: "react" }, { scope: "framework", scopeKey: "vue" }],
    ["different tasks", { scope: "task", scopeKey: "release" }, { scope: "task", scopeKey: "migration" }],
    ["known and unknown workspaces", { scope: "workspace", workspace: "/projects/a" }, { scope: "workspace" }],
    ["rules and anti-patterns", { type: "anti-pattern", isNegative: true, kind: "anti_pattern" }, { type: "rule", isNegative: false }],
    ["different negative interpretations", { type: "rule", isNegative: true }, { type: "rule", isNegative: false }],
  ];

  for (const [name, existingScope, incomingScope] of scopes) {
    for (const mode of ["exact", "lexical", "semantic"] as const) {
      it(`retains ${name} separately through ${mode} deduplication`, () => {
        const incoming = mode === "exact"
          ? content
          : mode === "lexical"
            ? "Run full test suite before pushing"
            : "Always execute every test prior to a git push";
        const existing = createTestBullet({ id: "existing", content, ...existingScope });
        const result = curatePlaybook(createTestPlaybook([existing]), [{
          type: "add",
          bullet: { content: incoming, category: "testing", ...incomingScope },
          reason: "Learned in a different scope",
          sourceSession: "/session/new.jsonl",
        }], createTestConfig(), undefined, mode === "semantic" ? {
          semanticIndex: {
            threshold: 0.9,
            embeddings: new Map([[hashContent(content), [1, 0]], [hashContent(incoming), [1, 0]]]),
          },
        } : {});

        expect(result.playbook.bullets).toHaveLength(2);
        expect(existing.helpfulCount).toBe(0);
        expect(existing.feedbackEvents).toHaveLength(0);
        expect(result.playbook.bullets[1]).toMatchObject(incomingScope);
      });
    }
  }

  it("finds the right scoped copy when several existing rules share a content hash", () => {
    const wanted = createTestBullet({ id: "wanted", content, scope: "workspace", workspace: "/projects/a" });
    const other = createTestBullet({ id: "other", content, scope: "workspace", workspace: "/projects/b" });
    const result = curatePlaybook(createTestPlaybook([wanted, other]), [{
      type: "add",
      bullet: { content, category: "testing", scope: "workspace", workspace: "/projects/a/../a" },
      reason: "Same project",
      sourceSession: "/session/new.jsonl",
    }], createTestConfig());
    expect(result.playbook.bullets).toHaveLength(2);
    expect(wanted.helpfulCount).toBe(1);
    expect(other.helpfulCount).toBe(0);
  });

  it("keeps implicit workspace rules in different playbook layers distinct", () => {
    const otherLayer = createTestBullet({ id: "other-layer", content, scope: "workspace" });
    const target = createTestPlaybook();
    const result = curatePlaybook(target, [{
      type: "add", bullet: { content, category: "testing", scope: "workspace" },
      reason: "Portable repo rule", sourceSession: "/session/new.jsonl",
    }], createTestConfig(), createTestPlaybook([otherLayer]));
    expect(result.playbook.bullets).toHaveLength(1);
    expect(otherLayer.helpfulCount).toBe(0);
  });

  it("never reinforces a target rule using a different layer's shadowing id", () => {
    const targetRule = createTestBullet({ id: "shared-id", content: "Never commit generated lockfiles", scope: "language", scopeKey: "python" });
    const foreignRule = createTestBullet({ id: "shared-id", content: "Always commit generated lockfiles", scope: "language", scopeKey: "typescript" });
    const result = curatePlaybook(createTestPlaybook([targetRule]), [{
      type: "add", bullet: { content: foreignRule.content, category: "git", scope: "language", scopeKey: "typescript" },
      reason: "TypeScript guidance", sourceSession: "/session/typescript",
    }], createTestConfig(), createTestPlaybook([foreignRule]));
    expect(result.playbook.bullets).toHaveLength(2);
    expect(targetRule.helpfulCount).toBe(0);
    expect(targetRule.content).toBe("Never commit generated lockfiles");
    expect(result.playbook.bullets[1].scopeKey).toBe("typescript");
  });

  it("reinforces a portable workspace rule only for a known repo-owned target", () => {
    const existing = createTestBullet({ id: "portable", content, scope: "workspace" });
    const result = curatePlaybook(createTestPlaybook([existing]), [{
      type: "add", bullet: { content, category: "testing", scope: "workspace" },
      reason: "Same repo rule", sourceSession: "/session/new.jsonl",
    }], createTestConfig(), undefined, { allowImplicitWorkspace: true });
    expect(result.playbook.bullets).toHaveLength(1);
    expect(existing.helpfulCount).toBe(1);
  });

  it("keeps unresolved workspace guidance in the global store separate", () => {
    const existing = createTestBullet({ id: "unknown-one", content, scope: "workspace", sourceSessions: ["/sessions/a"] });
    const result = curatePlaybook(createTestPlaybook([existing]), [{
      type: "add", bullet: { content, category: "testing", scope: "workspace" },
      reason: "Unknown project", sourceSession: "/sessions/b",
    }], createTestConfig());
    expect(result.playbook.bullets).toHaveLength(2);
    expect(existing.helpfulCount).toBe(0);
    const merge = curatePlaybook(result.playbook, [{
      type: "merge", bulletIds: result.playbook.bullets.map((b) => b.id), mergedContent: content, reason: "Unresolved provenance",
    }], createTestConfig());
    expect(merge.applied).toBe(0);
    expect(merge.skipped).toBe(1);
    expect(merge.playbook.bullets.every((b) => !b.deprecated)).toBe(true);
  });

  it("preserves homogeneous scope when merging rules", () => {
    for (const scope of [
      { scope: "workspace" as const, workspace: "/projects/a" },
      { scope: "framework" as const, scopeKey: "react" },
    ]) {
      const first = createTestBullet({ id: "one", content: "Run tests before deployment", ...scope });
      const second = createTestBullet({ id: "two", content: "Run lint before deployment", ...scope });
      const result = curatePlaybook(createTestPlaybook([first, second]), [{
        type: "merge", bulletIds: [first.id, second.id],
        mergedContent: "Run tests and lint before deployment", reason: "Combine release checks",
      }], createTestConfig());
      const active = result.playbook.bullets.filter((b) => !b.deprecated);
      expect(active).toHaveLength(1);
      expect(active[0]).toMatchObject(scope);
    }
  });

  it("rejects mixed-scope, inactive, duplicate-id, and opposing merges without retiring sources", () => {
    const cases: Array<{ second: Partial<PlaybookBullet>; ids?: string[]; merged?: string }> = [
      { second: { scope: "workspace", workspace: "/projects/b" } },
      { second: { scope: "global" } },
      { second: { state: "retired" } },
      { second: {}, ids: ["one", "one"] },
      { second: { content: "Never commit generated lockfiles" } },
      { second: {}, merged: "Never commit generated lockfiles" },
    ];
    for (const scenario of cases) {
      const first = createTestBullet({ id: "one", content: "Always commit generated lockfiles", scope: "workspace", workspace: "/projects/a" });
      const second = createTestBullet({ id: "two", content: "Run tests before deployment", scope: "workspace", workspace: "/projects/a", ...scenario.second });
      const result = curatePlaybook(createTestPlaybook([first, second]), [{
        type: "merge", bulletIds: scenario.ids ?? [first.id, second.id],
        mergedContent: scenario.merged ?? "Always commit generated lockfiles and run tests", reason: "Combine checks",
      }], createTestConfig());
      expect(result.applied).toBe(0);
      expect(result.skipped).toBe(1);
      expect(result.playbook.bullets).toHaveLength(2);
      expect(first.deprecated).toBe(false);
      expect(second.deprecated).toBe(false);
    }
  });

  it("retains scope selectors when harmful guidance becomes an anti-pattern", () => {
    const harmful = createTestBullet({
      content: "Use blocking disk writes", scope: "framework", scopeKey: "react",
      harmfulCount: 4,
      feedbackEvents: Array.from({ length: 4 }, () => ({ type: "harmful" as const, timestamp: new Date().toISOString() })),
    });
    const result = curatePlaybook(createTestPlaybook([harmful]), [], createTestConfig());
    const antiPattern = result.playbook.bullets.find((b) => b.kind === "anti_pattern");
    expect(antiPattern).toMatchObject({ scope: "framework", scopeKey: "react" });
  });

  it("does not retire healthy sources into a replacement invalidated by this batch's feedback", () => {
    const sources = [
      createTestBullet({ id: "tests", content: "Run tests before deployment" }),
      createTestBullet({ id: "lint", content: "Run lint before deployment" }),
    ];
    const replacement = createTestBullet({
      id: "replacement", content: "Run tests and lint before deployment", harmfulCount: 2,
      feedbackEvents: [
        { type: "harmful", timestamp: new Date().toISOString(), sessionPath: "/session/one.jsonl" },
        { type: "harmful", timestamp: new Date().toISOString(), sessionPath: "/session/two.jsonl" },
      ],
    });
    const result = curatePlaybook(createTestPlaybook([...sources, replacement]), [
      { type: "merge", bulletIds: sources.map((b) => b.id), mergedContent: replacement.content, reason: "Consolidate" },
      { type: "harmful", bulletId: replacement.id, sourceSession: "/session/three.jsonl" },
    ], createTestConfig());
    expect(result.applied).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.inversions).toHaveLength(1);
    expect(replacement.deprecated).toBe(true);
    for (const source of sources) {
      expect(source.deprecated).toBe(false);
      expect(source.replacedBy).toBeUndefined();
    }
  });

  it("keeps a surviving source active and preserves provenance when it is the replacement", () => {
    const survivor = createTestBullet({ id: "survivor", content: "Run tests and lint before deployment", sourceSessions: ["/sessions/tests"], sourceAgents: ["codex"], tags: ["tests"] });
    const other = createTestBullet({ id: "other", content: "Run lint before deployment", sourceSessions: ["/sessions/lint"], sourceAgents: ["claude"], tags: ["lint"] });
    const result = curatePlaybook(createTestPlaybook([survivor, other]), [{
      type: "merge", bulletIds: [survivor.id, other.id], mergedContent: survivor.content, reason: "Consolidate",
    }], createTestConfig());
    expect(result.playbook.bullets).toHaveLength(2);
    expect(survivor.deprecated).toBe(false);
    expect(other.replacedBy).toBe(survivor.id);
    expect(survivor.sourceSessions).toEqual(["/sessions/tests", "/sessions/lint"]);
    expect(survivor.sourceAgents).toEqual(["codex", "claude"]);
    expect(survivor.tags).toEqual(["tests", "lint"]);
  });

  it("does not reuse an anti-pattern as the replacement for ordinary rules", () => {
    const sources = [createTestBullet({ id: "tests", content: "Run tests before deployment" }), createTestBullet({ id: "lint", content: "Run lint before deployment" })];
    const anti = createTestBullet({ id: "anti", content: "Run tests and lint before deployment", type: "anti-pattern", isNegative: true, kind: "anti_pattern" });
    const result = curatePlaybook(createTestPlaybook([...sources, anti]), [{
      type: "merge", bulletIds: sources.map((b) => b.id), mergedContent: anti.content, reason: "Consolidate",
    }], createTestConfig());
    const survivor = result.playbook.bullets.find((b) => !b.deprecated && b.type === "rule");
    expect(survivor).toBeDefined();
    expect(survivor?.id).not.toBe(anti.id);
    expect(sources.every((b) => b.replacedBy === survivor?.id)).toBe(true);
  });

  it("refreshes duplicate and conflict indexes after changing an existing instruction", () => {
    const original = createTestBullet({ id: "changed", content: "Always commit generated lockfiles" });
    const result = curatePlaybook(createTestPlaybook([original]), [
      { type: "replace", bulletId: original.id, newContent: "Never commit generated lockfiles" },
      { type: "add", bullet: { content: "Always commit generated lockfiles", category: "git" }, reason: "Different guidance", sourceSession: "/sessions/new" },
    ], createTestConfig());
    expect(result.playbook.bullets).toHaveLength(2);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].conflictingContent).toBe("Never commit generated lockfiles");
    expect(original.helpfulCount).toBe(0);
  });
});

describe("buildSemanticDedupIndex", () => {
  it("is skipped when semantic search is disabled or nothing is incoming", async () => {
    const { buildSemanticDedupIndex } = await import("../src/semantic");
    const bullets = [createTestBullet({ content: "Run tests" })];
    expect(
      await buildSemanticDedupIndex(bullets, ["x"], createTestConfig({ semanticSearchEnabled: false })),
    ).toBeUndefined();
    expect(
      await buildSemanticDedupIndex(bullets, [], createTestConfig({ semanticSearchEnabled: true })),
    ).toBeUndefined();
  });
});

describe("curatePlaybook semantic dedup polarity guard", () => {
  it("does not reinforce the opposite rule even when embeddings are near-identical", () => {
    const yes = "Always commit generated lockfiles";
    const no = "Never commit generated lockfiles";
    const existing = createTestBullet({ id: "b-yes", content: yes });
    const playbook = createTestPlaybook([existing]);
    const result = curatePlaybook(
      playbook,
      [
        {
          type: "add",
          bullet: { content: no, category: "git", scope: "global", kind: "workflow_rule" },
          sourceSession: "/s.jsonl",
          reason: "test",
        },
      ],
      createTestConfig(),
      undefined,
      {
        semanticIndex: {
          threshold: 0.9,
          embeddings: new Map([
            [hashContent(yes), [1, 0]],
            [hashContent(no), [0.99, 0.141]],
          ]),
        },
      },
    );
    expect(result.playbook.bullets).toHaveLength(2);
    expect(result.playbook.bullets.find((b) => b.id === "b-yes")?.helpfulCount).toBe(0);
  });
});

describe("curatePlaybook lexical dedup polarity guard", () => {
  it("does not merge 'Never X' into 'X' even with near-total word overlap", () => {
    const existing = createTestBullet({ id: "b-mock", content: "Mock the database in unit tests" });
    const playbook = createTestPlaybook([existing]);
    const result = curatePlaybook(
      playbook,
      [
        {
          type: "add",
          bullet: {
            content: "Never mock the database in unit tests",
            category: "testing",
            scope: "global",
            kind: "workflow_rule",
          },
          sourceSession: "/s.jsonl",
          reason: "test",
        },
      ],
      createTestConfig(),
    );
    expect(result.playbook.bullets).toHaveLength(2);
    expect(result.playbook.bullets.find((b) => b.id === "b-mock")?.helpfulCount).toBe(0);
  });
});

describe("curatePlaybook conflict and dedup scope guards", () => {
  const distinctRules: Array<[string, string, string]> = [
    [
      "negative rules with different qualifiers",
      "Never cache tokens without expiry",
      "Never cache tokens with expiry",
    ],
    [
      "positive rules with different when conditions",
      "Use local caching when the server is online",
      "Use local caching when the server is offline",
    ],
    [
      "positive rules with different if conditions",
      "Run integration tests if the database is available",
      "Run integration tests if the database is unavailable",
    ],
    [
      "a prerequisite and an exception",
      "Cache tokens only if expiry is configured",
      "Cache tokens unless expiry is configured",
    ],
  ];

  for (const mode of ["lexical", "semantic"] as const) {
    for (const [name, existingContent, incomingContent] of distinctRules) {
      it(`preserves ${name} under ${mode} deduplication`, () => {
        const existing = createTestBullet({
          id: "b-existing",
          content: existingContent,
          helpfulCount: 0,
          feedbackEvents: [],
        });
        const playbook = createTestPlaybook([existing]);
        const config = createTestConfig({
          // Exercise lexical matching directly, or force the semantic path
          // past lexical matching with an intentionally identical vector.
          dedupSimilarityThreshold: mode === "lexical" ? 0.5 : 1,
        });
        const result = curatePlaybook(
          playbook,
          [{
            type: "add",
            bullet: {
              content: incomingContent,
              category: "testing",
              scope: "global",
              kind: "workflow_rule",
            },
            sourceSession: "/session/scope-regression.jsonl",
            reason: "Distinct conditions must remain independently reviewable",
          }],
          config,
          undefined,
          mode === "semantic"
            ? {
                semanticIndex: {
                  threshold: 0.9,
                  embeddings: new Map([
                    [hashContent(existingContent), [1, 0]],
                    [hashContent(incomingContent), [1, 0]],
                  ]),
                },
              }
            : undefined,
        );

        expect(result.applied).toBe(1);
        expect(result.skipped).toBe(0);
        expect(result.playbook.bullets.map((b) => b.content)).toEqual([
          existingContent,
          incomingContent,
        ]);
        expect(result.playbook.bullets[0].helpfulCount).toBe(0);
        expect(result.playbook.bullets[0].feedbackEvents).toEqual([]);
        // Distinct conditions justify retaining both rules, but do not by
        // themselves establish opposing instructions in the same situation.
        expect(result.conflicts).toEqual([]);
      });
    }
  }

  it("adds complementary defect-investigation guidance without a conflict warning", () => {
    const existingContent = "Reproduce the defect on the base revision before attributing responsibility";
    const incomingContent = "Never attribute responsibility for the defect without reproducing it on the base revision";
    const playbook = createTestPlaybook([
      createTestBullet({ id: "b-investigate", content: existingContent }),
    ]);
    const result = curatePlaybook(
      playbook,
      [{
        type: "add",
        bullet: {
          content: incomingContent,
          category: "debugging",
          scope: "global",
          kind: "workflow_rule",
        },
        sourceSession: "/session/compatible-investigation.jsonl",
        reason: "Complementary requirement",
      }],
      createTestConfig(),
    );

    expect(result.applied).toBe(1);
    expect(result.conflicts).toEqual([]);
    expect(result.decisionLog?.filter((entry) => entry.phase === "conflict")).toEqual([]);
    expect(result.playbook.bullets.map((b) => b.content)).toEqual([existingContent, incomingContent]);
  });

  it("still reports direct opposition introduced within one curation batch", () => {
    const contents = ["Always commit generated lockfiles", "Never commit generated lockfiles"];
    const deltas: PlaybookDelta[] = contents.map((content, index) => ({
      type: "add",
      bullet: { content, category: "git", scope: "global", kind: "workflow_rule" },
      sourceSession: `/session/batch-${index}.jsonl`,
      reason: "Distinct incoming guidance",
    }));
    const result = curatePlaybook(createTestPlaybook(), deltas, createTestConfig());

    expect(result.applied).toBe(2);
    expect(result.playbook.bullets.map((b) => b.content)).toEqual(contents);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].newBulletContent).toBe(contents[1]);
    expect(result.conflicts[0].conflictingContent).toBe(contents[0]);
    expect(result.conflicts[0].conflictingBulletId).toBe(result.playbook.bullets[0].id);
    expect(result.playbook.bullets[0].helpfulCount).toBe(0);
  });
});
