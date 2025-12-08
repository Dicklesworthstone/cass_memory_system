import { describe, test, expect } from "bun:test";
import {
  normalizePlatformPath,
  toForwardSlashes,
  toNativeSeparators,
  isAbsolutePath,
  joinPath,
  expandPath,
} from "../src/utils.js";
import path from "node:path";
import os from "node:os";

describe("Path Utilities", () => {
  describe("expandPath", () => {
    test("expands ~ to home directory", () => {
      const result = expandPath("~");
      expect(result).toBe(os.homedir());
    });

    test("expands ~/path to home + path", () => {
      const result = expandPath("~/docs");
      expect(result).toBe(path.join(os.homedir(), "docs"));
    });

    test("returns empty string for empty input", () => {
      expect(expandPath("")).toBe("");
    });

    test("returns path unchanged if no tilde", () => {
      expect(expandPath("/absolute/path")).toBe("/absolute/path");
      expect(expandPath("relative/path")).toBe("relative/path");
    });
  });

  describe("normalizePlatformPath", () => {
    test("returns empty string for empty input", () => {
      expect(normalizePlatformPath("")).toBe("");
    });

    test("expands tilde to home directory", () => {
      const result = normalizePlatformPath("~");
      expect(result).toBe(os.homedir());
    });

    test("expands ~/path correctly", () => {
      const result = normalizePlatformPath("~/docs");
      expect(result).toContain(os.homedir());
      expect(result).toContain("docs");
    });

    test("expands ~\\path correctly", () => {
      const result = normalizePlatformPath("~\\docs");
      expect(result).toContain(os.homedir());
    });

    test("resolves relative paths to absolute", () => {
      const result = normalizePlatformPath("./file.txt");
      expect(path.isAbsolute(result)).toBe(true);
    });

    test("resolves .. components", () => {
      const result = normalizePlatformPath("/foo/bar/../baz");
      // Should resolve to /foo/baz
      expect(result).not.toContain("..");
    });

    test("resolves . components", () => {
      const result = normalizePlatformPath("/foo/./bar");
      // path.normalize handles this
      expect(result).not.toMatch(/\/\.\//);
    });

    test("removes redundant separators", () => {
      const result = normalizePlatformPath("/foo//bar///baz");
      // Should not have multiple consecutive separators
      const separator = path.sep;
      const doubleSeq = `${separator}${separator}`;
      // After the first position (to handle potential leading // for UNC)
      expect(result.slice(2)).not.toContain(doubleSeq);
    });

    if (process.platform !== "win32") {
      test("converts backslashes to forward slashes on Unix", () => {
        const result = normalizePlatformPath("foo\\bar\\baz");
        expect(result).toContain("/");
        expect(result).not.toContain("\\");
      });
    }

    test("handles absolute paths", () => {
      const result = normalizePlatformPath("/absolute/path");
      expect(path.isAbsolute(result)).toBe(true);
    });

    test("handles Windows drive-letter paths", () => {
      const result = normalizePlatformPath("C:\\\\Users\\\\alice\\\\docs");
      expect(result).toContain("C:");
      // Should normalize separators for the host platform
      if (process.platform === "win32") {
        expect(result).toBe("C:\\Users\\alice\\docs");
      } else {
        expect(result).toBe("C:/Users/alice/docs");
        // Should not be resolved relative to the POSIX cwd
        expect(result.startsWith(process.cwd())).toBe(false);
      }
    });

    test("handles UNC paths", () => {
      const result = normalizePlatformPath("\\\\server\\share\\folder");
      if (process.platform === "win32") {
        expect(result.startsWith("\\\\server\\share")).toBe(true);
        expect(result).not.toMatch(/\\\\{3,}/);
      } else {
        expect(result.startsWith("//server/share")).toBe(true);
        expect(result).not.toMatch(/\/\/{3,}/);
      }
    });
  });

  describe("toForwardSlashes", () => {
    test("returns empty string for empty input", () => {
      expect(toForwardSlashes("")).toBe("");
    });

    test("converts backslashes to forward slashes", () => {
      expect(toForwardSlashes("C:\\Users\\name\\file")).toBe(
        "C:/Users/name/file"
      );
    });

    test("leaves forward slashes unchanged", () => {
      expect(toForwardSlashes("/home/user/file")).toBe("/home/user/file");
    });

    test("handles mixed separators", () => {
      expect(toForwardSlashes("path\\to/mixed\\file")).toBe(
        "path/to/mixed/file"
      );
    });
  });

  describe("toNativeSeparators", () => {
    test("returns empty string for empty input", () => {
      expect(toNativeSeparators("")).toBe("");
    });

    test("converts to platform separator", () => {
      const input = "path/to/file";
      const result = toNativeSeparators(input);

      if (process.platform === "win32") {
        expect(result).toBe("path\\to\\file");
      } else {
        expect(result).toBe("path/to/file");
      }
    });

    test("handles backslashes on Unix", () => {
      if (process.platform !== "win32") {
        expect(toNativeSeparators("path\\to\\file")).toBe("path/to/file");
      }
    });
  });

  describe("isAbsolutePath", () => {
    test("returns false for empty string", () => {
      expect(isAbsolutePath("")).toBe(false);
    });

    test("returns true for Unix absolute paths", () => {
      expect(isAbsolutePath("/")).toBe(true);
      expect(isAbsolutePath("/home/user")).toBe(true);
      expect(isAbsolutePath("/var/log/file.txt")).toBe(true);
    });

    test("returns true for Windows drive letters", () => {
      expect(isAbsolutePath("C:")).toBe(true);
      expect(isAbsolutePath("C:\\Users")).toBe(true);
      expect(isAbsolutePath("D:/Documents")).toBe(true);
      expect(isAbsolutePath("e:\\file.txt")).toBe(true);
    });

    test("returns true for UNC paths", () => {
      expect(isAbsolutePath("\\\\server\\share")).toBe(true);
      expect(isAbsolutePath("//server/share")).toBe(true);
      expect(isAbsolutePath("\\\\server\\share\\file")).toBe(true);
    });

    test("returns false for relative paths", () => {
      expect(isAbsolutePath("relative/path")).toBe(false);
      expect(isAbsolutePath("./current")).toBe(false);
      expect(isAbsolutePath("../parent")).toBe(false);
      expect(isAbsolutePath("file.txt")).toBe(false);
    });

    test("returns false for tilde paths (not expanded)", () => {
      expect(isAbsolutePath("~")).toBe(false);
      expect(isAbsolutePath("~/docs")).toBe(false);
    });
  });

  describe("joinPath", () => {
    test("returns empty string for no segments", () => {
      expect(joinPath()).toBe("");
    });

    test("joins simple segments", () => {
      const result = joinPath("foo", "bar", "baz");
      expect(result).toContain("foo");
      expect(result).toContain("bar");
      expect(result).toContain("baz");
    });

    test("expands tilde in first segment", () => {
      const result = joinPath("~", "docs");
      expect(result).toContain(os.homedir());
      expect(result).toContain("docs");
    });

    test("handles empty segments", () => {
      const result = joinPath("foo", "", "bar");
      expect(result).toBe(path.join("foo", "", "bar"));
    });

    test("resolves . and .. in segments", () => {
      const result = joinPath("foo", "bar", "..", "baz");
      expect(result).not.toContain("..");
    });
  });

  describe("edge cases", () => {
    test("normalizePlatformPath handles only dots", () => {
      const result = normalizePlatformPath(".");
      expect(path.isAbsolute(result)).toBe(true);
    });

    test("normalizePlatformPath handles double dots", () => {
      const result = normalizePlatformPath("..");
      expect(path.isAbsolute(result)).toBe(true);
    });

    test("isAbsolutePath handles single char strings", () => {
      expect(isAbsolutePath("a")).toBe(false);
      expect(isAbsolutePath("/")).toBe(true);
    });

    test("toForwardSlashes handles only backslashes", () => {
      expect(toForwardSlashes("\\\\\\")).toBe("///");
    });
  });
});
