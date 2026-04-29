/**
 * Unit tests for auto-outcome recording in reflect pipeline.
 *
 * Tests the new functions added to outcome.ts:
 * - extractRuleIdsFromTranscript: Extracts bullet IDs from session content
 * - classifySessionOutcome: Classifies session outcome via heuristics
 *
 * And the integration in orchestrator.ts:
 * - Auto-recording outcomes during reflection
 * - Inline feedback extraction during reflection
 */
import { describe, it, expect } from "bun:test";
import {
  extractRuleIdsFromTranscript,
  classifySessionOutcome,
  detectSentiment,
} from "../src/outcome.js";
import type { DiaryEntry } from "../src/types.js";

// --- extractRuleIdsFromTranscript ---

describe("extractRuleIdsFromTranscript", () => {
  it("returns empty array for empty/null content", () => {
    expect(extractRuleIdsFromTranscript("")).toEqual([]);
    expect(extractRuleIdsFromTranscript(null as any)).toEqual([]);
    expect(extractRuleIdsFromTranscript(undefined as any)).toEqual([]);
  });

  it("extracts single rule ID", () => {
    const content = "Following rule b-m2x1k5-abc123 for this task";
    expect(extractRuleIdsFromTranscript(content)).toEqual(["b-m2x1k5-abc123"]);
  });

  it("extracts multiple rule IDs", () => {
    const content = `
      Using b-m2x1k5-abc123 and b-n3y2l6-def456 from the playbook.
      Also referencing b-o4z3m7-ghi789 for context.
    `;
    const ids = extractRuleIdsFromTranscript(content);
    expect(ids).toHaveLength(3);
    expect(ids).toContain("b-m2x1k5-abc123");
    expect(ids).toContain("b-n3y2l6-def456");
    expect(ids).toContain("b-o4z3m7-ghi789");
  });

  it("deduplicates repeated IDs", () => {
    const content = `
      Following b-abc123-xyz for auth. Still using b-abc123-xyz here.
      And b-abc123-xyz again in the conclusion.
    `;
    expect(extractRuleIdsFromTranscript(content)).toEqual(["b-abc123-xyz"]);
  });

  it("extracts IDs from JSON context output", () => {
    const content = `{"id": "b-m2x1k5-abc123", "content": "Always use strict mode"}`;
    expect(extractRuleIdsFromTranscript(content)).toEqual(["b-m2x1k5-abc123"]);
  });

  it("extracts IDs from bracketed format", () => {
    const content = `[b-8f3a2c-xyz] ★ Always validate user input (3+ / 0-)`;
    expect(extractRuleIdsFromTranscript(content)).toEqual(["b-8f3a2c-xyz"]);
  });

  it("extracts IDs from inline feedback comments", () => {
    const content = `
      // [cass: helpful b-8f3a2c] - saved debugging time
      function doStuff() {
        // [cass: harmful b-x7k9p1] - wrong advice
      }
    `;
    const ids = extractRuleIdsFromTranscript(content);
    expect(ids).toContain("b-8f3a2c");
    expect(ids).toContain("b-x7k9p1");
  });

  it("handles short-form IDs (6+ chars)", () => {
    const content = "Referencing b-abc123 from the playbook";
    expect(extractRuleIdsFromTranscript(content)).toEqual(["b-abc123"]);
  });

  it("does not match too-short segments", () => {
    // "b-to" should not match (only 2 chars after b-)
    const content = "going from a-to-b-to-c quickly";
    expect(extractRuleIdsFromTranscript(content)).toEqual([]);
  });

  it("does not match common words like b-tree, b-tag", () => {
    const content = "Use a b-tree data structure with b-tag elements";
    expect(extractRuleIdsFromTranscript(content)).toEqual([]);
  });

  it("does not match pure-alpha words like b-spline, b-factor", () => {
    // These are 6+ chars but have no digits — real IDs always have digits
    const content = "Use b-spline curves and compute the b-factor coefficient";
    expect(extractRuleIdsFromTranscript(content)).toEqual([]);
  });

  it("does not match 5-char segments that could be short words", () => {
    const content = "the b-value and b-point were set";
    expect(extractRuleIdsFromTranscript(content)).toEqual([]);
  });

  it("lowercases all IDs for consistency", () => {
    const content = "Using B-ABC123-XYZ and b-abc123-xyz";
    const ids = extractRuleIdsFromTranscript(content);
    expect(ids).toEqual(["b-abc123-xyz"]);
  });

  it("handles content without any rule IDs", () => {
    const content = "Just a normal conversation about coding best practices.";
    expect(extractRuleIdsFromTranscript(content)).toEqual([]);
  });

  it("does not match UUID fragments (regression for #46)", () => {
    // Session paths often contain canonical UUIDs. The previous regex used
    // `\b` which matched at the boundary between `0` and `b` inside a UUID,
    // yielding a false-positive extraction like `b-9695-acef9cb0bbdc`.
    const content =
      "session at ~/.claude/projects/foo/00b8018e-2cd7-4e0b-9695-acef9cb0bbdc.jsonl mentioned";
    const ids = extractRuleIdsFromTranscript(content);
    expect(ids).not.toContain("b-9695-acef9cb0bbdc");
    expect(ids).toEqual([]);
  });

  it("does not match hex-string fragments preceded by hex digits", () => {
    // Belt-and-suspenders: any hex digit ahead of `b-` should block the match.
    const content = "sha 0123456789abcdef0b-cafef00d12 referenced";
    expect(extractRuleIdsFromTranscript(content)).toEqual([]);
  });

  it("still matches valid bullet IDs adjacent to punctuation/whitespace", () => {
    // Real bullet IDs from Date.now().toString(36) + randomBytes look like this.
    // They typically appear at line start, after whitespace, or after `:`/`[`,
    // none of which are hex digits, so the lookbehind permits them.
    const content = "rule b-mn3ot59c-nny4gb applied";
    expect(extractRuleIdsFromTranscript(content)).toContain("b-mn3ot59c-nny4gb");
  });
});

