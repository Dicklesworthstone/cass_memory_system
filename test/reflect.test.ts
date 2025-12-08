import { describe, expect, it } from "bun:test";
import { formatBulletsForPrompt, formatDiaryForPrompt, deduplicateDeltas, hashDelta } from "../src/reflect.js";
import { PlaybookBullet, PlaybookDelta } from "../src/types.js";
import { createTestBullet } from "./helpers/index.js";

// =============================================================================
// formatBulletsForPrompt
// =============================================================================
describe("formatBulletsForPrompt", () => {
  it("returns placeholder for empty array", () => {
    const result = formatBulletsForPrompt([]);
    expect(result).toBe("(Playbook is empty)");
  });

  it("formats single bullet", () => {
    const bullets: PlaybookBullet[] = [
      createTestBullet({
        id: "b1",
        content: "Test rule",
        category: "testing",
        maturity: "candidate",
        helpfulCount: 5,
        harmfulCount: 1,
      }),
    ];
    const result = formatBulletsForPrompt(bullets);
    expect(result).toContain("### testing");
    expect(result).toContain("[b1]");
    expect(result).toContain("Test rule");
    expect(result).toContain("5 helpful, 1 harmful");
  });

  it("groups bullets by category", () => {
    const bullets: PlaybookBullet[] = [
      createTestBullet({ id: "b1", content: "Rule 1", category: "coding" }),
      createTestBullet({ id: "b2", content: "Rule 2", category: "testing" }),
      createTestBullet({ id: "b3", content: "Rule 3", category: "coding" }),
    ];
    const result = formatBulletsForPrompt(bullets);
    expect(result).toContain("### coding");
    expect(result).toContain("### testing");
    // Both coding rules should be near each other
    const codingIdx = result.indexOf("### coding");
    const testingIdx = result.indexOf("### testing");
    expect(codingIdx).not.toBe(-1);
    expect(testingIdx).not.toBe(-1);
  });

  it("uses star for proven maturity", () => {
    const bullets: PlaybookBullet[] = [
      createTestBullet({ id: "b1", content: "Proven rule", maturity: "proven" }),
    ];
    const result = formatBulletsForPrompt(bullets);
    expect(result).toContain("★");
  });

  it("uses filled circle for established maturity", () => {
    const bullets: PlaybookBullet[] = [
      createTestBullet({ id: "b1", content: "Established rule", maturity: "established" }),
    ];
    const result = formatBulletsForPrompt(bullets);
    expect(result).toContain("●");
  });

  it("uses empty circle for candidate maturity", () => {
    const bullets: PlaybookBullet[] = [
      createTestBullet({ id: "b1", content: "Candidate rule", maturity: "candidate" }),
    ];
    const result = formatBulletsForPrompt(bullets);
    expect(result).toContain("○");
  });

  it("handles undefined category as uncategorized", () => {
    const bullet = createTestBullet({ id: "b1", content: "No category" });
    (bullet as any).category = undefined;
    const result = formatBulletsForPrompt([bullet]);
    expect(result).toContain("## uncategorized");
  });

  it("includes feedback counts in output", () => {
    const bullets: PlaybookBullet[] = [
      createTestBullet({
        id: "b1",
        content: "Rule with feedback",
        helpfulCount: 10,
        harmfulCount: 2,
      }),
    ];
    const result = formatBulletsForPrompt(bullets);
    expect(result).toContain("10 helpful");
    expect(result).toContain("2 harmful");
  });
});

// =============================================================================
// hashDelta
// =============================================================================
describe("hashDelta", () => {
  it("hashes add delta by content", () => {
    const delta: PlaybookDelta = {
      type: "add",
      bullet: { content: "New Rule", category: "test", scope: "global", kind: "workflow_rule" },
      reason: "test",
      sourceSession: "s1",
    };
    const hash = hashDelta(delta);
    expect(hash).toBe("add:new rule");
  });

  it("hashes add delta case-insensitively", () => {
    const delta1: PlaybookDelta = {
      type: "add",
      bullet: { content: "New Rule", category: "test", scope: "global", kind: "workflow_rule" },
      reason: "test",
      sourceSession: "s1",
    };
    const delta2: PlaybookDelta = {
      type: "add",
      bullet: { content: "NEW RULE", category: "test", scope: "global", kind: "workflow_rule" },
      reason: "test",
      sourceSession: "s2",
    };
    expect(hashDelta(delta1)).toBe(hashDelta(delta2));
  });

  it("hashes replace delta by id and content", () => {
    const delta: PlaybookDelta = {
      type: "replace",
      bulletId: "b123",
      newContent: "Updated content",
      reason: "test",
    };
    const hash = hashDelta(delta);
    expect(hash).toBe("replace:b123:Updated content");
  });

  it("hashes merge delta by bullet ids", () => {
    const delta: PlaybookDelta = {
      type: "merge",
      bulletIds: ["b1", "b2", "b3"],
      mergedContent: "Merged",
      reason: "test",
    };
    const hash = hashDelta(delta);
    expect(hash).toBe("merge:b1,b2,b3");
  });

  it("hashes deprecate delta by id", () => {
    const delta: PlaybookDelta = {
      type: "deprecate",
      bulletId: "b456",
      reason: "outdated",
    };
    const hash = hashDelta(delta);
    expect(hash).toBe("deprecate:b456");
  });

  it("hashes helpful delta by type and id", () => {
    const delta: PlaybookDelta = {
      type: "helpful",
      bulletId: "b789",
      context: "worked well",
      sourceSession: "s1",
    };
    const hash = hashDelta(delta);
    expect(hash).toBe("helpful:b789");
  });

  it("hashes harmful delta by type and id", () => {
    const delta: PlaybookDelta = {
      type: "harmful",
      bulletId: "b000",
      reason: "caused_bug",
      sourceSession: "s1",
    };
    const hash = hashDelta(delta);
    expect(hash).toBe("harmful:b000");
  });
});

