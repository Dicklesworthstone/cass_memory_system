import { describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { type InputType, InputValidationError, validateAndSanitizeInput } from "../src/utils.js";

describe("validateAndSanitizeInput", () => {
  describe("bulletId validation", () => {
    test("accepts valid bullet IDs", () => {
      expect(validateAndSanitizeInput("bulletId", "b-m4k8z2x-abc123")).toBe("b-m4k8z2x-abc123");
      expect(validateAndSanitizeInput("bulletId", "b-1-a")).toBe("b-1-a");
      expect(validateAndSanitizeInput("bulletId", "b-abc123def456-xyz789")).toBe(
        "b-abc123def456-xyz789",
      );
    });

    test("trims whitespace from bullet IDs", () => {
      expect(validateAndSanitizeInput("bulletId", "  b-m4k8z2x-abc123  ")).toBe("b-m4k8z2x-abc123");
    });

    test("rejects invalid bullet ID formats", () => {
      // Missing prefix
      expect(() => validateAndSanitizeInput("bulletId", "m4k8z2x-abc123")).toThrow(
        InputValidationError,
      );

      // Wrong prefix
      expect(() => validateAndSanitizeInput("bulletId", "x-m4k8z2x-abc123")).toThrow(
        InputValidationError,
      );

      // Missing hyphen separator
      expect(() => validateAndSanitizeInput("bulletId", "b-abc123")).toThrow(InputValidationError);

      // Uppercase (our pattern is lowercase)
      expect(() => validateAndSanitizeInput("bulletId", "b-ABC-XYZ")).toThrow(InputValidationError);

      // Special characters
      expect(() => validateAndSanitizeInput("bulletId", "b-abc@123-xyz")).toThrow(
        InputValidationError,
      );
    });

    test("rejects empty bullet IDs", () => {
      expect(() => validateAndSanitizeInput("bulletId", "")).toThrow(InputValidationError);
      expect(() => validateAndSanitizeInput("bulletId", "   ")).toThrow(InputValidationError);
    });

    test("removes control characters", () => {
      // Tab and newline should be stripped
      expect(validateAndSanitizeInput("bulletId", "b-m4k8z2x-abc123\t")).toBe("b-m4k8z2x-abc123");
    });

    test("throws error with helpful message for invalid bullet ID", () => {
      try {
        validateAndSanitizeInput("bulletId", "invalid-id");
        throw new Error("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(InputValidationError);
        const err = e as InputValidationError;
        expect(err.inputType).toBe("bulletId");
        expect(err.invalidValue).toBe("invalid-id");
        expect(err.expectedFormat).toContain("b-{");
        expect(err.example).toBe("b-m4k8z2x-abc123");
        expect(err.message).toContain("Invalid bulletId");
        expect(err.message).toContain("Expected:");
        expect(err.message).toContain("Example:");
      }
    });
  });

  describe("sessionPath validation", () => {
    test("accepts valid file paths", () => {
      const result = validateAndSanitizeInput("sessionPath", "/tmp/session.jsonl");
      expect(result).toBe("/tmp/session.jsonl");
    });

    test("expands ~ to home directory", () => {
      const result = validateAndSanitizeInput("sessionPath", "~/sessions/test.jsonl");
      expect(result).toBe(path.join(os.homedir(), "sessions/test.jsonl"));
    });

    test("resolves relative paths to absolute", () => {
      const result = validateAndSanitizeInput("sessionPath", "./test.jsonl");
      expect(path.isAbsolute(result)).toBe(true);
      expect(result).toContain("test.jsonl");
    });

    test("accepts various valid extensions", () => {
      expect(validateAndSanitizeInput("sessionPath", "/tmp/s.jsonl")).toContain("s.jsonl");
      expect(validateAndSanitizeInput("sessionPath", "/tmp/s.json")).toContain("s.json");
      expect(validateAndSanitizeInput("sessionPath", "/tmp/s.md")).toContain("s.md");
      expect(validateAndSanitizeInput("sessionPath", "/tmp/s.txt")).toContain("s.txt");
      expect(validateAndSanitizeInput("sessionPath", "/tmp/s.log")).toContain("s.log");
    });

    test("accepts paths without extension", () => {
      const result = validateAndSanitizeInput("sessionPath", "/tmp/session_file");
      expect(result).toBe("/tmp/session_file");
    });

    test("rejects unexpected file extensions", () => {
      expect(() => validateAndSanitizeInput("sessionPath", "/tmp/session.exe")).toThrow(
        InputValidationError,
      );
      expect(() => validateAndSanitizeInput("sessionPath", "/tmp/session.sh")).toThrow(
        InputValidationError,
      );
      expect(() => validateAndSanitizeInput("sessionPath", "/tmp/session.py")).toThrow(
        InputValidationError,
      );
    });

    test("rejects empty paths", () => {
      expect(() => validateAndSanitizeInput("sessionPath", "")).toThrow(InputValidationError);
    });

    test("rejects excessively long paths", () => {
      const longPath = "/tmp/" + "a".repeat(2000) + ".jsonl";
      expect(() => validateAndSanitizeInput("sessionPath", longPath)).toThrow(InputValidationError);
    });

    test("trims whitespace from paths", () => {
      const result = validateAndSanitizeInput("sessionPath", "  /tmp/test.jsonl  ");
      expect(result).toBe("/tmp/test.jsonl");
    });

    test("throws error with helpful message for invalid path", () => {
      try {
        validateAndSanitizeInput("sessionPath", "");
        throw new Error("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(InputValidationError);
        const err = e as InputValidationError;
        expect(err.inputType).toBe("sessionPath");
        expect(err.message).toContain("path is empty");
      }
    });
  });

  describe("task validation", () => {
    test("accepts valid task descriptions", () => {
      expect(validateAndSanitizeInput("task", "Fix authentication timeout bug")).toBe(
        "Fix authentication timeout bug",
      );
    });

    test("trims whitespace", () => {
      expect(validateAndSanitizeInput("task", "  Fix authentication timeout  ")).toBe(
        "Fix authentication timeout",
      );
    });

    test("preserves newlines and tabs in tasks", () => {
      expect(validateAndSanitizeInput("task", "Task\nWith\nNewlines")).toBe("Task\nWith\nNewlines");
      expect(validateAndSanitizeInput("task", "Task\tWith\tTabs")).toBe("Task\tWith\tTabs");
    });

    test("removes control characters except newlines/tabs", () => {
      const withNullByte = "Fix bug\x00here";
      const result = validateAndSanitizeInput("task", withNullByte);
      expect(result).not.toContain("\x00");
      expect(result).toBe("Fix bughere");
    });

    test("accepts task up to max length", () => {
      const task = "a".repeat(500);
      expect(validateAndSanitizeInput("task", task)).toBe(task);
    });

    test("rejects empty tasks", () => {
      expect(() => validateAndSanitizeInput("task", "")).toThrow(InputValidationError);
      expect(() => validateAndSanitizeInput("task", "   ")).toThrow(InputValidationError);
    });

    test("rejects tasks exceeding max length", () => {
      const longTask = "a".repeat(501);
      expect(() => validateAndSanitizeInput("task", longTask)).toThrow(InputValidationError);
    });

    test("handles unicode characters", () => {
      expect(validateAndSanitizeInput("task", "Fix bug with émojis 🐛")).toBe(
        "Fix bug with émojis 🐛",
      );
    });

    test("normalizes unicode (NFC)", () => {
      // e + combining acute accent (NFD) should normalize to é (NFC)
      const nfdString = "cafe\u0301"; // cafe + combining acute = café
      const result = validateAndSanitizeInput("task", nfdString);
      expect(result).toBe("café");
    });

    test("throws error with helpful message for invalid task", () => {
      try {
        validateAndSanitizeInput("task", "");
        throw new Error("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(InputValidationError);
        const err = e as InputValidationError;
        expect(err.inputType).toBe("task");
        expect(err.message).toContain("task is empty");
        expect(err.example).toBe("Fix authentication timeout bug");
      }
    });
  });

  describe("category validation", () => {
    test("accepts valid category names", () => {
      expect(validateAndSanitizeInput("category", "testing")).toBe("testing");
      expect(validateAndSanitizeInput("category", "error-handling")).toBe("error-handling");
      expect(validateAndSanitizeInput("category", "api_integration")).toBe("api_integration");
      expect(validateAndSanitizeInput("category", "auth2")).toBe("auth2");
    });

    test("converts to lowercase", () => {
      expect(validateAndSanitizeInput("category", "Error-Handling")).toBe("error-handling");
      expect(validateAndSanitizeInput("category", "TESTING")).toBe("testing");
      expect(validateAndSanitizeInput("category", "API")).toBe("api");
    });

    test("trims whitespace", () => {
      expect(validateAndSanitizeInput("category", "  testing  ")).toBe("testing");
    });

    test("rejects categories starting with non-alphanumeric", () => {
      expect(() => validateAndSanitizeInput("category", "-testing")).toThrow(InputValidationError);
      expect(() => validateAndSanitizeInput("category", "_testing")).toThrow(InputValidationError);
      expect(() => validateAndSanitizeInput("category", "123abc")).not.toThrow();
    });

    test("rejects categories with invalid characters", () => {
      expect(() => validateAndSanitizeInput("category", "test@ing")).toThrow(InputValidationError);
      expect(() => validateAndSanitizeInput("category", "test.ing")).toThrow(InputValidationError);
      expect(() => validateAndSanitizeInput("category", "test ing")).toThrow(InputValidationError);
      expect(() => validateAndSanitizeInput("category", "test/ing")).toThrow(InputValidationError);
    });

    test("rejects empty categories", () => {
      expect(() => validateAndSanitizeInput("category", "")).toThrow(InputValidationError);
    });

    test("rejects categories exceeding max length", () => {
      const longCategory = "a".repeat(51);
      expect(() => validateAndSanitizeInput("category", longCategory)).toThrow(
        InputValidationError,
      );
    });

    test("accepts category at max length", () => {
      const maxCategory = "a".repeat(50);
      expect(validateAndSanitizeInput("category", maxCategory)).toBe(maxCategory);
    });

    test("throws error with helpful message for invalid category", () => {
      try {
        validateAndSanitizeInput("category", "@invalid");
        throw new Error("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(InputValidationError);
        const err = e as InputValidationError;
        expect(err.inputType).toBe("category");
        expect(err.message).toContain("invalid characters");
        expect(err.example).toBe("error-handling");
      }
    });
  });

  describe("null/undefined handling", () => {
    test("throws for null input", () => {
      expect(() => validateAndSanitizeInput("bulletId", null as unknown as string)).toThrow(
        InputValidationError,
      );
    });

    test("throws for undefined input", () => {
      expect(() => validateAndSanitizeInput("task", undefined as unknown as string)).toThrow(
        InputValidationError,
      );
    });

    test("error message indicates null/undefined", () => {
      try {
        validateAndSanitizeInput("category", null as unknown as string);
        throw new Error("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(InputValidationError);
        const err = e as InputValidationError;
        expect(err.message).toContain("null or undefined");
      }
    });
  });

  describe("InputValidationError", () => {
    test("has correct properties", () => {
      const err = new InputValidationError(
        "bulletId",
        "bad-id",
        "format: b-{...}",
        "b-m4k8z2x-abc123",
        "custom reason",
      );

      expect(err.name).toBe("InputValidationError");
      expect(err.inputType).toBe("bulletId");
      expect(err.invalidValue).toBe("bad-id");
      expect(err.expectedFormat).toBe("format: b-{...}");
      expect(err.example).toBe("b-m4k8z2x-abc123");
      expect(err.message).toContain("Invalid bulletId");
      expect(err.message).toContain("custom reason");
    });

    test("truncates long invalid values in error message", () => {
      const longValue = "a".repeat(100);
      const err = new InputValidationError("task", longValue, "short value", "example", "too long");

      // The message should truncate the value
      expect(err.message).toContain("...");
      expect(err.message).toContain("100 chars");
    });

    test("is instanceof Error", () => {
      const err = new InputValidationError("task", "value", "format", "example");
      expect(err instanceof Error).toBe(true);
      expect(err instanceof InputValidationError).toBe(true);
    });
  });

  describe("edge cases", () => {
    test("handles empty string after trimming", () => {
      expect(() => validateAndSanitizeInput("task", "   ")).toThrow(InputValidationError);
    });

    test("handles only control characters", () => {
      expect(() => validateAndSanitizeInput("task", "\x00\x01\x02")).toThrow(InputValidationError);
    });

    test("handles mixed valid and control characters", () => {
      const result = validateAndSanitizeInput("task", "Valid\x00Task\x01Here");
      expect(result).toBe("ValidTaskHere");
    });
  });
});
