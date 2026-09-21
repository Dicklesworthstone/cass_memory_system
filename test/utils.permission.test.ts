import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  handlePermissionError,
  handlePermissionErrorSync,
  isPermissionError,
  PermissionError,
} from "../src/utils.js";

describe("Permission Error Handling", () => {
  describe("isPermissionError", () => {
    test("returns true for EACCES errors", () => {
      const error = new Error("Permission denied") as NodeJS.ErrnoException;
      error.code = "EACCES";
      expect(isPermissionError(error)).toBe(true);
    });

    test("returns true for EPERM errors", () => {
      const error = new Error("Operation not permitted") as NodeJS.ErrnoException;
      error.code = "EPERM";
      expect(isPermissionError(error)).toBe(true);
    });

    test("returns false for ENOENT errors", () => {
      const error = new Error("File not found") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      expect(isPermissionError(error)).toBe(false);
    });

    test("returns false for non-Error objects", () => {
      expect(isPermissionError("not an error")).toBe(false);
      expect(isPermissionError(null)).toBe(false);
      expect(isPermissionError(undefined)).toBe(false);
      expect(isPermissionError(42)).toBe(false);
      expect(isPermissionError({})).toBe(false);
    });

    test("returns false for errors without code", () => {
      expect(isPermissionError(new Error("generic error"))).toBe(false);
    });
  });

  describe("PermissionError class", () => {
    test("has correct properties", () => {
      const err = new PermissionError(
        "/path/to/file",
        "read",
        "644",
        "chmod 644 '/path/to/file'",
        "EACCES",
        "permission denied",
      );

      expect(err.name).toBe("PermissionError");
      expect(err.path).toBe("/path/to/file");
      expect(err.operation).toBe("read");
      expect(err.currentPermissions).toBe("644");
      expect(err.suggestedFix).toBe("chmod 644 '/path/to/file'");
      expect(err.errorCode).toBe("EACCES");
    });

    test("generates helpful error message", () => {
      const err = new PermissionError(
        "/secret/file.txt",
        "read",
        "600 (owner: uid:0)",
        "chmod 644 '/secret/file.txt'",
        "EACCES",
        "EACCES: permission denied, open '/secret/file.txt'",
      );

      expect(err.message).toContain("Permission denied");
      expect(err.message).toContain("Cannot read");
      expect(err.message).toContain("/secret/file.txt");
      expect(err.message).toContain("600 (owner: uid:0)");
      expect(err.message).toContain("To fix:");
      expect(err.message).toContain("chmod 644");
    });

    test("handles missing permissions in message", () => {
      const err = new PermissionError(
        "/unknown/path",
        "write",
        undefined,
        "chmod 644 '/unknown/path'",
        "EACCES",
        "permission denied",
      );

      expect(err.message).toContain("Cannot write");
      expect(err.message).not.toContain("(current:");
    });

    test("is instanceof Error", () => {
      const err = new PermissionError("/path", "read", "644", "chmod 644", "EACCES", "error");
      expect(err instanceof Error).toBe(true);
      expect(err instanceof PermissionError).toBe(true);
    });
  });

  describe("handlePermissionError (async)", () => {
    test("throws PermissionError for EACCES", async () => {
      const originalError = new Error(
        "EACCES: permission denied, open '/test/file.txt'",
      ) as NodeJS.ErrnoException;
      originalError.code = "EACCES";

      await expect(handlePermissionError(originalError, "/test/file.txt")).rejects.toThrow(
        PermissionError,
      );
    });

    test("includes path in thrown error", async () => {
      const originalError = new Error("permission denied") as NodeJS.ErrnoException;
      originalError.code = "EACCES";

      try {
        await handlePermissionError(originalError, "/my/custom/path.json");
        throw new Error("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(PermissionError);
        expect((e as PermissionError).path).toBe("/my/custom/path.json");
      }
    });

    test("detects write operation from mkdir error", async () => {
      const originalError = new Error(
        "EACCES: permission denied, mkdir '/protected/dir'",
      ) as NodeJS.ErrnoException;
      originalError.code = "EACCES";

      try {
        await handlePermissionError(originalError, "/protected/dir");
        throw new Error("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(PermissionError);
        expect((e as PermissionError).operation).toBe("write");
      }
    });

    test("detects delete operation from unlink error", async () => {
      const originalError = new Error(
        "EPERM: operation not permitted, unlink '/system/file'",
      ) as NodeJS.ErrnoException;
      originalError.code = "EPERM";

      try {
        await handlePermissionError(originalError, "/system/file");
        throw new Error("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(PermissionError);
        expect((e as PermissionError).operation).toBe("delete");
      }
    });

    test("includes suggested fix in error", async () => {
      const originalError = new Error("permission denied") as NodeJS.ErrnoException;
      originalError.code = "EACCES";

      try {
        await handlePermissionError(originalError, "/path/to/file.txt");
        throw new Error("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(PermissionError);
        const permErr = e as PermissionError;
        expect(permErr.suggestedFix).toContain("chmod");
        expect(permErr.suggestedFix).toContain("/path/to/file.txt");
      }
    });

    test("escapes single quotes in path for fix command", async () => {
      const originalError = new Error("permission denied") as NodeJS.ErrnoException;
      originalError.code = "EACCES";

      try {
        await handlePermissionError(originalError, "/path/with'quote/file.txt");
        throw new Error("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(PermissionError);
        const permErr = e as PermissionError;
        // Single quote should be escaped
        expect(permErr.suggestedFix).toContain("'\\''");
      }
    });

    test("tries to get permissions from real file", async () => {
      // Create a temp file we can read
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "perm-test-"));
      const tmpFile = path.join(tmpDir, "test.txt");
      await fs.writeFile(tmpFile, "test content");

      const originalError = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
      originalError.code = "EACCES";

      try {
        await handlePermissionError(originalError, tmpFile);
        throw new Error("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(PermissionError);
        const permErr = e as PermissionError;
        // Should have gotten permissions from the actual file
        expect(permErr.currentPermissions).toBeDefined();
        expect(permErr.currentPermissions).toMatch(/\d{3}/); // e.g., "644"
      } finally {
        // Cleanup
        await fs.rm(tmpDir, { recursive: true });
      }
    });
  });

  describe("handlePermissionErrorSync", () => {
    test("throws PermissionError", () => {
      const originalError = new Error("permission denied") as NodeJS.ErrnoException;
      originalError.code = "EACCES";

      expect(() => handlePermissionErrorSync(originalError, "/test/file.txt")).toThrow(
        PermissionError,
      );
    });

    test("includes path in thrown error", () => {
      const originalError = new Error("permission denied") as NodeJS.ErrnoException;
      originalError.code = "EACCES";

      try {
        handlePermissionErrorSync(originalError, "/sync/path.json");
        throw new Error("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(PermissionError);
        expect((e as PermissionError).path).toBe("/sync/path.json");
      }
    });

    test("does not include permissions (cannot stat synchronously)", () => {
      const originalError = new Error("permission denied") as NodeJS.ErrnoException;
      originalError.code = "EACCES";

      try {
        handlePermissionErrorSync(originalError, "/test/file.txt");
        throw new Error("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(PermissionError);
        expect((e as PermissionError).currentPermissions).toBeUndefined();
      }
    });

    test("generates suggested fix", () => {
      const originalError = new Error("permission denied") as NodeJS.ErrnoException;
      originalError.code = "EPERM";

      try {
        handlePermissionErrorSync(originalError, "/test/file.txt");
        throw new Error("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(PermissionError);
        const permErr = e as PermissionError;
        expect(permErr.suggestedFix).toContain("chmod");
      }
    });

    test("treats paths ending with / as directories", () => {
      const originalError = new Error("EACCES: mkdir failed") as NodeJS.ErrnoException;
      originalError.code = "EACCES";

      try {
        handlePermissionErrorSync(originalError, "/test/directory/");
        throw new Error("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(PermissionError);
        const permErr = e as PermissionError;
        expect(permErr.suggestedFix).toContain("755"); // Directory permissions
      }
    });
  });

  describe("operation detection", () => {
    const testCases: Array<{
      message: string;
      expectedOp: "read" | "write" | "execute" | "delete" | "unknown";
    }> = [
      { message: "EACCES: open for reading failed", expectedOp: "read" },
      { message: "cannot write to file", expectedOp: "write" },
      { message: "mkdir failed", expectedOp: "write" },
      { message: "rename operation failed", expectedOp: "write" },
      { message: "unlink failed", expectedOp: "delete" },
      { message: "rmdir failed", expectedOp: "delete" },
      { message: "exec permission denied", expectedOp: "execute" },
      { message: "spawn failed", expectedOp: "execute" },
      { message: "some generic error", expectedOp: "unknown" },
    ];

    for (const { message, expectedOp } of testCases) {
      test(`detects ${expectedOp} from "${message}"`, () => {
        const originalError = new Error(message) as NodeJS.ErrnoException;
        originalError.code = "EACCES";

        try {
          handlePermissionErrorSync(originalError, "/test/path");
          throw new Error("Should have thrown");
        } catch (e) {
          expect(e).toBeInstanceOf(PermissionError);
          expect((e as PermissionError).operation).toBe(expectedOp);
        }
      });
    }
  });
});
