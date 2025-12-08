/**
 * Property-based tests for deduplication functions using fast-check.
 *
 * Tests mathematical properties that should hold for any input:
 * - jaccardSimilarity: symmetry, bounds, identity
 * - hashContent: determinism, normalization consistency
 */

import { describe, it, expect } from "bun:test";
import fc from "fast-check";
import { jaccardSimilarity, hashContent, tokenize } from "../src/utils.js";

describe("Property-based deduplication tests", () => {
  // =========================================================================
  // JACCARD SIMILARITY PROPERTIES
  // =========================================================================

  describe("jaccardSimilarity properties", () => {
    it("is symmetric: jaccardSimilarity(a, b) === jaccardSimilarity(b, a)", () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 0, maxLength: 200 }),
          fc.string({ minLength: 0, maxLength: 200 }),
          (a, b) => {
            const ab = jaccardSimilarity(a, b);
            const ba = jaccardSimilarity(b, a);
            return ab === ba;
          }
        ),
        { numRuns: 500 }
      );
    });

    it("returns value in [0, 1] range", () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 0, maxLength: 200 }),
          fc.string({ minLength: 0, maxLength: 200 }),
          (a, b) => {
            const similarity = jaccardSimilarity(a, b);
            return similarity >= 0 && similarity <= 1;
          }
        ),
        { numRuns: 500 }
      );
    });

    it("identical strings have similarity 1.0", () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 200 }),
          (s) => {
            // Only test non-empty strings that produce tokens
            const tokens = tokenize(s);
            if (tokens.length === 0) return true; // Skip strings with no tokens
            return jaccardSimilarity(s, s) === 1.0;
          }
        ),
        { numRuns: 500 }
      );
    });

    it("empty strings with each other have similarity 1.0", () => {
      expect(jaccardSimilarity("", "")).toBe(1.0);
      expect(jaccardSimilarity("   ", "   ")).toBe(1.0);
    });

    it("empty vs non-empty string has similarity 0.0", () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 200 }),
          (s) => {
            const tokens = tokenize(s);
            if (tokens.length === 0) return true; // Skip strings with no useful tokens
            return jaccardSimilarity("", s) === 0.0;
          }
        ),
        { numRuns: 200 }
      );
    });

    it("similarity is reflexive: jaccardSimilarity(a, a) is maximal", () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 200 }),
          fc.string({ minLength: 1, maxLength: 200 }),
          (a, b) => {
            const tokensA = tokenize(a);
            const tokensB = tokenize(b);
            if (tokensA.length === 0 || tokensB.length === 0) return true;

            const selfSimilarity = jaccardSimilarity(a, a);
            const crossSimilarity = jaccardSimilarity(a, b);
            return selfSimilarity >= crossSimilarity;
          }
        ),
        { numRuns: 300 }
      );
    });

    it("adding tokens can only decrease or maintain similarity", () => {
      fc.assert(
        fc.property(
          fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 2, maxLength: 10 }),
          fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 1, maxLength: 5 }),
          (baseTokens, extraTokens) => {
            const base = baseTokens.join(" ");
            const extended = [...baseTokens, ...extraTokens].join(" ");

            // Similarity of base with itself should be >= similarity of base with extended
            const baseSelf = jaccardSimilarity(base, base);
            const baseExtended = jaccardSimilarity(base, extended);

            return baseSelf >= baseExtended;
          }
        ),
        { numRuns: 300 }
      );
    });
  });

  // =========================================================================
  // HASH CONTENT PROPERTIES
  // =========================================================================

  describe("hashContent properties", () => {
    it("is deterministic: hashContent(s) === hashContent(s)", () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 0, maxLength: 500 }),
          (s) => {
            return hashContent(s) === hashContent(s);
          }
        ),
        { numRuns: 500 }
      );
    });

    it("produces 16-character hex strings", () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 0, maxLength: 500 }),
          (s) => {
            const hash = hashContent(s);
            return hash.length === 16 && /^[0-9a-f]+$/.test(hash);
          }
        ),
        { numRuns: 300 }
      );
    });

    it("normalizes whitespace: 'a b' and 'a  b' produce same hash", () => {
      fc.assert(
        fc.property(
          fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 1, maxLength: 10 }),
          (words) => {
            const singleSpace = words.join(" ");
            const multiSpace = words.join("   ");
            const mixedSpace = words.join(" \t\n ");

            return hashContent(singleSpace) === hashContent(multiSpace) &&
                   hashContent(singleSpace) === hashContent(mixedSpace);
          }
        ),
        { numRuns: 200 }
      );
    });

    it("normalizes case: 'ABC' and 'abc' produce same hash", () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 100 }),
          (s) => {
            return hashContent(s.toLowerCase()) === hashContent(s.toUpperCase());
          }
        ),
        { numRuns: 200 }
      );
    });

    it("trims leading/trailing whitespace", () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 100 }),
          (s) => {
            const trimmed = s.trim();
            if (trimmed.length === 0) return true;

            const paddedLeading = "   " + trimmed;
            const paddedTrailing = trimmed + "   ";
            const paddedBoth = "   " + trimmed + "   ";

            const baseHash = hashContent(trimmed);
            return hashContent(paddedLeading) === baseHash &&
                   hashContent(paddedTrailing) === baseHash &&
                   hashContent(paddedBoth) === baseHash;
          }
        ),
        { numRuns: 200 }
      );
    });

    it("different content usually produces different hashes (collision resistance)", () => {
      // This is probabilistic - we test that distinct normalized strings
      // produce distinct hashes in almost all cases
      const hashes = new Set<string>();
      const collisions: Array<{ a: string; b: string }> = [];

      fc.assert(
        fc.property(
          fc.string({ minLength: 5, maxLength: 100 }),
          (s) => {
            // Normalize like hashContent does
            const normalized = s.toLowerCase().replace(/\s+/g, " ").trim();
            if (normalized.length < 3) return true; // Skip very short strings

            const hash = hashContent(s);

            // Check if we've seen this hash before with different content
            if (hashes.has(hash)) {
              collisions.push({ a: s, b: hash });
            }
            hashes.add(hash);

            return true; // Always pass, we check collisions at the end
          }
        ),
        { numRuns: 1000 }
      );

      // Allow very few collisions (SHA-256 truncated to 16 hex chars = 64 bits)
      // With 1000 samples, birthday paradox gives ~0.00003% collision chance
      expect(collisions.length).toBeLessThan(5);
    });
  });

  // =========================================================================
  // TOKENIZE PROPERTIES
  // =========================================================================

  describe("tokenize properties", () => {
    it("is deterministic", () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 0, maxLength: 200 }),
          (s) => {
            const tokens1 = tokenize(s);
            const tokens2 = tokenize(s);
            return JSON.stringify(tokens1) === JSON.stringify(tokens2);
          }
        ),
        { numRuns: 300 }
      );
    });

    it("returns array for any input", () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 0, maxLength: 200 }),
          (s) => {
            const tokens = tokenize(s);
            return Array.isArray(tokens);
          }
        ),
        { numRuns: 300 }
      );
    });

    it("empty string produces empty array", () => {
      expect(tokenize("")).toEqual([]);
    });

    it("whitespace-only string produces empty array", () => {
      // Test specific whitespace patterns
      expect(tokenize("   ")).toEqual([]);
      expect(tokenize("\t\t")).toEqual([]);
      expect(tokenize("\n\n")).toEqual([]);
      expect(tokenize(" \t \n ")).toEqual([]);
    });

    it("tokens are lowercase", () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 200 }),
          (s) => {
            const tokens = tokenize(s);
            return tokens.every(t => t === t.toLowerCase());
          }
        ),
        { numRuns: 300 }
      );
    });
  });

  // =========================================================================
  // DEDUPLICATION INTEGRATION PROPERTIES
  // =========================================================================

  describe("deduplication integration", () => {
    it("exact duplicates are always detected via hash equality", () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 200 }),
          (content) => {
            const hash1 = hashContent(content);
            const hash2 = hashContent(content);
            return hash1 === hash2;
          }
        ),
        { numRuns: 500 }
      );
    });

    it("normalized duplicates are detected via hash equality", () => {
      fc.assert(
        fc.property(
          fc.array(fc.string({ minLength: 1, maxLength: 30 }), { minLength: 1, maxLength: 10 }),
          (words) => {
            const variant1 = words.join(" ");
            const variant2 = words.join("   "); // Extra spaces
            const variant3 = words.map(w => w.toUpperCase()).join(" "); // Uppercase

            const hash1 = hashContent(variant1);
            const hash2 = hashContent(variant2);
            const hash3 = hashContent(variant3);

            return hash1 === hash2 && hash1 === hash3;
          }
        ),
        { numRuns: 300 }
      );
    });

    it("high jaccard similarity correlates with semantic similarity", () => {
      // Test that strings sharing many words have high similarity
      // Use alphanumeric words that will reliably tokenize
      const wordArbitrary = fc.stringMatching(/^[a-z]{3,10}$/);

      fc.assert(
        fc.property(
          fc.array(wordArbitrary, { minLength: 5, maxLength: 10 }),
          (words) => {
            // Filter out any empty strings just in case
            const validWords = words.filter(w => w.length >= 3);
            if (validWords.length < 5) return true; // Skip if not enough words

            const sentence1 = validWords.join(" ");
            const sentence2 = validWords.slice(0, -1).join(" "); // Remove last word

            const similarity = jaccardSimilarity(sentence1, sentence2);
            // Removing one word from N words should give similarity of (N-1)/N
            // which for 5+ words is at least 0.8
            return similarity >= 0.6;
          }
        ),
        { numRuns: 200 }
      );
    });

    it("completely different strings have low similarity", () => {
      fc.assert(
        fc.property(
          fc.array(fc.constantFrom("alpha", "beta", "gamma", "delta"), { minLength: 3, maxLength: 5 }),
          fc.array(fc.constantFrom("one", "two", "three", "four"), { minLength: 3, maxLength: 5 }),
          (words1, words2) => {
            const sentence1 = words1.join(" ");
            const sentence2 = words2.join(" ");

            const similarity = jaccardSimilarity(sentence1, sentence2);
            // Disjoint word sets should have 0 similarity
            return similarity === 0;
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