// =============================================================================
// deduplicateDeltas
// =============================================================================
describe("deduplicateDeltas", () => {
  it("returns all deltas when none exist", () => {
    const newDeltas: PlaybookDelta[] = [
      {
        type: "add",
        bullet: { content: "Rule 1", category: "test", scope: "global", kind: "workflow_rule" },
        reason: "test",
        sourceSession: "s1",
      },
      {
        type: "add",
        bullet: { content: "Rule 2", category: "test", scope: "global", kind: "workflow_rule" },
        reason: "test",
        sourceSession: "s2",
      },
    ];
    const result = deduplicateDeltas(newDeltas, []);
    expect(result).toHaveLength(2);
  });

  it("removes duplicates from existing deltas", () => {
    const existing: PlaybookDelta[] = [
      {
        type: "add",
        bullet: { content: "Existing Rule", category: "test", scope: "global", kind: "workflow_rule" },
        reason: "test",
        sourceSession: "s1",
      },
    ];
    const newDeltas: PlaybookDelta[] = [
      {
        type: "add",
        bullet: { content: "Existing Rule", category: "test", scope: "global", kind: "workflow_rule" },
        reason: "test",
        sourceSession: "s2",
      },
      {
        type: "add",
        bullet: { content: "New Rule", category: "test", scope: "global", kind: "workflow_rule" },
        reason: "test",
        sourceSession: "s3",
      },
    ];
    const result = deduplicateDeltas(newDeltas, existing);
    expect(result).toHaveLength(1);
    expect(result[0].type === "add" && result[0].bullet.content).toBe("New Rule");
  });

  it("removes duplicates within new deltas", () => {
    const newDeltas: PlaybookDelta[] = [
      {
        type: "add",
        bullet: { content: "Duplicate", category: "test", scope: "global", kind: "workflow_rule" },
        reason: "first",
        sourceSession: "s1",
      },
      {
        type: "add",
        bullet: { content: "Duplicate", category: "test", scope: "global", kind: "workflow_rule" },
        reason: "second",
        sourceSession: "s2",
      },
    ];
    const result = deduplicateDeltas(newDeltas, []);
    expect(result).toHaveLength(1);
  });

  it("handles case-insensitive add duplicates", () => {
    const existing: PlaybookDelta[] = [
      {
        type: "add",
        bullet: { content: "MY RULE", category: "test", scope: "global", kind: "workflow_rule" },
        reason: "test",
        sourceSession: "s0",
      },
    ];
    const newDeltas: PlaybookDelta[] = [
      {
        type: "add",
        bullet: { content: "my rule", category: "test", scope: "global", kind: "workflow_rule" },
        reason: "test",
        sourceSession: "s1",
      },
    ];
    const result = deduplicateDeltas(newDeltas, existing);
    expect(result).toHaveLength(0);
  });

  it("does not deduplicate different delta types for same bullet", () => {
    const existing: PlaybookDelta[] = [
      { type: "helpful", bulletId: "b1", context: "test", sourceSession: "s1" },
    ];
    const newDeltas: PlaybookDelta[] = [
      { type: "harmful", bulletId: "b1", reason: "caused_bug", sourceSession: "s2" },
    ];
    const result = deduplicateDeltas(newDeltas, existing);
    expect(result).toHaveLength(1);
  });

  it("handles empty new deltas", () => {
    const existing: PlaybookDelta[] = [
      { type: "helpful", bulletId: "b1", context: "test", sourceSession: "s1" },
    ];
    const result = deduplicateDeltas([], existing);
    expect(result).toHaveLength(0);
  });
});

// =============================================================================
// Edge cases
// =============================================================================
describe("reflect helpers edge cases", () => {
  it("hashDelta handles missing content gracefully", () => {
    const delta: PlaybookDelta = {
      type: "add",
      bullet: { category: "test", scope: "global", kind: "workflow_rule" } as any,
      reason: "test",
      sourceSession: "s1",
    };
    const hash = hashDelta(delta);
    expect(hash).toBe("add:undefined");
  });
});
