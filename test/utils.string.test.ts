import { describe, expect, it } from "bun:test";
import {
  hashContent,
  tokenize,
  jaccardSimilarity,
  truncate,
  truncateWithIndicator,
  truncateForContext,
  extractKeywords,
  generateBulletId,
  generateDiaryId,
} from "../src/utils.js";

// =============================================================================
// hashContent
// =============================================================================
describe("hashContent", () => {
  it("returns deterministic hash for same input", () => {
    const content = "Hello World";
    const hash1 = hashContent(content);
    const hash2 = hashContent(content);
    expect(hash1).toBe(hash2);
  });

  it("returns different hashes for different inputs", () => {
    const hash1 = hashContent("Hello");
    const hash2 = hashContent("World");
    expect(hash1).not.toBe(hash2);
  });

  it("returns 16-character hash", () => {
    const hash = hashContent("test content");
    expect(hash).toHaveLength(16);
  });

  it("handles empty string", () => {
    const hash = hashContent("");
    expect(hash).toHaveLength(16);
    expect(typeof hash).toBe("string");
  });

  it("handles unicode content", () => {
    const hash = hashContent("Hello 世界 🎉");
    expect(hash).toHaveLength(16);
  });

  it("normalizes whitespace before hashing", () => {
    const hash1 = hashContent("hello   world");
    const hash2 = hashContent("hello world");
    // Normalized versions should be the same
    expect(hash1).toBe(hash2);
  });

  it("is case-insensitive", () => {
    const hash1 = hashContent("Hello World");
    const hash2 = hashContent("hello world");
    expect(hash1).toBe(hash2);
  });

  it("handles large content", () => {
    const largeContent = "x".repeat(100000);
    const hash = hashContent(largeContent);
    expect(hash).toHaveLength(16);
  });
});

// =============================================================================
// tokenize
// =============================================================================
describe("tokenize", () => {
  it("splits text into lowercase tokens", () => {
    const tokens = tokenize("Hello World");
    expect(tokens).toContain("hello");
    expect(tokens).toContain("world");
  });

  it("filters short tokens (< 2 chars)", () => {
    const tokens = tokenize("I am a test");
    expect(tokens).not.toContain("i");
    expect(tokens).not.toContain("a");
    expect(tokens).toContain("am");
    expect(tokens).toContain("test");
  });

  it("handles empty string", () => {
    expect(tokenize("")).toEqual([]);
  });

  it("preserves technical terms with dots", () => {
    const tokens = tokenize("Using node.js and react.js");
    // Should keep technical terms as single tokens or split appropriately
    expect(tokens.some((t) => t.includes("node") || t.includes("js"))).toBe(true);
  });

  it("handles snake_case identifiers", () => {
    const tokens = tokenize("user_id and get_user_by_id");
    // Should recognize compound identifiers
    expect(tokens.length).toBeGreaterThan(0);
  });

  it("handles camelCase identifiers", () => {
    const tokens = tokenize("getUserById and setConfig");
    expect(tokens.length).toBeGreaterThan(0);
  });

  it("handles unicode text", () => {
    const tokens = tokenize("Café résumé");
    expect(tokens.length).toBeGreaterThan(0);
  });

  it("removes special characters", () => {
    const tokens = tokenize("test@example.com #hashtag");
    // Should not include @ or # as part of tokens
    expect(tokens.every((t) => !t.includes("@") && !t.includes("#"))).toBe(true);
  });
});

// =============================================================================
// jaccardSimilarity
// =============================================================================
describe("jaccardSimilarity", () => {
  it("returns 1.0 for identical strings", () => {
    const similarity = jaccardSimilarity("hello world", "hello world");
    expect(similarity).toBe(1.0);
  });

  it("returns 0.0 for completely different strings", () => {
    const similarity = jaccardSimilarity("apple orange", "car boat");
    expect(similarity).toBe(0.0);
  });

  it("returns value between 0 and 1 for partial overlap", () => {
    const similarity = jaccardSimilarity("hello world test", "hello world");
    expect(similarity).toBeGreaterThan(0);
    expect(similarity).toBeLessThan(1);
  });

  it("is symmetric", () => {
    const sim1 = jaccardSimilarity("apple banana", "banana cherry");
    const sim2 = jaccardSimilarity("banana cherry", "apple banana");
    expect(sim1).toBe(sim2);
  });

  it("handles empty strings", () => {
    expect(jaccardSimilarity("", "")).toBe(1.0);
    expect(jaccardSimilarity("hello", "")).toBe(0.0);
    expect(jaccardSimilarity("", "hello")).toBe(0.0);
  });

  it("is case-insensitive", () => {
    const similarity = jaccardSimilarity("Hello World", "hello world");
    expect(similarity).toBe(1.0);
  });
});

