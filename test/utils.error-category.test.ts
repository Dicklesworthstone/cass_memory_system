import { describe, test, expect } from "bun:test";
import {
  categorizeError,
  ErrorCategory,
  ERROR_CATEGORY_EXIT_CODES,
  getErrorCategoryDescription,
  getErrorCategoryAction,
  shouldRetry,
  InputValidationError,
  PermissionError,
} from "../src/utils.js";

describe("Error Categorization", () => {
  describe("categorizeError", () => {
    describe("custom error types", () => {
      test("categorizes InputValidationError as user_input", () => {
        const error = new InputValidationError(
          "bulletId",
          "invalid",
          "format",
          "example"
        );
        expect(categorizeError(error)).toBe("user_input");
      });

      test("categorizes PermissionError as filesystem", () => {
        const error = new PermissionError(
          "/path",
          "read",
          "644",
          "chmod 644",
          "EACCES",
          "error"
        );
        expect(categorizeError(error)).toBe("filesystem");
      });
    });

    describe("error codes", () => {
      test("categorizes ENOENT as filesystem", () => {
        const error = new Error("File not found") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        expect(categorizeError(error)).toBe("filesystem");
      });

      test("categorizes EACCES as filesystem", () => {
        const error = new Error("Permission denied") as NodeJS.ErrnoException;
        error.code = "EACCES";
        expect(categorizeError(error)).toBe("filesystem");
      });

      test("categorizes EPERM as filesystem", () => {
        const error = new Error("Operation not permitted") as NodeJS.ErrnoException;
        error.code = "EPERM";
        expect(categorizeError(error)).toBe("filesystem");
      });

      test("categorizes ENOSPC as filesystem", () => {
        const error = new Error("No space left on device") as NodeJS.ErrnoException;
        error.code = "ENOSPC";
        expect(categorizeError(error)).toBe("filesystem");
      });

      test("categorizes ECONNREFUSED as network", () => {
        const error = new Error("Connection refused") as NodeJS.ErrnoException;
        error.code = "ECONNREFUSED";
        expect(categorizeError(error)).toBe("network");
      });

      test("categorizes ETIMEDOUT as network", () => {
        const error = new Error("Timed out") as NodeJS.ErrnoException;
        error.code = "ETIMEDOUT";
        expect(categorizeError(error)).toBe("network");
      });
    });

    describe("error names", () => {
      test("categorizes ZodError as configuration", () => {
        const error = new Error("Schema validation failed");
        error.name = "ZodError";
        expect(categorizeError(error)).toBe("configuration");
      });

      test("categorizes SyntaxError with JSON as configuration", () => {
        const error = new SyntaxError("Unexpected token in JSON");
        expect(categorizeError(error)).toBe("configuration");
      });

      test("categorizes TypeError as internal", () => {
        const error = new TypeError("Cannot read property of undefined");
        expect(categorizeError(error)).toBe("internal");
      });

      test("categorizes ReferenceError as internal", () => {
        const error = new ReferenceError("x is not defined");
        expect(categorizeError(error)).toBe("internal");
      });

      test("categorizes AbortError as user_input", () => {
        const error = new Error("Operation cancelled");
        error.name = "AbortError";
        expect(categorizeError(error)).toBe("user_input");
      });
    });

    describe("message patterns - LLM", () => {
      test("categorizes rate limit errors as llm", () => {
        expect(categorizeError(new Error("Rate limit exceeded"))).toBe("llm");
        expect(categorizeError(new Error("rate_limit_exceeded"))).toBe("llm");
      });

      test("categorizes API key errors as llm", () => {
        expect(categorizeError(new Error("Invalid API key"))).toBe("llm");
        expect(categorizeError(new Error("api_key missing"))).toBe("llm");
      });

      test("categorizes token limit errors as llm", () => {
        expect(categorizeError(new Error("Token limit exceeded"))).toBe("llm");
        expect(categorizeError(new Error("context_length_exceeded"))).toBe("llm");
      });

      test("categorizes provider name errors as llm", () => {
        expect(categorizeError(new Error("Anthropic API error"))).toBe("llm");
        expect(categorizeError(new Error("OpenAI request failed"))).toBe("llm");
        expect(categorizeError(new Error("Google AI error"))).toBe("llm");
      });

      test("categorizes model errors as llm", () => {
        expect(categorizeError(new Error("Model not found: gpt-5"))).toBe("llm");
        expect(categorizeError(new Error("Invalid model specified"))).toBe("llm");
      });
    });

    describe("message patterns - Cass", () => {
      test("categorizes cass not found as cass", () => {
        expect(categorizeError(new Error("cass not found"))).toBe("cass");
        expect(categorizeError(new Error("cass: command not found"))).toBe("cass");
      });

      test("categorizes cass index errors as cass", () => {
        expect(categorizeError(new Error("cass index corrupted"))).toBe("cass");
        expect(categorizeError(new Error("cass index missing"))).toBe("cass");
      });

      test("categorizes cass export errors as cass", () => {
        expect(categorizeError(new Error("cass export failed"))).toBe("cass");
      });
    });

    describe("message patterns - User Input", () => {
      test("categorizes invalid bullet errors as user_input", () => {
        expect(categorizeError(new Error("Invalid bullet ID"))).toBe("user_input");
      });

      test("categorizes validation failed as user_input", () => {
        expect(categorizeError(new Error("Validation failed for input"))).toBe("user_input");
      });

      test("categorizes missing argument as user_input", () => {
        expect(categorizeError(new Error("Missing argument: --path"))).toBe("user_input");
      });
    });

    describe("message patterns - Configuration", () => {
      test("categorizes config errors as configuration", () => {
        expect(categorizeError(new Error("Config invalid: missing field"))).toBe("configuration");
        expect(categorizeError(new Error("Invalid config detected"))).toBe("configuration");
      });

      test("categorizes YAML parse errors as configuration", () => {
        expect(categorizeError(new Error("YAML parse error at line 5"))).toBe("configuration");
      });

      test("categorizes JSON parse errors as configuration", () => {
        expect(categorizeError(new Error("JSON parse error"))).toBe("configuration");
      });
    });

    describe("message patterns - Network", () => {
      test("categorizes timeout as network", () => {
        expect(categorizeError(new Error("Request timeout"))).toBe("network");
      });

      test("categorizes connection refused as network", () => {
        expect(categorizeError(new Error("Connection refused by server"))).toBe("network");
      });

      test("categorizes fetch failed as network", () => {
        expect(categorizeError(new Error("fetch failed"))).toBe("network");
      });
    });

    describe("message patterns - Filesystem", () => {
      test("categorizes permission denied as filesystem", () => {
        expect(categorizeError(new Error("Permission denied"))).toBe("filesystem");
      });

      test("categorizes no such file as filesystem", () => {
        expect(categorizeError(new Error("No such file or directory"))).toBe("filesystem");
      });

      test("categorizes file not found as filesystem", () => {
        expect(categorizeError(new Error("File not found"))).toBe("filesystem");
      });

      test("categorizes disk full as filesystem", () => {
        expect(categorizeError(new Error("Disk full"))).toBe("filesystem");
      });
    });

    describe("edge cases", () => {
      test("returns internal for non-Error objects", () => {
        expect(categorizeError("string error")).toBe("internal");
        expect(categorizeError(42)).toBe("internal");
        expect(categorizeError(null)).toBe("internal");
        expect(categorizeError(undefined)).toBe("internal");
        expect(categorizeError({})).toBe("internal");
      });

      test("returns internal for generic errors", () => {
        expect(categorizeError(new Error("Something went wrong"))).toBe("internal");
      });

      test("returns internal for errors with empty message", () => {
        expect(categorizeError(new Error(""))).toBe("internal");
      });
    });
  });

  describe("ERROR_CATEGORY_EXIT_CODES", () => {
    test("has all categories mapped", () => {
      const categories: ErrorCategory[] = [
        "user_input",
        "configuration",
        "filesystem",
        "network",
        "cass",
        "llm",
        "internal",
      ];
      for (const category of categories) {
        expect(typeof ERROR_CATEGORY_EXIT_CODES[category]).toBe("number");
      }
    });

    test("uses UNIX convention for user_input (exit 2)", () => {
      expect(ERROR_CATEGORY_EXIT_CODES.user_input).toBe(2);
    });

    test("uses 1 for internal errors", () => {
      expect(ERROR_CATEGORY_EXIT_CODES.internal).toBe(1);
    });
  });

  describe("getErrorCategoryDescription", () => {
    test("returns descriptions for all categories", () => {
      expect(getErrorCategoryDescription("user_input")).toBe("Invalid input provided");
      expect(getErrorCategoryDescription("configuration")).toBe("Configuration error");
      expect(getErrorCategoryDescription("filesystem")).toBe("File system error");
      expect(getErrorCategoryDescription("network")).toBe("Network error");
      expect(getErrorCategoryDescription("cass")).toBe("Cass integration error");
      expect(getErrorCategoryDescription("llm")).toBe("LLM provider error");
      expect(getErrorCategoryDescription("internal")).toBe("Internal error");
    });
  });

  describe("getErrorCategoryAction", () => {
    test("returns actions for all categories", () => {
      expect(getErrorCategoryAction("user_input")).toContain("Check the command arguments");
      expect(getErrorCategoryAction("configuration")).toContain("config files");
      expect(getErrorCategoryAction("filesystem")).toContain("permissions");
      expect(getErrorCategoryAction("network")).toContain("internet connection");
      expect(getErrorCategoryAction("cass")).toContain("cargo install coding-agent-search");
      expect(getErrorCategoryAction("llm")).toContain("API key");
      expect(getErrorCategoryAction("internal")).toContain("bug");
    });
  });

  describe("shouldRetry", () => {
    test("returns true for network errors", () => {
      expect(shouldRetry("network")).toBe(true);
    });

    test("returns true for llm errors", () => {
      expect(shouldRetry("llm")).toBe(true);
    });

    test("returns false for other categories", () => {
      expect(shouldRetry("user_input")).toBe(false);
      expect(shouldRetry("configuration")).toBe(false);
      expect(shouldRetry("filesystem")).toBe(false);
      expect(shouldRetry("cass")).toBe(false);
      expect(shouldRetry("internal")).toBe(false);
    });
  });
});
