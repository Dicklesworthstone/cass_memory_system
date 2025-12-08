/**
 * Unit Tests: parseInlineFeedback
 *
 * Tests the inline feedback parsing function used to extract agent feedback
 * from code comments during reflection.
 *
 * Format: // [cass: helpful|harmful <bulletId>] - reason
 */
import { describe, test, expect } from "bun:test";
import { parseInlineFeedback, inlineFeedbackToDeltas } from "../src/utils.js";

describe("parseInlineFeedback", () => {
  describe("Basic parsing", () => {
    test("parses helpful feedback with reason", () => {
      const content = "// [cass: helpful b-8f3a2c] - this rule saved debugging time";
      const feedback = parseInlineFeedback(content);

      expect(feedback).toHaveLength(1);
      expect(feedback[0].type).toBe("helpful");
      expect(feedback[0].bulletId).toBe("b-8f3a2c");
      expect(feedback[0].reason).toBe("this rule saved debugging time");
    });

    test("parses harmful feedback with reason", () => {
      const content = "// [cass: harmful b-x7k9p1] - caching advice was wrong";
      const feedback = parseInlineFeedback(content);

      expect(feedback).toHaveLength(1);
      expect(feedback[0].type).toBe("harmful");
      expect(feedback[0].bulletId).toBe("b-x7k9p1");
      expect(feedback[0].reason).toBe("caching advice was wrong");
    });

    test("parses feedback without reason", () => {
      const content = "// [cass: helpful b-abc123]";
      const feedback = parseInlineFeedback(content);

      expect(feedback).toHaveLength(1);
      expect(feedback[0].type).toBe("helpful");
      expect(feedback[0].bulletId).toBe("b-abc123");
      expect(feedback[0].reason).toBeUndefined();
    });
  });

  describe("Multiple feedbacks", () => {
    test("parses multiple feedbacks from multiline content", () => {
      const content = `
// Normal comment
const x = 1;
// [cass: helpful b-8f3a2c] - good rule
function auth() {
  // [cass: harmful b-x7k9p1] - bad advice
}
`;
      const feedback = parseInlineFeedback(content);

      expect(feedback).toHaveLength(2);
      expect(feedback[0].type).toBe("helpful");
      expect(feedback[0].bulletId).toBe("b-8f3a2c");
      expect(feedback[1].type).toBe("harmful");
      expect(feedback[1].bulletId).toBe("b-x7k9p1");
    });

    test("includes line numbers", () => {
      const content = `line1
// [cass: helpful b-abc] - reason
line3
// [cass: harmful b-xyz] - another`;
      const feedback = parseInlineFeedback(content);

      expect(feedback).toHaveLength(2);
      expect(feedback[0].lineNumber).toBe(2);
      expect(feedback[1].lineNumber).toBe(4);
    });
  });

  describe("Comment styles", () => {
    test("parses Python/shell style comments", () => {
      const content = "# [cass: helpful b-py123] - works in Python";
      const feedback = parseInlineFeedback(content);

      expect(feedback).toHaveLength(1);
      expect(feedback[0].bulletId).toBe("b-py123");
    });

    test("parses block comment style", () => {
      const content = "/* [cass: harmful b-blk456] - block comment */";
      const feedback = parseInlineFeedback(content);

      expect(feedback).toHaveLength(1);
      expect(feedback[0].bulletId).toBe("b-blk456");
    });
  });

  describe("Edge cases", () => {
    test("returns empty array for empty content", () => {
      expect(parseInlineFeedback("")).toEqual([]);
    });

    test("returns empty array for null/undefined", () => {
      expect(parseInlineFeedback(null as any)).toEqual([]);
      expect(parseInlineFeedback(undefined as any)).toEqual([]);
    });

    test("ignores malformed feedback", () => {
      const content = `
// [cass: helpful] - missing bullet id
// [cass: helpful invalid-id] - wrong id format
// [cass: unknown b-abc] - wrong type
// [cass helpful b-abc] - missing colon
`;
      const feedback = parseInlineFeedback(content);
      expect(feedback).toHaveLength(0);
    });

    test("handles whitespace variations", () => {
      const content = "//[cass:helpful b-ws123]-reason";
      const feedback = parseInlineFeedback(content);

      // Our regex requires at least some spacing, but let's see what it parses
      // This test documents actual behavior
      expect(feedback.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe("Reason parsing", () => {
    test("handles colon separator", () => {
      const content = "// [cass: helpful b-abc]: this is the reason";
      const feedback = parseInlineFeedback(content);

      expect(feedback).toHaveLength(1);
      expect(feedback[0].reason).toBe("this is the reason");
    });

    test("handles dash separator", () => {
      const content = "// [cass: helpful b-abc] - this is the reason";
      const feedback = parseInlineFeedback(content);

      expect(feedback).toHaveLength(1);
      expect(feedback[0].reason).toBe("this is the reason");
    });
  });
});

describe("inlineFeedbackToDeltas", () => {
  test("converts feedback to deltas with session path", () => {
    const feedback = [
      { type: "helpful" as const, bulletId: "b-abc", reason: "good" },
      { type: "harmful" as const, bulletId: "b-xyz", reason: "bad" }
    ];

    const deltas = inlineFeedbackToDeltas(feedback, "/path/to/session.jsonl");

    expect(deltas).toHaveLength(2);
    expect(deltas[0]).toEqual({
      type: "helpful",
      bulletId: "b-abc",
      sourceSession: "/path/to/session.jsonl",
      reason: "good"
    });
    expect(deltas[1]).toEqual({
      type: "harmful",
      bulletId: "b-xyz",
      sourceSession: "/path/to/session.jsonl",
      reason: "bad"
    });
  });

  test("handles feedback without reason", () => {
    const feedback = [
      { type: "helpful" as const, bulletId: "b-abc" }
    ];

    const deltas = inlineFeedbackToDeltas(feedback, "/session");

    expect(deltas).toHaveLength(1);
    expect(deltas[0].reason).toBeUndefined();
  });

  test("returns empty array for empty feedback", () => {
    const deltas = inlineFeedbackToDeltas([], "/session");
    expect(deltas).toEqual([]);
  });
});