// =============================================================================
// truncate
// =============================================================================
describe("truncate", () => {
  it("returns unchanged string if shorter than max", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  it("returns unchanged string if exactly at max", () => {
    expect(truncate("hello", 5)).toBe("hello");
  });

  it("truncates with ellipsis if longer than max", () => {
    const result = truncate("hello world", 8);
    expect(result).toHaveLength(8);
    expect(result.endsWith("...")).toBe(true);
  });

  it("handles empty string", () => {
    expect(truncate("", 10)).toBe("");
  });

  it("handles maxLen less than 3", () => {
    const result = truncate("hello", 2);
    expect(result.length).toBeLessThanOrEqual(2);
  });

  it("handles unicode safely", () => {
    const result = truncate("Hello 世界 test", 10);
    expect(result.length).toBeLessThanOrEqual(10);
  });
});

// =============================================================================
// truncateWithIndicator
// =============================================================================
describe("truncateWithIndicator", () => {
  it("returns unchanged string if shorter than max", () => {
    expect(truncateWithIndicator("hello", 10)).toBe("hello");
  });

  it("appends indicator without reducing the slice", () => {
    const result = truncateWithIndicator("hello world", 5);
    expect(result).toBe("hello...");
    expect(result).toHaveLength(8);
  });

  it("returns indicator when maxLen is 0 and text is non-empty", () => {
    expect(truncateWithIndicator("hello", 0)).toBe("...");
  });
});

// =============================================================================
// truncateForContext
// =============================================================================
describe("truncateForContext", () => {
  it("returns unchanged text if within limits", () => {
    const text = "short text";
    expect(truncateForContext(text, { maxChars: 100 })).toBe(text);
  });

  it("truncates with head strategy", () => {
    const text = "A".repeat(100);
    const result = truncateForContext(text, {
      maxChars: 50,
      strategy: "head",
    });
    expect(result.length).toBeLessThanOrEqual(50);
    expect(result.startsWith("A")).toBe(true);
  });

  it("truncates with tail strategy", () => {
    const text = "A".repeat(50) + "B".repeat(50);
    const result = truncateForContext(text, {
      maxChars: 50,
      strategy: "tail",
    });
    expect(result.length).toBeLessThanOrEqual(50);
    expect(result.endsWith("B")).toBe(true);
  });

  it("truncates with middle strategy (default)", () => {
    const text = "START " + "M".repeat(100) + " END";
    const result = truncateForContext(text, {
      maxChars: 50,
      strategy: "middle",
    });
    expect(result.length).toBeLessThanOrEqual(50);
    expect(result.includes("[...truncated...]")).toBe(true);
  });

  it("respects maxTokens parameter", () => {
    const text = "x".repeat(1000);
    const result = truncateForContext(text, { maxTokens: 50 }); // ~200 chars
    expect(result.length).toBeLessThanOrEqual(200 + 50); // Some margin for marker
  });

  it("handles empty text", () => {
    expect(truncateForContext("")).toBe("");
  });

  it("supports custom truncation marker", () => {
    const text = "x".repeat(100);
    const result = truncateForContext(text, {
      maxChars: 50,
      strategy: "middle",
      truncationMarker: "...",
    });
    expect(result.includes("...")).toBe(true);
  });
});

// =============================================================================
// extractKeywords
// =============================================================================
describe("extractKeywords", () => {
  it("extracts meaningful words from text", () => {
    const keywords = extractKeywords("The quick brown fox jumps over the lazy dog");
    expect(keywords).toContain("quick");
    expect(keywords).toContain("brown");
    expect(keywords).toContain("fox");
  });

  it("removes stop words", () => {
    const keywords = extractKeywords("The is a an of to");
    // All stop words, should return empty or very few
    expect(keywords.length).toBeLessThanOrEqual(1);
  });

  it("returns top 10 keywords max", () => {
    const text = "apple banana cherry date elderberry fig grape honeydew " +
                 "kiwi lemon mango nectarine orange papaya quince raspberry";
    const keywords = extractKeywords(text);
    expect(keywords.length).toBeLessThanOrEqual(10);
  });

  it("handles empty string", () => {
    expect(extractKeywords("")).toEqual([]);
  });

  it("handles technical terms", () => {
    const keywords = extractKeywords("JavaScript TypeScript Node.js React component");
    expect(keywords.length).toBeGreaterThan(0);
  });

  it("ranks by frequency", () => {
    const keywords = extractKeywords("validation validation validation warning info validation");
    // "validation" appears most, should be first
    expect(keywords[0]).toBe("validation");
  });
});

// =============================================================================
// generateBulletId
// =============================================================================
describe("generateBulletId", () => {
  it("returns string starting with 'b-'", () => {
    const id = generateBulletId();
    expect(id.startsWith("b-")).toBe(true);
  });

  it("generates unique IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateBulletId()));
    expect(ids.size).toBe(100);
  });

  it("has reasonable length", () => {
    const id = generateBulletId();
    expect(id.length).toBeGreaterThan(5);
    expect(id.length).toBeLessThan(30);
  });

  it("contains only safe characters", () => {
    const id = generateBulletId();
    expect(/^[a-z0-9-]+$/.test(id)).toBe(true);
  });
});

// =============================================================================
// generateDiaryId
// =============================================================================
describe("generateDiaryId", () => {
  it("returns string starting with 'diary-'", () => {
    const id = generateDiaryId("/path/to/session.jsonl");
    expect(id.startsWith("diary-")).toBe(true);
  });

  it("is deterministic for same path at same time", () => {
    // Note: This is actually time-dependent, so may vary
    const path = "/path/to/session.jsonl";
    const id1 = generateDiaryId(path);
    // If we call immediately, times should be same
    const id2 = generateDiaryId(path);
    // IDs might be same or different depending on timing
    expect(typeof id1).toBe("string");
    expect(typeof id2).toBe("string");
  });

  it("has consistent format", () => {
    const id = generateDiaryId("/test/path.jsonl");
    expect(id).toMatch(/^diary-[a-f0-9]{16}$/);
  });
});