// --- classifySessionOutcome ---

function makeDiary(overrides: Partial<DiaryEntry> = {}): DiaryEntry {
  return {
    id: "test-diary-1",
    sessionPath: "/path/to/session.jsonl",
    timestamp: new Date().toISOString(),
    agent: "claude",
    status: "success",
    accomplishments: ["Fixed the login bug"],
    decisions: [],
    challenges: [],
    preferences: [],
    keyLearnings: ["Always check null pointers"],
    relatedSessions: [],
    tags: [],
    searchAnchors: [],
    ...overrides,
  };
}

describe("classifySessionOutcome", () => {
  it("returns null when no rule IDs provided", () => {
    const result = classifySessionOutcome("some content", makeDiary(), []);
    expect(result).toBeNull();
  });

  it("maps diary success status to success outcome", () => {
    const content = "Everything went smoothly, thanks!";
    const result = classifySessionOutcome(content, makeDiary({ status: "success" }), ["b-abc123"]);
    expect(result).not.toBeNull();
    expect(result!.outcome).toBe("success");
    expect(result!.sentiment).toBe("positive");
  });

  it("maps diary failure status to failure outcome", () => {
    const content = "That doesn't work at all, try again";
    const result = classifySessionOutcome(content, makeDiary({ status: "failure" }), ["b-abc123"]);
    expect(result).not.toBeNull();
    expect(result!.outcome).toBe("failure");
    expect(result!.sentiment).toBe("negative");
  });

  it("maps diary mixed status to mixed outcome", () => {
    const content = "Partially done, some issues remain";
    const result = classifySessionOutcome(content, makeDiary({ status: "mixed" }), ["b-abc123"]);
    expect(result).not.toBeNull();
    expect(result!.outcome).toBe("mixed");
  });

  it("includes all rule IDs in rulesUsed", () => {
    const ruleIds = ["b-abc123", "b-def456", "b-ghi789"];
    const result = classifySessionOutcome("good work", makeDiary(), ruleIds);
    expect(result!.rulesUsed).toEqual(ruleIds);
  });

  it("detects errors in content", () => {
    const content = `
      Error: Cannot read property 'x' of undefined
      Error: Connection refused
      Exception thrown at line 42
      Failed to compile module
    `;
    const result = classifySessionOutcome(content, makeDiary({ status: "failure" }), ["b-abc123"]);
    expect(result!.errorCount).toBeGreaterThan(0);
  });

  it("detects retries in content", () => {
    const content = "Let me try again with a different approach. Retrying the build now.";
    const result = classifySessionOutcome(content, makeDiary({ status: "mixed" }), ["b-abc123"]);
    expect(result!.hadRetries).toBe(true);
  });

  it("detects tool rejections in content", () => {
    const content = "The user denied the tool call. Permission denied for file write.";
    const result = classifySessionOutcome(content, makeDiary({ status: "mixed" }), ["b-abc123"]);
    expect(result!.errorCount).toBeGreaterThan(0);
  });

  it("uses tail of content for sentiment (more recent is more relevant)", () => {
    // Negative at the start, positive at the end
    const content = "That doesn't work. " + "x".repeat(5000) + " Thanks, looks good!";
    const result = classifySessionOutcome(content, makeDiary(), ["b-abc123"]);
    // The tail should capture the positive sentiment
    expect(result!.sentiment).toBe("positive");
  });

  it("uses first accomplishment as task", () => {
    const diary = makeDiary({ accomplishments: ["Implemented OAuth flow", "Added tests"] });
    const result = classifySessionOutcome("done", diary, ["b-abc123"]);
    expect(result!.task).toBe("Implemented OAuth flow");
  });

  it("falls back to keyLearnings when no accomplishments", () => {
    const diary = makeDiary({ accomplishments: [], keyLearnings: ["TypeScript generics are tricky"] });
    const result = classifySessionOutcome("done", diary, ["b-abc123"]);
    expect(result!.task).toBe("TypeScript generics are tricky");
  });

  it("includes sessionId from diary", () => {
    const diary = makeDiary({ sessionPath: "/sessions/test-session.jsonl" });
    const result = classifySessionOutcome("done", diary, ["b-abc123"]);
    expect(result!.sessionId).toBe("/sessions/test-session.jsonl");
  });

  it("includes duration from diary", () => {
    const diary = makeDiary({ duration: 300 });
    const result = classifySessionOutcome("done", diary, ["b-abc123"]);
    expect(result!.durationSec).toBe(300);
  });
});

