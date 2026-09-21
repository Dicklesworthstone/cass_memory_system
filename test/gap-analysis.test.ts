import { describe, expect, test } from "bun:test";
import {
  analyzePlaybookGaps,
  CATEGORY_KEYWORDS,
  detectCategories,
  getGapSearchQueries,
  RULE_CATEGORIES,
  type RuleCategory,
  scoreSessionForGaps,
} from "../src/gap-analysis.js";
import { createEmptyPlaybook } from "../src/playbook.js";
import { createTestBullet } from "./helpers/factories.js";

describe("gap-analysis.ts", () => {
  describe("RULE_CATEGORIES", () => {
    test("contains expected categories", () => {
      expect(RULE_CATEGORIES).toContain("debugging");
      expect(RULE_CATEGORIES).toContain("testing");
      expect(RULE_CATEGORIES).toContain("architecture");
      expect(RULE_CATEGORIES).toContain("security");
      expect(RULE_CATEGORIES).toContain("performance");
      expect(RULE_CATEGORIES.length).toBe(10);
    });
  });

  describe("CATEGORY_KEYWORDS", () => {
    test("has keywords for each category", () => {
      for (const cat of RULE_CATEGORIES) {
        expect(CATEGORY_KEYWORDS[cat]).toBeDefined();
        expect(CATEGORY_KEYWORDS[cat].length).toBeGreaterThan(0);
      }
    });

    test("debugging keywords include common terms", () => {
      expect(CATEGORY_KEYWORDS.debugging).toContain("debug");
      expect(CATEGORY_KEYWORDS.debugging).toContain("error");
      expect(CATEGORY_KEYWORDS.debugging).toContain("bug");
    });

    test("testing keywords include common terms", () => {
      expect(CATEGORY_KEYWORDS.testing).toContain("test");
      expect(CATEGORY_KEYWORDS.testing).toContain("mock");
      expect(CATEGORY_KEYWORDS.testing).toContain("jest");
    });
  });

  describe("analyzePlaybookGaps", () => {
    test("empty playbook has all categories as critical", () => {
      const pb = createEmptyPlaybook("test");
      const analysis = analyzePlaybookGaps(pb);

      expect(analysis.totalRules).toBe(0);
      expect(analysis.gaps.critical.length).toBe(RULE_CATEGORIES.length);
      expect(analysis.gaps.underrepresented.length).toBe(0);
      expect(analysis.wellCovered.length).toBe(0);
    });

    test("playbook with one rule in one category", () => {
      const pb = createEmptyPlaybook("test");
      pb.bullets.push(createTestBullet({ content: "Test rule", category: "testing" }));

      const analysis = analyzePlaybookGaps(pb);

      expect(analysis.totalRules).toBe(1);
      expect(analysis.byCategory.testing.count).toBe(1);
      expect(analysis.byCategory.testing.status).toBe("underrepresented");
      expect(analysis.gaps.underrepresented).toContain("testing");
      // All other categories should be critical
      expect(analysis.gaps.critical).toContain("debugging");
      expect(analysis.gaps.critical).not.toContain("testing");
    });

    test("playbook with 3+ rules becomes adequate", () => {
      const pb = createEmptyPlaybook("test");
      for (let i = 0; i < 3; i++) {
        pb.bullets.push(createTestBullet({ content: `Test rule ${i}`, category: "testing" }));
      }

      const analysis = analyzePlaybookGaps(pb);

      expect(analysis.byCategory.testing.count).toBe(3);
      expect(analysis.byCategory.testing.status).toBe("adequate");
      expect(analysis.gaps.critical).not.toContain("testing");
      expect(analysis.gaps.underrepresented).not.toContain("testing");
    });

    test("playbook with 11+ rules becomes well-covered", () => {
      const pb = createEmptyPlaybook("test");
      for (let i = 0; i < 11; i++) {
        pb.bullets.push(createTestBullet({ content: `Security rule ${i}`, category: "security" }));
      }

      const analysis = analyzePlaybookGaps(pb);

      expect(analysis.byCategory.security.count).toBe(11);
      expect(analysis.byCategory.security.status).toBe("well-covered");
      expect(analysis.wellCovered).toContain("security");
    });

    test("retired and deprecated bullets are excluded", () => {
      const pb = createEmptyPlaybook("test");
      pb.bullets.push(createTestBullet({ content: "Active rule", category: "testing" }));
      pb.bullets.push(
        createTestBullet({ content: "Retired rule", category: "testing", state: "retired" }),
      );
      pb.bullets.push(
        createTestBullet({ content: "Deprecated rule", category: "testing", deprecated: true }),
      );

      const analysis = analyzePlaybookGaps(pb);

      expect(analysis.totalRules).toBe(1);
      expect(analysis.byCategory.testing.count).toBe(1);
    });

    test("suggestions for empty playbook", () => {
      const pb = createEmptyPlaybook("test");
      const analysis = analyzePlaybookGaps(pb);

      expect(analysis.suggestions).toContain("empty");
    });

    test("suggestions for playbook with gaps", () => {
      const pb = createEmptyPlaybook("test");
      pb.bullets.push(createTestBullet({ content: "Test rule", category: "testing" }));

      const analysis = analyzePlaybookGaps(pb);

      // Should mention critical categories (0 rules)
      expect(analysis.suggestions).toContain("no rules");
    });

    test("calculates percentage correctly", () => {
      const pb = createEmptyPlaybook("test");
      for (let i = 0; i < 5; i++) {
        pb.bullets.push(createTestBullet({ content: `Test rule ${i}`, category: "testing" }));
      }
      for (let i = 0; i < 5; i++) {
        pb.bullets.push(createTestBullet({ content: `Debug rule ${i}`, category: "debugging" }));
      }

      const analysis = analyzePlaybookGaps(pb);

      expect(analysis.totalRules).toBe(10);
      expect(analysis.byCategory.testing.percentage).toBe(50);
      expect(analysis.byCategory.debugging.percentage).toBe(50);
    });
  });

  describe("detectCategories", () => {
    test("detects debugging from error text", () => {
      const categories = detectCategories("I found a bug and need to debug this error");
      expect(categories).toContain("debugging");
    });

    test("detects testing from test text", () => {
      const categories = detectCategories("Writing unit tests with mock functions");
      expect(categories).toContain("testing");
    });

    test("detects multiple categories", () => {
      const categories = detectCategories("Debug the test error in the API endpoint");
      expect(categories.length).toBeGreaterThan(1);
      expect(categories).toContain("debugging");
      expect(categories).toContain("testing");
    });

    test("returns empty array for unrelated text", () => {
      const categories = detectCategories("hello world");
      expect(categories.length).toBe(0);
    });

    test("is case insensitive", () => {
      const categories = detectCategories("DEBUG ERROR TEST");
      expect(categories).toContain("debugging");
      expect(categories).toContain("testing");
    });

    test("returns max 3 categories", () => {
      const categories = detectCategories(
        "debug error test mock api endpoint performance cache security auth",
      );
      expect(categories.length).toBeLessThanOrEqual(3);
    });

    test("prioritizes categories by score", () => {
      // "bug error debug" should strongly match debugging
      const categories = detectCategories("bug error debug fix issue crash fault");
      expect(categories[0]).toBe("debugging");
    });
  });

  describe("getGapSearchQueries", () => {
    test("generates queries for critical gaps", () => {
      const pb = createEmptyPlaybook("test");
      const gaps = analyzePlaybookGaps(pb);
      const queries = getGapSearchQueries(gaps);

      expect(queries.length).toBeGreaterThan(0);
      expect(queries.length).toBeLessThanOrEqual(5);
    });

    test("uses keywords from categories", () => {
      const pb = createEmptyPlaybook("test");
      // Add rules to most categories except security
      for (const cat of RULE_CATEGORIES) {
        if (cat !== "security") {
          for (let i = 0; i < 5; i++) {
            pb.bullets.push(createTestBullet({ content: `Rule ${i}`, category: cat }));
          }
        }
      }
      const gaps = analyzePlaybookGaps(pb);
      const queries = getGapSearchQueries(gaps);

      // Security keywords should be in queries since it's critical
      expect(queries.some((q) => q.includes("security") || q.includes("auth"))).toBe(true);
    });

    test("returns empty array when no gaps", () => {
      const pb = createEmptyPlaybook("test");
      // Add 11 rules to each category (well-covered)
      for (const cat of RULE_CATEGORIES) {
        for (let i = 0; i < 11; i++) {
          pb.bullets.push(createTestBullet({ content: `Rule ${i}`, category: cat }));
        }
      }
      const gaps = analyzePlaybookGaps(pb);
      const queries = getGapSearchQueries(gaps);

      expect(queries.length).toBe(0);
    });
  });

  describe("scoreSessionForGaps", () => {
    test("scores 0 for unrelated content", () => {
      const pb = createEmptyPlaybook("test");
      const gaps = analyzePlaybookGaps(pb);
      const result = scoreSessionForGaps("hello world", gaps);

      expect(result.score).toBe(0);
      expect(result.matchedCategories.length).toBe(0);
    });

    test("scores higher for critical gaps", () => {
      const pb = createEmptyPlaybook("test");
      const gaps = analyzePlaybookGaps(pb);
      const result = scoreSessionForGaps("debugging the error and fixing the bug", gaps);

      expect(result.score).toBeGreaterThan(0);
      expect(result.matchedCategories).toContain("debugging");
      // Critical categories add 3 points each
      expect(result.score).toBe(3);
    });

    test("scores for underrepresented categories", () => {
      const pb = createEmptyPlaybook("test");
      // Add 1-2 rules to debugging (underrepresented)
      pb.bullets.push(createTestBullet({ content: "Debug rule", category: "debugging" }));

      const gaps = analyzePlaybookGaps(pb);
      const result = scoreSessionForGaps("debugging the error", gaps);

      // Underrepresented adds 2 points
      expect(result.score).toBe(2);
      expect(result.matchedCategories).toContain("debugging");
    });

    test("scores for adequate categories", () => {
      const pb = createEmptyPlaybook("test");
      // Add 3-10 rules to debugging (adequate)
      for (let i = 0; i < 5; i++) {
        pb.bullets.push(createTestBullet({ content: `Debug rule ${i}`, category: "debugging" }));
      }

      const gaps = analyzePlaybookGaps(pb);
      const result = scoreSessionForGaps("debugging the error", gaps);

      // Adequate adds 1 point
      expect(result.score).toBe(1);
      expect(result.matchedCategories).toContain("debugging");
    });

    test("provides meaningful reason", () => {
      const pb = createEmptyPlaybook("test");
      const gaps = analyzePlaybookGaps(pb);
      const result = scoreSessionForGaps("debugging the error", gaps);

      expect(result.reason).toContain("debugging");
      expect(result.reason).toContain("0 rules");
    });

    test("accumulates score from multiple categories", () => {
      const pb = createEmptyPlaybook("test");
      const gaps = analyzePlaybookGaps(pb);
      const result = scoreSessionForGaps("debug the test error and fix the security bug", gaps);

      // Multiple critical categories detected
      expect(result.score).toBeGreaterThanOrEqual(6); // At least 2 critical matches * 3
      expect(result.matchedCategories.length).toBeGreaterThanOrEqual(2);
    });
  });
});
