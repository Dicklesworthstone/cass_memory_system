import { describe, expect, it } from "bun:test";
import {
  formatBulletsForPrompt,
  formatDiaryForPrompt,
  formatCassHistory,
  deduplicateDeltas,
  hashDelta,
  shouldExitEarly,
} from "../src/reflect.js";
import { PlaybookBullet, DiaryEntry, PlaybookDelta, CassHit } from "../src/types.js";
import { createTestBullet, createTestConfig, createTestDiary } from "./helpers/index.js";

// =============================================================================
// formatBulletsForPrompt
// =============================================================================
describe("formatBulletsForPrompt", () => {
  it("returns placeholder for empty array", () => {
    const result = formatBulletsForPrompt([]);
    expect(result).toBe("(No existing rules in playbook)");
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
    expect(result).toContain("## testing");
    expect(result).toContain("[b1]");
    expect(result).toContain("Test rule");
    expect(result).toContain("(5+ / 1-)");
  });

  it("groups bullets by category", () => {
    const bullets: PlaybookBullet[] = [
      createTestBullet({ id: "b1", content: "Rule 1", category: "coding" }),
      createTestBullet({ id: "b2", content: "Rule 2", category: "testing" }),
      createTestBullet({ id: "b3", content: "Rule 3", category: "coding" }),
    ];
    const result = formatBulletsForPrompt(bullets);
    expect(result).toContain("## coding");
    expect(result).toContain("## testing");
    // Both coding rules should be near each other
    const codingIdx = result.indexOf("## coding");
    const testingIdx = result.indexOf("## testing");
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
    expect(result).toContain("(10+ / 2-)");
  });
});

// =============================================================================
// formatDiaryForPrompt
// =============================================================================
describe("formatDiaryForPrompt", () => {
  it("includes basic session info", () => {
    const diary = createTestDiary({
      sessionPath: "/sessions/test.jsonl",
      agent: "claude",
      workspace: "my-project",
      status: "success",
      timestamp: "2025-01-15T10:00:00Z",
    });
    const result = formatDiaryForPrompt(diary);
    expect(result).toContain("## Session Overview");
    expect(result).toContain("/sessions/test.jsonl");
    expect(result).toContain("claude");
    expect(result).toContain("my-project");
    expect(result).toContain("success");
  });

  it("includes accomplishments section when present", () => {
    const diary = createTestDiary({
      accomplishments: ["Fixed bug in auth", "Added new tests"],
    });
    const result = formatDiaryForPrompt(diary);
    expect(result).toContain("## Accomplishments");
    expect(result).toContain("Fixed bug in auth");
    expect(result).toContain("Added new tests");
  });

  it("includes decisions section when present", () => {
    const diary = createTestDiary({
      decisions: ["Used JWT over sessions", "Chose PostgreSQL"],
    });
    const result = formatDiaryForPrompt(diary);
    expect(result).toContain("## Decisions Made");
    expect(result).toContain("Used JWT over sessions");
    expect(result).toContain("Chose PostgreSQL");
  });

  it("includes challenges section when present", () => {
    const diary = createTestDiary({
      challenges: ["Rate limiting issues", "Memory leaks"],
    });
    const result = formatDiaryForPrompt(diary);
    expect(result).toContain("## Challenges Encountered");
    expect(result).toContain("Rate limiting issues");
    expect(result).toContain("Memory leaks");
  });

  it("includes key learnings section when present", () => {
    const diary = createTestDiary({
      keyLearnings: ["Always validate input", "Cache frequently used data"],
    });
    const result = formatDiaryForPrompt(diary);
    expect(result).toContain("## Key Learnings");
    expect(result).toContain("Always validate input");
    expect(result).toContain("Cache frequently used data");
  });

  it("includes preferences section when present", () => {
    const diary = createTestDiary({
      preferences: ["Use TypeScript", "Prefer functional style"],
    });
    const result = formatDiaryForPrompt(diary);
    expect(result).toContain("## User Preferences");
    expect(result).toContain("Use TypeScript");
    expect(result).toContain("Prefer functional style");
  });

  it("omits empty sections", () => {
    const diary = createTestDiary({
      accomplishments: [],
      decisions: [],
      challenges: [],
      keyLearnings: [],
      preferences: [],
    });
    const result = formatDiaryForPrompt(diary);
    expect(result).not.toContain("## Accomplishments");
    expect(result).not.toContain("## Decisions Made");
    expect(result).not.toContain("## Challenges Encountered");
    expect(result).not.toContain("## Key Learnings");
    expect(result).not.toContain("## User Preferences");
    expect(result).toContain("## Session Overview");
  });

  it("handles unknown workspace", () => {
    const diary = createTestDiary();
    (diary as any).workspace = undefined;
    const result = formatDiaryForPrompt(diary);
    expect(result).toContain("Workspace: unknown");
  });
});

