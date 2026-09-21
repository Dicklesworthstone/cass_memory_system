/**
 * Unit Tests: scoreBulletRelevance
 *
 * Tests the bullet relevance scoring function used for context retrieval.
 * Scoring rules:
 * - Exact token match in content: +3 points
 * - Partial substring match in content: +1 point
 * - Tag match: +5 points
 */
import { describe, expect, test } from "bun:test";
import { scoreBulletRelevance } from "../src/utils.js";

describe("scoreBulletRelevance", () => {
  describe("Edge cases - Empty inputs", () => {
    test("returns 0 for empty content", () => {
      expect(scoreBulletRelevance("", ["tag1"], ["keyword"])).toBe(0);
    });

    test("returns 0 for empty keywords array", () => {
      expect(scoreBulletRelevance("some content", ["tag1"], [])).toBe(0);
    });

    test("returns 0 for both empty", () => {
      expect(scoreBulletRelevance("", [], [])).toBe(0);
    });

    test("handles empty tags array gracefully", () => {
      const score = scoreBulletRelevance("test content", [], ["test"]);
      expect(score).toBe(3); // exact token match only
    });
  });

  describe("Exact token matching (+3 points)", () => {
    test("scores exact single word match", () => {
      const score = scoreBulletRelevance("The user wants authentication", [], ["authentication"]);
      expect(score).toBe(3);
    });

    test("scores multiple exact matches", () => {
      const score = scoreBulletRelevance(
        "Use typescript for authentication",
        [],
        ["typescript", "authentication"],
      );
      expect(score).toBe(6); // 3 + 3
    });

    test("is case insensitive", () => {
      const score = scoreBulletRelevance("TypeScript is great", [], ["typescript"]);
      expect(score).toBe(3);
    });

    test("matches word boundaries via tokenization", () => {
      const score = scoreBulletRelevance("config settings", [], ["config"]);
      expect(score).toBe(3);
    });
  });

  describe("Partial substring matching (+1 point)", () => {
    test("scores partial match when token not found", () => {
      // "auth" is not a complete token, but is substring of "authentication"
      const score = scoreBulletRelevance("Use authentication for login", [], ["auth"]);
      expect(score).toBe(1);
    });

    test("scores partial matches for compound words", () => {
      const score = scoreBulletRelevance("Implement middleware handler", [], ["ware"]);
      expect(score).toBe(1);
    });

    test("does not double-count when both exact and partial match", () => {
      // "test" is an exact token, should get 3, not 3+1
      const score = scoreBulletRelevance("test driven development", [], ["test"]);
      expect(score).toBe(3);
    });
  });

  describe("Tag matching (+5 points)", () => {
    test("scores tag match", () => {
      const score = scoreBulletRelevance("Some content", ["security"], ["security"]);
      expect(score).toBe(5);
    });

    test("tag matching is case insensitive", () => {
      const score = scoreBulletRelevance("Some content", ["Security"], ["security"]);
      expect(score).toBe(5);
    });

    test("multiple tag matches accumulate", () => {
      const score = scoreBulletRelevance("Some content", ["api", "rest"], ["api", "rest"]);
      expect(score).toBe(10); // 5 + 5
    });

    test("tag match adds to content match", () => {
      const score = scoreBulletRelevance("Implement security checks", ["security"], ["security"]);
      // Content exact match (3) + tag match (5) = 8
      expect(score).toBe(8);
    });
  });

  describe("Combined scoring scenarios", () => {
    test("real-world bullet with multiple matches", () => {
      const content = "Add rate limiting to the REST API endpoints";
      const tags = ["api", "security"];
      const keywords = ["api", "rate", "limiting"];

      // "api" exact: 3, tag: 5 = 8
      // "rate" exact: 3
      // "limiting" exact: 3
      const score = scoreBulletRelevance(content, tags, keywords);
      expect(score).toBe(14);
    });

    test("content match without tag match", () => {
      const score = scoreBulletRelevance("Configure database connection", ["db"], ["database"]);
      // "database" exact: 3, no tag match for "database"
      expect(score).toBe(3);
    });

    test("tag match without content match", () => {
      const score = scoreBulletRelevance("Unrelated content here", ["auth"], ["auth"]);
      // No content match, tag match: 5
      expect(score).toBe(5);
    });

    test("partial content match with tag match", () => {
      const score = scoreBulletRelevance("Use authentication middleware", ["auth"], ["auth"]);
      // Partial "auth" in "authentication": 1, tag match: 5
      expect(score).toBe(6);
    });
  });

  describe("Performance considerations", () => {
    test("handles long content efficiently", () => {
      const longContent = "word ".repeat(1000) + "target";
      const score = scoreBulletRelevance(longContent, [], ["target"]);
      expect(score).toBe(3);
    });

    test("handles many keywords", () => {
      const content = "word1 word2 word3";
      const keywords = Array.from({ length: 50 }, (_, i) => `keyword${i}`);
      keywords.push("word1"); // Add one that matches

      const score = scoreBulletRelevance(content, [], keywords);
      expect(score).toBe(3); // Only word1 matches
    });

    test("does not double-count duplicate keywords", () => {
      const content = "secure auth";
      const keywords = ["auth", "auth", "Auth"];
      const score = scoreBulletRelevance(content, [], keywords);
      expect(score).toBe(3); // exact match once, not multiplied by duplicates
    });

    test("handles many tags", () => {
      const tags = Array.from({ length: 20 }, (_, i) => `tag${i}`);
      tags.push("match");

      const score = scoreBulletRelevance("content", tags, ["match"]);
      expect(score).toBe(5); // Tag match only
    });
  });

  describe("Special characters and edge cases", () => {
    test("handles content with special characters", () => {
      const score = scoreBulletRelevance("Use @decorator for auth", [], ["decorator"]);
      expect(score).toBe(3);
    });

    test("handles hyphenated words", () => {
      // Depends on tokenize implementation
      const score = scoreBulletRelevance("Add rate-limiting feature", [], ["rate"]);
      // "rate" should be a token after splitting on hyphens
      expect(score).toBeGreaterThan(0);
    });

    test("handles numeric content", () => {
      const score = scoreBulletRelevance("Version 2.0 release", [], ["version"]);
      expect(score).toBe(3);
    });

    test("handles unicode characters", () => {
      const score = scoreBulletRelevance("Implement i18n for français", [], ["i18n"]);
      expect(score).toBe(3);
    });
  });
});
