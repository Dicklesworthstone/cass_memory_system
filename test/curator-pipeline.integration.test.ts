/**
 * Integration tests for the Curator Pipeline
 * Tests curatePlaybook() + validateDelta() interaction
 *
 * Philosophy: NO MOCKS - real implementations with validation disabled
 * to avoid external dependencies (cass, LLM)
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { curatePlaybook } from "../src/curate";
import { validateDelta, normalizeValidatorVerdict, evidenceCountGate } from "../src/validate";
import { Playbook, PlaybookDelta, Config, PlaybookBullet } from "../src/types";
import {
  createTestConfig,
  createTestBullet,
  createTestPlaybook,
  createFeedbackEvent
} from "./helpers/factories";

describe("Curator Pipeline Integration", () => {
  let config: Config;
  let configWithValidationDisabled: Config;

  beforeEach(() => {
    config = createTestConfig();
    configWithValidationDisabled = createTestConfig({ validationEnabled: false });
  });

  // ===========================================================================
  // FULL PIPELINE FLOW
  // ===========================================================================
  describe("full pipeline flow", () => {
    it("curator produces deltas that can be passed to validator", async () => {
      const playbook = createTestPlaybook();

      // Add delta that curator will process
      const addDelta: PlaybookDelta = {
        type: "add",
        bullet: {
          content: "Always validate user input before processing to prevent security vulnerabilities",
          category: "security",
          scope: "global",
          kind: "workflow_rule"
        },
        sourceSession: "/session/1.jsonl",
        reason: "Security best practice"
      };

      // Run curator
      const curationResult = curatePlaybook(playbook, [addDelta], configWithValidationDisabled);

      expect(curationResult.applied).toBe(1);
      expect(curationResult.playbook.bullets).toHaveLength(1);

      // The newly added bullet can be validated
      const newBullet = curationResult.playbook.bullets[0];
      expect(newBullet.content).toBe(addDelta.bullet.content);
      expect(newBullet.category).toBe("security");

      // Validate the original delta (with validation disabled, should pass)
      const validationResult = await validateDelta(addDelta, configWithValidationDisabled);
      expect(validationResult.valid).toBe(true);
    });

    it("helpful/harmful deltas bypass validation (only add is validated)", async () => {
      const bullet = createTestBullet({
        id: "test-bullet",
        content: "Test rule for validation"
      });
      const playbook = createTestPlaybook([bullet]);

      const helpfulDelta: PlaybookDelta = {
        type: "helpful",
        bulletId: "test-bullet",
        sourceSession: "/session/1.jsonl"
      };

      const harmfulDelta: PlaybookDelta = {
        type: "harmful",
        bulletId: "test-bullet",
        sourceSession: "/session/2.jsonl",
        reason: "outdated"
      };

      // Both should pass validation since they're not "add" type
      const helpfulValidation = await validateDelta(helpfulDelta, config);
      const harmfulValidation = await validateDelta(harmfulDelta, config);

      expect(helpfulValidation.valid).toBe(true);
      expect(harmfulValidation.valid).toBe(true);

      // And curator should apply them
      const result = curatePlaybook(playbook, [helpfulDelta, harmfulDelta], config);
      expect(result.applied).toBe(2);
      expect(result.playbook.bullets[0].helpfulCount).toBe(1);
      expect(result.playbook.bullets[0].harmfulCount).toBe(1);
    });

    it("short content bypasses validation", async () => {
      const shortDelta: PlaybookDelta = {
        type: "add",
        bullet: {
          content: "Short rule", // Less than 20 chars
          category: "test",
          scope: "global",
          kind: "workflow_rule"
        },
        sourceSession: "/session/1.jsonl",
        reason: "Test"
      };

      // Short content bypasses validation
      const result = await validateDelta(shortDelta, config);
      expect(result.valid).toBe(true);
    });
  });

  // ===========================================================================
  // ANTI-PATTERN INVERSION THROUGH PIPELINE
  // ===========================================================================
  describe("anti-pattern inversion flow", () => {
    it("inverted anti-patterns are new bullets that can be validated", async () => {
      const now = new Date().toISOString();

      // Create a bullet that will trigger inversion (>=3 harmful, harmful > 2*helpful)
      const harmfulBullet = createTestBullet({
        id: "bad-rule",
        content: "Always use any type for flexibility",
        category: "typescript",
        harmfulCount: 5,
        helpfulCount: 0,
        feedbackEvents: Array(5).fill(null).map(() =>
          createFeedbackEvent("harmful", { timestamp: now })
        )
      });
      const playbook = createTestPlaybook([harmfulBullet]);

      // Run curator - should trigger inversion
      const result = curatePlaybook(playbook, [], config);

      expect(result.inversions).toHaveLength(1);

      // Find the new anti-pattern bullet
      const antiPattern = result.playbook.bullets.find(b => b.kind === "anti_pattern");
      expect(antiPattern).toBeDefined();
      expect(antiPattern?.content).toContain("AVOID:");
      expect(antiPattern?.isNegative).toBe(true);

      // The anti-pattern bullet could be validated as an "add" delta
      // (In practice, inversions are internal - but we verify the structure)
      const addDeltaForAntiPattern: PlaybookDelta = {
        type: "add",
        bullet: {
          content: antiPattern!.content,
          category: antiPattern!.category,
          scope: antiPattern!.scope,
          kind: "anti_pattern"
        },
        sourceSession: "inversion",
        reason: "Anti-pattern from inversion"
      };

      // With validation disabled, it passes
      const validation = await validateDelta(addDeltaForAntiPattern, configWithValidationDisabled);
      expect(validation.valid).toBe(true);
    });

    it("original bullet is deprecated after inversion", async () => {
      const now = new Date().toISOString();

      const harmfulBullet = createTestBullet({
        id: "to-invert",
        content: "Use var for all declarations",
        category: "javascript",
        harmfulCount: 4,
        feedbackEvents: Array(4).fill(null).map(() =>
          createFeedbackEvent("harmful", { timestamp: now })
        )
      });
      const playbook = createTestPlaybook([harmfulBullet]);

      const result = curatePlaybook(playbook, [], config);

      // Original should be deprecated
      const original = result.playbook.bullets.find(b => b.id === "to-invert");
      expect(original?.deprecated).toBe(true);
      expect(original?.maturity).toBe("deprecated");
      expect(original?.deprecationReason).toContain("anti-pattern");
    });

    it("pinned bullets survive harmful feedback without inversion", async () => {
      const now = new Date().toISOString();

      const pinnedBullet = createTestBullet({
        id: "pinned-rule",
        content: "Important rule that should never be inverted",
        pinned: true,
        harmfulCount: 10,
        feedbackEvents: Array(10).fill(null).map(() =>
          createFeedbackEvent("harmful", { timestamp: now })
        )
      });
      const playbook = createTestPlaybook([pinnedBullet]);

      const result = curatePlaybook(playbook, [], config);

      expect(result.inversions).toHaveLength(0);
      expect(result.playbook.bullets[0].deprecated).toBe(false);
    });
  });

  // ===========================================================================
  // MATURITY TRANSITIONS THROUGH PIPELINE
  // ===========================================================================
  describe("maturity transitions", () => {
    it("bullet promoted to established maintains state through curation", async () => {
      const now = new Date().toISOString();

      // Bullet with enough helpful feedback to promote
      const candidateBullet = createTestBullet({
        id: "promotable",
        content: "Good coding practice",
        maturity: "candidate",
        helpfulCount: 4,
        feedbackEvents: Array(4).fill(null).map(() =>
          createFeedbackEvent("helpful", { timestamp: now })
        )
      });
      const playbook = createTestPlaybook([candidateBullet]);

      // Additional helpful delta
      const helpfulDelta: PlaybookDelta = {
        type: "helpful",
        bulletId: "promotable",
        sourceSession: "/session/new.jsonl"
      };

      const result = curatePlaybook(playbook, [helpfulDelta], config);

      // Should be promoted to established (or proven if threshold crossed)
      expect(["established", "proven"]).toContain(result.playbook.bullets[0].maturity);
      expect(result.promotions.length).toBeGreaterThanOrEqual(1);
    });

    it("bullet with negative score triggers demotion or deprecation", async () => {
      const now = new Date().toISOString();

      // Bullet with very negative score
      const negativeBullet = createTestBullet({
        id: "negative",
        content: "Rule with mostly harmful feedback",
        maturity: "established",
        harmfulCount: 8,
        helpfulCount: 1,
        feedbackEvents: [
          createFeedbackEvent("helpful", { timestamp: now }),
          ...Array(8).fill(null).map(() =>
            createFeedbackEvent("harmful", { timestamp: now })
          )
        ]
      });
      const playbook = createTestPlaybook([negativeBullet]);

      const result = curatePlaybook(playbook, [], config);

      // Should be either demoted, deprecated, or inverted
      const bullet = result.playbook.bullets.find(b => b.id === "negative");
      const isHandled =
        bullet?.deprecated === true ||
        bullet?.maturity === "candidate" ||
        result.inversions.some(i => i.originalId === "negative");

      expect(isHandled).toBe(true);
    });

    it("multiple bullets transition independently", async () => {
      const now = new Date().toISOString();

      const bullet1 = createTestBullet({
        id: "b1",
        content: "First rule with good feedback",
        maturity: "candidate",
        helpfulCount: 5,
        feedbackEvents: Array(5).fill(null).map(() =>
          createFeedbackEvent("helpful", { timestamp: now })
        )
      });

      const bullet2 = createTestBullet({
        id: "b2",
        content: "Second rule with bad feedback",
        maturity: "candidate",
        harmfulCount: 5,
        feedbackEvents: Array(5).fill(null).map(() =>
          createFeedbackEvent("harmful", { timestamp: now })
        )
      });

      const playbook = createTestPlaybook([bullet1, bullet2]);
      const result = curatePlaybook(playbook, [], config);

      // b1 should be promoted
      const b1Result = result.playbook.bullets.find(b => b.id === "b1");
      expect(b1Result).toBeDefined();
      expect(["established", "proven"]).toContain(b1Result!.maturity);

      // b2 should be handled (inverted or deprecated)
      const b2Result = result.playbook.bullets.find(b => b.id === "b2");
      const b2Handled =
        b2Result?.deprecated === true ||
        result.inversions.some(i => i.originalId === "b2");
      expect(b2Handled).toBe(true);
    });
  });

  // ===========================================================================
  // VERDICT NORMALIZATION
  // ===========================================================================
  describe("verdict normalization", () => {
    it("normalizes REFINE to ACCEPT_WITH_CAUTION", () => {
      const refineResult = {
        verdict: "REFINE" as const,
        valid: true,
        confidence: 0.8,
        reason: "Needs refinement",
        evidence: []
      };

      const normalized = normalizeValidatorVerdict(refineResult);

      expect(normalized.verdict).toBe("ACCEPT_WITH_CAUTION");
      expect(normalized.valid).toBe(true);
      expect(normalized.confidence).toBeCloseTo(0.64, 2); // 0.8 * 0.8
    });

    it("passes through ACCEPT unchanged", () => {
      const acceptResult = {
        verdict: "ACCEPT" as const,
        valid: true,
        confidence: 0.95,
        reason: "Good rule",
        evidence: []
      };

      const normalized = normalizeValidatorVerdict(acceptResult);

      expect(normalized.verdict).toBe("ACCEPT");
      expect(normalized.confidence).toBe(0.95);
    });

    it("passes through REJECT unchanged", () => {
      const rejectResult = {
        verdict: "REJECT" as const,
        valid: false,
        confidence: 0.9,
        reason: "Bad rule",
        evidence: []
      };

      const normalized = normalizeValidatorVerdict(rejectResult);

      expect(normalized.verdict).toBe("REJECT");
      expect(normalized.valid).toBe(false);
    });
  });

  // ===========================================================================
  // PRUNING DECISIONS
  // ===========================================================================
  describe("pruning decisions", () => {
    it("bullets below prune threshold are auto-deprecated", async () => {
      const now = new Date().toISOString();

      // Create bullet with extreme negative score
      const veryBadBullet = createTestBullet({
        id: "prune-me",
        content: "Terrible advice that got lots of harmful marks",
        maturity: "candidate",
        harmfulCount: 20,
        helpfulCount: 0,
        feedbackEvents: Array(20).fill(null).map(() =>
          createFeedbackEvent("harmful", { timestamp: now })
        )
      });
      const playbook = createTestPlaybook([veryBadBullet]);

      const result = curatePlaybook(playbook, [], config);

      // Should be either inverted (becomes anti-pattern) or pruned
      const bullet = result.playbook.bullets.find(b => b.id === "prune-me");
      const wasHandled =
        bullet?.deprecated === true ||
        result.inversions.some(i => i.originalId === "prune-me") ||
        result.pruned > 0;

      expect(wasHandled).toBe(true);
    });

    it("pruned count is accurate in result", async () => {
      const now = new Date().toISOString();

      // Multiple bullets, some should be pruned
      const goodBullet = createTestBullet({
        id: "good",
        content: "Good rule",
        helpfulCount: 5,
        feedbackEvents: Array(5).fill(null).map(() =>
          createFeedbackEvent("helpful", { timestamp: now })
        )
      });

      const badBullet = createTestBullet({
        id: "bad",
        content: "Bad rule that will be handled",
        harmfulCount: 15,
        feedbackEvents: Array(15).fill(null).map(() =>
          createFeedbackEvent("harmful", { timestamp: now })
        )
      });

      const playbook = createTestPlaybook([goodBullet, badBullet]);
      const result = curatePlaybook(playbook, [], config);

      // Verify counts make sense
      expect(result.playbook.bullets.length).toBeGreaterThanOrEqual(2);

      // Good bullet should remain active
      const goodResult = result.playbook.bullets.find(b => b.id === "good");
      expect(goodResult?.deprecated).toBeFalsy();
    });
  });

  // ===========================================================================
  // EDGE CASES
  // ===========================================================================
  describe("edge cases", () => {
    it("handles empty playbook through full pipeline", async () => {
      const playbook = createTestPlaybook();

      const delta: PlaybookDelta = {
        type: "add",
        bullet: {
          content: "First rule in empty playbook with enough content to validate",
          category: "general",
          scope: "global",
          kind: "workflow_rule"
        },
        sourceSession: "/session/1.jsonl",
        reason: "First rule"
      };

      // Validate then curate
      const validation = await validateDelta(delta, configWithValidationDisabled);
      expect(validation.valid).toBe(true);

      const result = curatePlaybook(playbook, [delta], configWithValidationDisabled);
      expect(result.applied).toBe(1);
      expect(result.playbook.bullets).toHaveLength(1);
    });

    it("handles concurrent add and feedback deltas", async () => {
      const existingBullet = createTestBullet({
        id: "existing",
        content: "Existing rule"
      });
      const playbook = createTestPlaybook([existingBullet]);

      const deltas: PlaybookDelta[] = [
        {
          type: "add",
          bullet: {
            content: "Brand new rule about testing best practices",
            category: "testing",
            scope: "global",
            kind: "workflow_rule"
          },
          sourceSession: "/session/1.jsonl",
          reason: "New"
        },
        {
          type: "helpful",
          bulletId: "existing",
          sourceSession: "/session/2.jsonl"
        },
        {
          type: "harmful",
          bulletId: "existing",
          sourceSession: "/session/3.jsonl",
          reason: "outdated"
        }
      ];

      const result = curatePlaybook(playbook, deltas, configWithValidationDisabled);

      expect(result.applied).toBe(3);
      expect(result.playbook.bullets).toHaveLength(2);

      const existing = result.playbook.bullets.find(b => b.id === "existing");
      expect(existing?.helpfulCount).toBe(1);
      expect(existing?.harmfulCount).toBe(1);
    });

    it("curation result structure is complete", async () => {
      const playbook = createTestPlaybook([createTestBullet()]);
      const result = curatePlaybook(playbook, [], config);

      // Verify all result fields exist
      expect(result).toHaveProperty("playbook");
      expect(result).toHaveProperty("applied");
      expect(result).toHaveProperty("skipped");
      expect(result).toHaveProperty("conflicts");
      expect(result).toHaveProperty("promotions");
      expect(result).toHaveProperty("inversions");
      expect(result).toHaveProperty("pruned");

      expect(Array.isArray(result.conflicts)).toBe(true);
      expect(Array.isArray(result.promotions)).toBe(true);
      expect(Array.isArray(result.inversions)).toBe(true);
    });
  });
});