// =============================================================================
// formatCassHistory
// =============================================================================
describe("formatCassHistory", () => {
  it("returns none found for empty array", () => {
    const result = formatCassHistory([]);
    expect(result).toContain("RELATED HISTORY FROM OTHER AGENTS:");
    expect(result).toContain("(None found)");
  });

  it("returns none found for null/undefined", () => {
    const result = formatCassHistory(null as any);
    expect(result).toContain("(None found)");
  });

  it("formats single hit", () => {
    const hits: CassHit[] = [
      {
        snippet: "Test snippet content",
        agent: "claude",
        source_path: "/path/to/session.jsonl",
      },
    ];
    const result = formatCassHistory(hits);
    expect(result).toContain("RELATED HISTORY FROM OTHER AGENTS:");
    expect(result).toContain("Test snippet content");
    expect(result).toContain("Agent: claude");
    expect(result).toContain("Session:");
  });

  it("limits to 5 hits maximum", () => {
    const hits: CassHit[] = Array.from({ length: 10 }, (_, i) => ({
      snippet: `Snippet ${i}`,
      agent: "claude",
      source_path: `/path/session${i}.jsonl`,
    }));
    const result = formatCassHistory(hits);
    // Should only contain up to 5 snippets
    const snippetCount = (result.match(/Snippet \d/g) || []).length;
    expect(snippetCount).toBe(5);
  });

  it("truncates long snippets", () => {
    const longSnippet = "x".repeat(500);
    const hits: CassHit[] = [
      {
        snippet: longSnippet,
        agent: "claude",
        source_path: "/path/session.jsonl",
      },
    ];
    const result = formatCassHistory(hits);
    // Truncate function limits to 200 chars
    expect(result.length).toBeLessThan(longSnippet.length);
  });

  it("handles missing agent gracefully", () => {
    const hits: CassHit[] = [
      {
        snippet: "Test snippet",
        source_path: "/path/session.jsonl",
      } as any,
    ];
    const result = formatCassHistory(hits);
    expect(result).toContain("Agent: unknown");
  });

  it("adds separator between multiple hits", () => {
    const hits: CassHit[] = [
      { snippet: "First", agent: "a1", source_path: "/p1" },
      { snippet: "Second", agent: "a2", source_path: "/p2" },
    ];
    const result = formatCassHistory(hits);
    expect(result).toContain("---");
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
    };
    const hash = hashDelta(delta);
    expect(hash).toBe("add:new rule");
  });

  it("hashes add delta case-insensitively", () => {
    const delta1: PlaybookDelta = {
      type: "add",
      bullet: { content: "New Rule", category: "test", scope: "global", kind: "workflow_rule" },
      reason: "test",
    };
    const delta2: PlaybookDelta = {
      type: "add",
      bullet: { content: "NEW RULE", category: "test", scope: "global", kind: "workflow_rule" },
      reason: "test",
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
      reason: "worked well",
    };
    const hash = hashDelta(delta);
    expect(hash).toBe("helpful:b789");
  });

  it("hashes harmful delta by type and id", () => {
    const delta: PlaybookDelta = {
      type: "harmful",
      bulletId: "b000",
      reason: "caused issues",
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
      },
      {
        type: "add",
        bullet: { content: "Rule 2", category: "test", scope: "global", kind: "workflow_rule" },
        reason: "test",
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
      },
    ];
    const newDeltas: PlaybookDelta[] = [
      {
        type: "add",
        bullet: { content: "Existing Rule", category: "test", scope: "global", kind: "workflow_rule" },
        reason: "test",
      },
      {
        type: "add",
        bullet: { content: "New Rule", category: "test", scope: "global", kind: "workflow_rule" },
        reason: "test",
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
      },
      {
        type: "add",
        bullet: { content: "Duplicate", category: "test", scope: "global", kind: "workflow_rule" },
        reason: "second",
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
      },
    ];
    const newDeltas: PlaybookDelta[] = [
      {
        type: "add",
        bullet: { content: "my rule", category: "test", scope: "global", kind: "workflow_rule" },
        reason: "test",
      },
    ];
    const result = deduplicateDeltas(newDeltas, existing);
    expect(result).toHaveLength(0);
  });

  it("does not deduplicate different delta types for same bullet", () => {
    const existing: PlaybookDelta[] = [
      { type: "helpful", bulletId: "b1", reason: "test" },
    ];
    const newDeltas: PlaybookDelta[] = [
      { type: "harmful", bulletId: "b1", reason: "test" },
    ];
    const result = deduplicateDeltas(newDeltas, existing);
    expect(result).toHaveLength(1);
  });

  it("handles empty new deltas", () => {
    const existing: PlaybookDelta[] = [
      { type: "helpful", bulletId: "b1", reason: "test" },
    ];
    const result = deduplicateDeltas([], existing);
    expect(result).toHaveLength(0);
  });
});

