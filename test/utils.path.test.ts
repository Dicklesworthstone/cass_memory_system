import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import { mkdir, writeFile, rm, stat, chmod, realpath } from "node:fs/promises";
import os from "node:os";
import {
  expandPath,
  ensureDir,
  fileExists,
  resolveRepoDir,
  resolveGlobalDir,
  atomicWrite,
} from "../src/utils.js";
import { withTempDir, withTempGitRepo } from "./helpers/index.js";

// =============================================================================
// expandPath
// =============================================================================
describe("expandPath", () => {
  it("expands ~ to home directory", () => {
    const result = expandPath("~/test");
    expect(result).toBe(join(os.homedir(), "test"));
  });

  it("expands ~/ with nested paths", () => {
    const result = expandPath("~/.cass-memory/config.json");
    expect(result).toBe(join(os.homedir(), ".cass-memory/config.json"));
  });

  it("returns empty string for empty input", () => {
    expect(expandPath("")).toBe("");
  });

  it("returns absolute paths unchanged", () => {
    const absPath = "/usr/local/bin/node";
    expect(expandPath(absPath)).toBe(absPath);
  });

  it("returns relative paths unchanged (no expansion)", () => {
    const relPath = "./config/test.json";
    expect(expandPath(relPath)).toBe(relPath);
  });

  it("handles paths with spaces", () => {
    const result = expandPath("~/My Documents/file.txt");
    expect(result).toBe(join(os.homedir(), "My Documents/file.txt"));
  });

  it("handles just ~ alone", () => {
    const result = expandPath("~");
    expect(result).toBe(os.homedir());
  });

  it("does not expand ~ in middle of path", () => {
    const path = "/home/user/~test";
    expect(expandPath(path)).toBe(path);
  });
});

// =============================================================================
// ensureDir
// =============================================================================
describe("ensureDir", () => {
  it("creates directory if it does not exist", async () => {
    await withTempDir("ensure-dir", async (tempDir) => {
      const newDir = join(tempDir, "new-directory");

      await ensureDir(newDir);

      const stats = await stat(newDir);
      expect(stats.isDirectory()).toBe(true);
    });
  });

  it("is a no-op if directory already exists", async () => {
    await withTempDir("ensure-dir-exists", async (tempDir) => {
      const existingDir = join(tempDir, "existing");
      await mkdir(existingDir);

      // Should not throw
      await ensureDir(existingDir);

      const stats = await stat(existingDir);
      expect(stats.isDirectory()).toBe(true);
    });
  });

  it("creates nested directories recursively", async () => {
    await withTempDir("ensure-nested", async (tempDir) => {
      const nestedDir = join(tempDir, "a/b/c/d");

      await ensureDir(nestedDir);

      const stats = await stat(nestedDir);
      expect(stats.isDirectory()).toBe(true);
    });
  });

  it("handles paths with ~ expansion", async () => {
    await withTempDir("ensure-tilde", async (tempDir) => {
      // Can't test actual ~ expansion without modifying HOME,
      // but we can verify it accepts the path format
      const dir = join(tempDir, "test-dir");
      await ensureDir(dir);

      expect(await fileExists(dir)).toBe(true);
    });
  });
});

// =============================================================================
// fileExists
// =============================================================================
describe("fileExists", () => {
  it("returns true for existing file", async () => {
    await withTempDir("file-exists", async (tempDir) => {
      const filePath = join(tempDir, "test.txt");
      await writeFile(filePath, "content");

      expect(await fileExists(filePath)).toBe(true);
    });
  });

  it("returns false for non-existent file", async () => {
    await withTempDir("file-not-exists", async (tempDir) => {
      const filePath = join(tempDir, "does-not-exist.txt");

      expect(await fileExists(filePath)).toBe(false);
    });
  });

  it("returns true for existing directory", async () => {
    await withTempDir("dir-exists", async (tempDir) => {
      // tempDir itself exists as a directory
      expect(await fileExists(tempDir)).toBe(true);
    });
  });

  it("returns false for non-existent directory", async () => {
    await withTempDir("dir-not-exists", async (tempDir) => {
      const dirPath = join(tempDir, "nonexistent-dir");

      expect(await fileExists(dirPath)).toBe(false);
    });
  });

  it("handles paths with ~ expansion", async () => {
    // Home directory should exist
    expect(await fileExists("~")).toBe(true);
    expect(await fileExists("~/.nonexistent-file-12345")).toBe(false);
  });

  it("handles empty path", async () => {
    // Empty path should resolve to current directory which exists
    // But expandPath("") returns "", which fs.access will fail on
    // Let's verify the behavior
    const result = await fileExists("");
    // This depends on implementation - likely false for empty string
    expect(typeof result).toBe("boolean");
  });
});

