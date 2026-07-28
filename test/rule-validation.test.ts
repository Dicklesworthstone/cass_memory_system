import { describe, test, expect } from "bun:test";
import {
  validateRule,
  formatValidationResult,
  hasWarnings,
  hasIssues,
  type ValidationResult,
} from "../src/rule-validation.js";
import { createEmptyPlaybook } from "../src/playbook.js";
import { configureOllamaEmbedding, setEmbeddingBackend } from "../src/semantic.js";
import { createTestBullet } from "./helpers/factories.js";

describe("rule-validation.ts", () => {
  describe("validateRule", () => {
    test("accepts valid rule with good quality", async () => {
      const pb = createEmptyPlaybook("test");
      const content = "When debugging async code, always check for unhandled promise rejections before investigating further.";

      const result = await validateRule(content, "debugging", pb, { skipSimilarity: true });

      expect(result.valid).toBe(true);
      // May have suggestions but no errors/warnings
      const issues = result.warnings.filter(w => w.severity === "error" || w.severity === "warning");
      expect(issues.length).toBe(0);
    });

    test("warns on too short rule", async () => {
      const pb = createEmptyPlaybook("test");
      const content = "Use tests.";

      const result = await validateRule(content, "testing", pb, { skipSimilarity: true });

      expect(result.warnings.some(w => w.type === "quality" && w.message.includes("too short"))).toBe(true);
    });

    test("suggests split for long rule", async () => {
      const pb = createEmptyPlaybook("test");
      const content = Array(120).fill("word").join(" "); // 120 words

      const result = await validateRule(content, "general", pb, { skipSimilarity: true });

      expect(result.warnings.some(w => w.type === "quality" && w.message.includes("long"))).toBe(true);
      expect(result.warnings.find(w => w.message.includes("long"))?.severity).toBe("suggestion");
    });

    test("suggests context when missing context words", async () => {
      const pb = createEmptyPlaybook("test");
      const content = "Run the test suite and check code coverage metrics regularly.";

      const result = await validateRule(content, "testing", pb, { skipSimilarity: true });

      expect(result.warnings.some(w => w.type === "quality" && w.message.includes("context"))).toBe(true);
    });

    test("warns on vague content", async () => {
      const pb = createEmptyPlaybook("test");
      const content = "Make things better and do stuff good. Use nice things to get better stuff.";

      const result = await validateRule(content, "general", pb, { skipSimilarity: true });

      expect(result.warnings.some(w => w.type === "quality" && w.message.includes("vague"))).toBe(true);
    });

    test("suggests category when none provided", async () => {
      const pb = createEmptyPlaybook("test");
      const content = "When writing unit tests, always mock external dependencies to ensure isolation.";

      const result = await validateRule(content, "", pb, { skipSimilarity: true });

      expect(result.suggestions.category).toBe("testing");
    });

    test("suggests different category when mismatch detected", async () => {
      const pb = createEmptyPlaybook("test");
      const content = "Always validate user input and sanitize data to prevent XSS attacks.";

      const result = await validateRule(content, "documentation", pb, { skipSimilarity: true });

      // Should suggest security instead of documentation
      expect(result.warnings.some(w => w.type === "category")).toBe(true);
      expect(result.suggestions.category).toBe("security");
    });

    test("respects custom word count thresholds", async () => {
      const pb = createEmptyPlaybook("test");
      const content = "Short rule here.";

      // With low minWords, should pass
      const result1 = await validateRule(content, "general", pb, {
        skipSimilarity: true,
        minWords: 3,
      });
      expect(result1.warnings.filter(w => w.message.includes("too short")).length).toBe(0);

      // With high minWords, should warn
      const result2 = await validateRule(content, "general", pb, {
        skipSimilarity: true,
        minWords: 20,
      });
      expect(result2.warnings.some(w => w.message.includes("too short"))).toBe(true);
    });

    test("similarity check finds duplicates", async () => {
      const pb = createEmptyPlaybook("test");
      const existingContent = "When debugging async code, always check for unhandled promise rejections.";
      pb.bullets.push(createTestBullet({
        content: existingContent,
        category: "debugging",
        embedding: [1, 0],
      }));

      // Very similar content
      const newContent = "When debugging asynchronous code, always check for unhandled promise rejections first.";
      const server = Bun.serve({
        port: 0,
        fetch: () => Response.json({ embeddings: [[1, 0]] }),
      });

      try {
        setEmbeddingBackend("ollama");
        configureOllamaEmbedding(`http://127.0.0.1:${server.port}`, "test-model");

        const result = await validateRule(newContent, "debugging", pb, {
          similarityThreshold: 0.7,
        });

        expect(result.warnings.some(w => w.type === "similarity")).toBe(true);
      } finally {
        setEmbeddingBackend("xenova");
        server.stop(true);
      }
    });

    test("similarity check can be skipped", async () => {
      const pb = createEmptyPlaybook("test");
      const existingContent = "When debugging async code, check for unhandled rejections.";
      pb.bullets.push(createTestBullet({ content: existingContent, category: "debugging" }));

      const newContent = "When debugging async code, check for unhandled rejections."; // Exact duplicate

      const result = await validateRule(newContent, "debugging", pb, {
        skipSimilarity: true,
      });

      // Should not have similarity warning when skipped
      expect(result.warnings.some(w => w.type === "similarity")).toBe(false);
    });
  });

  describe("formatValidationResult", () => {
    test("formats clean result", () => {
      const result: ValidationResult = {
        valid: true,
        warnings: [],
        suggestions: {},
      };

      const formatted = formatValidationResult(result);
      expect(formatted).toContain("No issues");
    });

    test("formats warnings with icons", () => {
      const result: ValidationResult = {
        valid: true,
        warnings: [
          { type: "quality", message: "Rule is too short", severity: "warning" },
          { type: "category", message: "Consider testing category", severity: "suggestion" },
        ],
        suggestions: { category: "testing" },
      };

      const formatted = formatValidationResult(result);
      expect(formatted).toContain("!");
      expect(formatted).toContain("?");
      expect(formatted).toContain("too short");
      expect(formatted).toContain("testing");
    });

    test("formats error with x icon", () => {
      const result: ValidationResult = {
        valid: false,
        warnings: [
          { type: "similarity", message: "Duplicate detected", severity: "error" },
        ],
        suggestions: {},
      };

      const formatted = formatValidationResult(result);
      expect(formatted).toContain("x");
      expect(formatted).toContain("Duplicate");
    });
  });

  describe("hasWarnings", () => {
    test("returns true when warnings exist", () => {
      const result: ValidationResult = {
        valid: true,
        warnings: [{ type: "quality", message: "test", severity: "suggestion" }],
        suggestions: {},
      };
      expect(hasWarnings(result)).toBe(true);
    });

    test("returns false when no warnings", () => {
      const result: ValidationResult = {
        valid: true,
        warnings: [],
        suggestions: {},
      };
      expect(hasWarnings(result)).toBe(false);
    });
  });

  describe("hasIssues", () => {
    test("returns true for errors", () => {
      const result: ValidationResult = {
        valid: false,
        warnings: [{ type: "similarity", message: "test", severity: "error" }],
        suggestions: {},
      };
      expect(hasIssues(result)).toBe(true);
    });

    test("returns true for warnings", () => {
      const result: ValidationResult = {
        valid: true,
        warnings: [{ type: "quality", message: "test", severity: "warning" }],
        suggestions: {},
      };
      expect(hasIssues(result)).toBe(true);
    });

    test("returns false for suggestions only", () => {
      const result: ValidationResult = {
        valid: true,
        warnings: [{ type: "category", message: "test", severity: "suggestion" }],
        suggestions: {},
      };
      expect(hasIssues(result)).toBe(false);
    });

    test("returns false when empty", () => {
      const result: ValidationResult = {
        valid: true,
        warnings: [],
        suggestions: {},
      };
      expect(hasIssues(result)).toBe(false);
    });
  });
});