// =============================================================================
// shouldExitEarly
// =============================================================================
describe("shouldExitEarly", () => {
  const config = createTestConfig({ maxReflectorIterations: 3 });

  it("exits when no deltas in current iteration", () => {
    const result = shouldExitEarly(0, 0, 0, config);
    expect(result).toBe(true);
  });

  it("exits when total deltas exceed MAX_DELTAS (20)", () => {
    const result = shouldExitEarly(0, 5, 20, config);
    expect(result).toBe(true);
  });

  it("exits on last iteration", () => {
    const result = shouldExitEarly(2, 5, 10, config);
    expect(result).toBe(true);
  });

  it("does not exit on first iteration with deltas", () => {
    const result = shouldExitEarly(0, 5, 5, config);
    expect(result).toBe(false);
  });

  it("does not exit on middle iteration with deltas", () => {
    const result = shouldExitEarly(1, 3, 8, config);
    expect(result).toBe(false);
  });

  it("respects custom maxReflectorIterations", () => {
    const customConfig = createTestConfig({ maxReflectorIterations: 5 });
    // Should not exit on iteration 2 with 5 max
    const result = shouldExitEarly(2, 3, 10, customConfig);
    expect(result).toBe(false);
    // Should exit on iteration 4 (last one, 0-indexed)
    const resultLast = shouldExitEarly(4, 3, 10, customConfig);
    expect(resultLast).toBe(true);
  });

  it("uses default maxReflectorIterations of 3 when not set", () => {
    const configNoMax = createTestConfig();
    (configNoMax as any).maxReflectorIterations = undefined;
    // Iteration 2 is last for default 3
    const result = shouldExitEarly(2, 3, 10, configNoMax);
    expect(result).toBe(true);
  });

  it("exits at exactly MAX_DELTAS boundary", () => {
    // At exactly 20 total
    const resultAt20 = shouldExitEarly(0, 5, 20, config);
    expect(resultAt20).toBe(true);
    // Just under 20
    const resultUnder = shouldExitEarly(0, 5, 19, config);
    expect(resultUnder).toBe(false);
  });
});

// =============================================================================
// Edge cases and integration
// =============================================================================
describe("reflect module integration", () => {
  it("formatBulletsForPrompt handles mixed maturities", () => {
    const bullets: PlaybookBullet[] = [
      createTestBullet({ id: "b1", content: "Proven", maturity: "proven", category: "test" }),
      createTestBullet({ id: "b2", content: "Established", maturity: "established", category: "test" }),
      createTestBullet({ id: "b3", content: "Candidate", maturity: "candidate", category: "test" }),
      createTestBullet({ id: "b4", content: "Deprecated", maturity: "deprecated", category: "test" }),
    ];
    const result = formatBulletsForPrompt(bullets);
    expect(result).toContain("★");
    expect(result).toContain("●");
    expect(result).toContain("○");
  });

  it("formatDiaryForPrompt preserves all information", () => {
    const diary = createTestDiary({
      sessionPath: "/sessions/full.jsonl",
      agent: "claude",
      workspace: "project",
      status: "success",
      timestamp: "2025-01-15T10:00:00Z",
      accomplishments: ["Acc 1", "Acc 2"],
      decisions: ["Dec 1"],
      challenges: ["Chal 1"],
      keyLearnings: ["Learn 1", "Learn 2", "Learn 3"],
      preferences: ["Pref 1"],
    });
    const result = formatDiaryForPrompt(diary);

    // All sections present
    expect(result).toContain("## Session Overview");
    expect(result).toContain("## Accomplishments");
    expect(result).toContain("## Decisions Made");
    expect(result).toContain("## Challenges Encountered");
    expect(result).toContain("## Key Learnings");
    expect(result).toContain("## User Preferences");

    // All items present
    expect(result).toContain("Acc 1");
    expect(result).toContain("Acc 2");
    expect(result).toContain("Dec 1");
    expect(result).toContain("Chal 1");
    expect(result).toContain("Learn 1");
    expect(result).toContain("Learn 2");
    expect(result).toContain("Learn 3");
    expect(result).toContain("Pref 1");
  });

  it("deduplicateDeltas preserves order", () => {
    const newDeltas: PlaybookDelta[] = [
      {
        type: "add",
        bullet: { content: "First", category: "test", scope: "global", kind: "workflow_rule" },
        reason: "1",
      },
      {
        type: "add",
        bullet: { content: "Second", category: "test", scope: "global", kind: "workflow_rule" },
        reason: "2",
      },
      {
        type: "add",
        bullet: { content: "Third", category: "test", scope: "global", kind: "workflow_rule" },
        reason: "3",
      },
    ];
    const result = deduplicateDeltas(newDeltas, []);
    expect(result).toHaveLength(3);
    expect(result[0].type === "add" && result[0].bullet.content).toBe("First");
    expect(result[1].type === "add" && result[1].bullet.content).toBe("Second");
    expect(result[2].type === "add" && result[2].bullet.content).toBe("Third");
  });

  it("hashDelta handles missing content gracefully", () => {
    const delta: PlaybookDelta = {
      type: "add",
      bullet: { category: "test", scope: "global", kind: "workflow_rule" } as any,
      reason: "test",
    };
    const hash = hashDelta(delta);
    expect(hash).toBe("add:undefined");
  });
});
