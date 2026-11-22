import { describe, expect, test } from "bun:test";
import { createEmptyPlaybook } from "../src/playbook.js";
import {
  formatValidationResult,
  hasIssues,
  hasWarnings,
  type ValidationResult,
  validateRule,
} from "../src/rule-validation.js";
import { configureOllamaEmbedding, setEmbeddingBackend } from "../src/semantic.js";
import { createTestBullet } from "./helpers/factories.js";

describe("rule-validation.ts", () => {
  describe("validateRule", () => {
    test("accepts valid rule with good quality", async () => {
      const pb = createEmptyPlaybook("test");
      const content =
        "When debugging async code, always check for unhandled promise rejections before investigating further.";

      const result = await validateRule(content, "debugging", pb, { skipSimilarity: true });

      expect(result.valid).toBe(true);
      // May have suggestions but no errors/warnings
      const issues = result.warnings.filter(
        (w) => w.severity === "error" || w.severity === "warning",
      );
      expect(issues.length).toBe(0);
    });

    test("warns on too short rule", async () => {
      const pb = createEmptyPlaybook("test");
      const content = "Use tests.";

      const result = await validateRule(content, "testing", pb, { skipSimilarity: true });

      expect(
        result.warnings.some((w) => w.type === "quality" && w.message.includes("too short")),
      ).toBe(true);
    });

    test("suggests split for long rule", async () => {
      const pb = createEmptyPlaybook("test");
      const content = Array(120).fill("word").join(" "); // 120 words

      const result = await validateRule(content, "general", pb, { skipSimilarity: true });

      expect(result.warnings.some((w) => w.type === "quality" && w.message.includes("long"))).toBe(
        true,
      );
      expect(result.warnings.find((w) => w.message.includes("long"))?.severity).toBe("suggestion");
    });

    test("suggests context when missing context words", async () => {
      const pb = createEmptyPlaybook("test");
      const content = "Run the test suite and check code coverage metrics regularly.";

      const result = await validateRule(content, "testing", pb, { skipSimilarity: true });

      expect(
        result.warnings.some((w) => w.type === "quality" && w.message.includes("context")),
      ).toBe(true);
    });

    test("warns on vague content", async () => {
      const pb = createEmptyPlaybook("test");
      const content = "Make things better and do stuff good. Use nice things to get better stuff.";

      const result = await validateRule(content, "general", pb, { skipSimilarity: true });

      expect(result.warnings.some((w) => w.type === "quality" && w.message.includes("vague"))).toBe(
        true,
      );
    });

    test("suggests category when none provided", async () => {
      const pb = createEmptyPlaybook("test");
      const content =
        "When writing unit tests, always mock external dependencies to ensure isolation.";

      const result = await validateRule(content, "", pb, { skipSimilarity: true });

      expect(result.suggestions.category).toBe("testing");
    });

    test("suggests different category when mismatch detected", async () => {
      const pb = createEmptyPlaybook("test");
      const content = "Always validate user input and sanitize data to prevent XSS attacks.";

      const result = await validateRule(content, "documentation", pb, { skipSimilarity: true });

      // Should suggest security instead of documentation
      expect(result.warnings.some((w) => w.type === "category")).toBe(true);
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
      expect(result1.warnings.filter((w) => w.message.includes("too short")).length).toBe(0);

      // With high minWords, should warn
      const result2 = await validateRule(content, "general", pb, {
        skipSimilarity: true,
        minWords: 20,
      });
      expect(result2.warnings.some((w) => w.message.includes("too short"))).toBe(true);
    });

    test("similarity check finds duplicates", async () => {
      const pb = createEmptyPlaybook("test");
      const existingContent =
        "When debugging async code, always check for unhandled promise rejections.";
      pb.bullets.push(
        createTestBullet({
          content: existingContent,
          category: "debugging",
          embedding: [1, 0],
        }),
      );

      // Very similar content
      const newContent =
        "When debugging asynchronous code, always check for unhandled promise rejections first.";
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

        expect(result.warnings.some((w) => w.type === "similarity")).toBe(true);
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
      expect(result.warnings.some((w) => w.type === "similarity")).toBe(false);
    });

    test("similarity validation uses its project configuration after another project changes the runtime", async () => {
      const existingContent = "When applying migrations, always verify database constraints before committing schema changes.";
      const content = "Before committing a schema migration, always verify that database constraints still hold.";
      const pb = createEmptyPlaybook("project-specific-validation");
      pb.bullets.push(createTestBullet({ id: "b-project-database", content: existingContent, category: "database" }));
      const requests: Array<{ model: string; input: string | string[] }> = [];
      let unrelatedRequests = 0;
      const expected = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const body = await request.json() as { model: string; input: string | string[] };
          requests.push(body);
          const count = Array.isArray(body.input) ? body.input.length : 1;
          return Response.json({ embeddings: Array.from({ length: count }, () => [1, 0]) });
        },
      });
      const unrelated = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch() {
          unrelatedRequests++;
          return new Response("Wrong project embedding server", { status: 503 });
        },
      });

      try {
        setEmbeddingBackend("ollama");
        configureOllamaEmbedding(`http://127.0.0.1:${unrelated.port}`, "unrelated-project");
        const result = await validateRule(content, "database", pb, {
          config: {
            embeddingBackend: "ollama",
            embeddingModel: "database-project-model",
            ollamaBaseUrl: `http://127.0.0.1:${expected.port}`,
          },
        });

        expect(unrelatedRequests).toBe(0);
        expect(requests.every(request => request.model === "database-project-model")).toBe(true);
        expect(requests.flatMap(request => Array.isArray(request.input) ? request.input : [request.input]))
          .toEqual([content, existingContent]);
        expect(result.warnings.find(warning => warning.type === "similarity")?.details).toEqual({
          similarRuleId: "b-project-database",
          similarityScore: 1,
        });
      } finally {
        setEmbeddingBackend("xenova");
        expected.stop(true);
        unrelated.stop(true);
      }
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
        warnings: [{ type: "similarity", message: "Duplicate detected", severity: "error" }],
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