// --- Enhanced detectSentiment ---

describe("detectSentiment (enhanced patterns)", () => {
  it("detects 'lgtm' as positive", () => {
    expect(detectSentiment("LGTM, ship it!")).toBe("positive");
  });

  it("detects 'looks good' as positive", () => {
    expect(detectSentiment("This looks good to me")).toBe("positive");
  });

  it("detects 'nice work' as positive", () => {
    expect(detectSentiment("Nice work on this fix")).toBe("positive");
  });

  it("detects 'well done' as positive", () => {
    expect(detectSentiment("Well done!")).toBe("positive");
  });

  it("detects 'ship it' as positive", () => {
    expect(detectSentiment("Ship it!")).toBe("positive");
  });

  it("detects 'revert' as negative", () => {
    expect(detectSentiment("We need to revert this change")).toBe("negative");
  });

  it("detects 'don't do that' as negative", () => {
    expect(detectSentiment("Don't do that again")).toBe("negative");
  });

  it("detects 'that's not right' as negative", () => {
    expect(detectSentiment("That's not right at all")).toBe("negative");
  });

  it("detects 'start over' as negative", () => {
    expect(detectSentiment("Let's start over from scratch")).toBe("negative");
  });

  it("detects 'rollback' as negative", () => {
    expect(detectSentiment("We need to rollback the deploy")).toBe("negative");
  });
});