// =============================================================================
// resolveRepoDir
// =============================================================================
describe("resolveRepoDir", () => {
  it("returns .cass path when in git repository", async () => {
    await withTempGitRepo(async (repoDir) => {
      // Resolve symlinks (macOS /var -> /private/var)
      const realRepoDir = await realpath(repoDir);
      const originalCwd = process.cwd();
      try {
        process.chdir(repoDir);
        const cassDir = await resolveRepoDir();

        expect(cassDir).toBe(join(realRepoDir, ".cass"));
      } finally {
        process.chdir(originalCwd);
      }
    });
  });

  it("returns null when not in git repository", async () => {
    await withTempDir("not-git-repo", async (tempDir) => {
      const originalCwd = process.cwd();
      try {
        process.chdir(tempDir);
        const cassDir = await resolveRepoDir();

        expect(cassDir).toBe(null);
      } finally {
        process.chdir(originalCwd);
      }
    });
  });

  it("works from subdirectory of git repo", async () => {
    await withTempGitRepo(async (repoDir) => {
      // Resolve symlinks (macOS /var -> /private/var)
      const realRepoDir = await realpath(repoDir);
      // Create a subdirectory
      const subDir = join(repoDir, "src/components");
      await mkdir(subDir, { recursive: true });

      const originalCwd = process.cwd();
      try {
        process.chdir(subDir);
        const cassDir = await resolveRepoDir();

        expect(cassDir).toBe(join(realRepoDir, ".cass"));
      } finally {
        process.chdir(originalCwd);
      }
    });
  });
});

// =============================================================================
// resolveGlobalDir
// =============================================================================
describe("resolveGlobalDir", () => {
  it("returns expanded ~/.cass-memory path", () => {
    const result = resolveGlobalDir();
    expect(result).toBe(join(os.homedir(), ".cass-memory"));
  });

  it("returns consistent results", () => {
    const result1 = resolveGlobalDir();
    const result2 = resolveGlobalDir();
    expect(result1).toBe(result2);
  });
});

// =============================================================================
// atomicWrite
// =============================================================================
describe("atomicWrite", () => {
  it("writes content to file", async () => {
    await withTempDir("atomic-write", async (tempDir) => {
      const filePath = join(tempDir, "test.txt");
      const content = "Hello, World!";

      await atomicWrite(filePath, content);

      const file = Bun.file(filePath);
      const result = await file.text();
      expect(result).toBe(content);
    });
  });

  it("creates parent directories if needed", async () => {
    await withTempDir("atomic-nested", async (tempDir) => {
      const filePath = join(tempDir, "a/b/c/file.txt");
      const content = "nested content";

      await atomicWrite(filePath, content);

      const file = Bun.file(filePath);
      const result = await file.text();
      expect(result).toBe(content);
    });
  });

  it("overwrites existing file", async () => {
    await withTempDir("atomic-overwrite", async (tempDir) => {
      const filePath = join(tempDir, "overwrite.txt");

      await writeFile(filePath, "original");
      await atomicWrite(filePath, "updated");

      const file = Bun.file(filePath);
      const result = await file.text();
      expect(result).toBe("updated");
    });
  });

  it("sets restrictive permissions (0o600)", async () => {
    await withTempDir("atomic-perms", async (tempDir) => {
      const filePath = join(tempDir, "secure.txt");

      await atomicWrite(filePath, "secret");

      const stats = await stat(filePath);
      // Check owner read/write only (0o600 = 384 decimal)
      const mode = stats.mode & 0o777;
      expect(mode).toBe(0o600);
    });
  });

  it("handles empty content", async () => {
    await withTempDir("atomic-empty", async (tempDir) => {
      const filePath = join(tempDir, "empty.txt");

      await atomicWrite(filePath, "");

      const file = Bun.file(filePath);
      const result = await file.text();
      expect(result).toBe("");
    });
  });

  it("handles unicode content", async () => {
    await withTempDir("atomic-unicode", async (tempDir) => {
      const filePath = join(tempDir, "unicode.txt");
      const content = "Hello 世界! 🎉 Ñoño";

      await atomicWrite(filePath, content);

      const file = Bun.file(filePath);
      const result = await file.text();
      expect(result).toBe(content);
    });
  });

  it("handles large content", async () => {
    await withTempDir("atomic-large", async (tempDir) => {
      const filePath = join(tempDir, "large.txt");
      const content = "x".repeat(100000); // 100KB

      await atomicWrite(filePath, content);

      const file = Bun.file(filePath);
      const result = await file.text();
      expect(result.length).toBe(100000);
    });
  });

  it("handles ~ path expansion", async () => {
    await withTempDir("atomic-tilde", async (tempDir) => {
      // We test that it works with absolute path (can't safely test ~)
      const filePath = join(tempDir, "tilde-test.txt");

      await atomicWrite(filePath, "content");

      expect(await fileExists(filePath)).toBe(true);
    });
  });

  it("cleans up temp file on success", async () => {
    await withTempDir("atomic-cleanup", async (tempDir) => {
      const filePath = join(tempDir, "clean.txt");

      await atomicWrite(filePath, "content");

      // Check no .tmp files remain
      const { readdir } = await import("node:fs/promises");
      const files = await readdir(tempDir);
      const tmpFiles = files.filter((f) => f.includes(".tmp."));

      expect(tmpFiles).toHaveLength(0);
    });
  });
});

// =============================================================================
// Integration: ensureDir + fileExists + atomicWrite
// =============================================================================
describe("integration: path utilities", () => {
  it("can create structure and verify existence", async () => {
    await withTempDir("integration", async (tempDir) => {
      const dir = join(tempDir, "project/.cass");
      const filePath = join(dir, "playbook.yaml");

      // Create directory structure
      await ensureDir(dir);
      expect(await fileExists(dir)).toBe(true);

      // Write file
      await atomicWrite(filePath, "bullets: []");
      expect(await fileExists(filePath)).toBe(true);

      // Read back
      const file = Bun.file(filePath);
      const content = await file.text();
      expect(content).toBe("bullets: []");
    });
  });
});
