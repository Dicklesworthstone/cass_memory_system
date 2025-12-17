import { describe, expect, it } from "bun:test";
import { join, resolve } from "node:path";
import { writeFile, readFile, mkdir, stat } from "node:fs/promises";
import { ProcessedLog, getProcessedLogPath } from "../src/tracking.js";
import { withTempDir } from "./helpers/index.js";
import crypto from "node:crypto";
import os from "node:os";

// =============================================================================
// getProcessedLogPath
// =============================================================================
describe("getProcessedLogPath", () => {
  it("returns global log path when workspace is undefined", () => {
    const home = process.env.HOME || os.homedir();
    const expected = join(home, ".cass-memory", "reflections", "global.processed.log");
    expect(getProcessedLogPath()).toBe(expected);
  });

  it("hashes workspace path for namespaced log", () => {
    const home = process.env.HOME || os.homedir();
    const workspace = "/tmp/my-workspace";
    const hash = crypto.createHash("sha256").update(workspace).digest("hex").slice(0, 8);
    const expected = join(home, ".cass-memory", "reflections", `ws-${hash}.processed.log`);
    expect(getProcessedLogPath(workspace)).toBe(expected);
  });

  it("expands tilde before hashing", () => {
    const home = process.env.HOME || os.homedir();
    const workspace = "~/projects/demo";
    const expanded = workspace.replace(/^~(?=$|\/)/, home);
    const normalized = resolve(expanded);
    const hash = crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 8);
    const expected = join(home, ".cass-memory", "reflections", `ws-${hash}.processed.log`);
    expect(getProcessedLogPath(workspace)).toBe(expected);
  });

});

// =============================================================================
// ProcessedLog - Constructor
// =============================================================================
describe("ProcessedLog - Constructor", () => {
  it("initializes with log path", () => {
    const log = new ProcessedLog("/path/to/log.tsv");
    expect(log).toBeDefined();
  });

  it("starts with no entries", async () => {
    await withTempDir("tracking-empty", async (tempDir) => {
      const logPath = join(tempDir, "processed.tsv");
      const log = new ProcessedLog(logPath);
      await log.load(); // Load from non-existent file

      const paths = log.getProcessedPaths();
      expect(paths.size).toBe(0);
    });
  });
});

// =============================================================================
// ProcessedLog - Load
// =============================================================================
describe("ProcessedLog - Load", () => {
  it("loads entries from existing file", async () => {
    await withTempDir("tracking-load", async (tempDir) => {
      const logPath = join(tempDir, "processed.tsv");
      // Using JSONL format
      const content = [
        "# JSONL header",
        JSON.stringify({ sessionPath: "/path/to/session1.jsonl", processedAt: "2024-01-01T00:00:00Z", deltasGenerated: 5 }),
        JSON.stringify({ sessionPath: "/path/to/session2.jsonl", processedAt: "2024-01-02T00:00:00Z", deltasGenerated: 3 }),
      ].join("\n");
      await writeFile(logPath, content);

      const log = new ProcessedLog(logPath);
      await log.load();

      expect(log.has("/path/to/session1.jsonl")).toBe(true);
      expect(log.has("/path/to/session2.jsonl")).toBe(true);
      expect(log.has("/path/to/unknown.jsonl")).toBe(false);
    });
  });

  it("handles non-existent file gracefully", async () => {
    await withTempDir("tracking-missing", async (tempDir) => {
      const logPath = join(tempDir, "does-not-exist.tsv");
      const log = new ProcessedLog(logPath);

      // Should not throw
      await log.load();

      expect(log.getProcessedPaths().size).toBe(0);
    });
  });

  it("skips comment lines", async () => {
    await withTempDir("tracking-comments", async (tempDir) => {
      const logPath = join(tempDir, "processed.tsv");
      const content = [
        "# This is a header comment",
        "# Another comment",
        JSON.stringify({ sessionPath: "/path/session.jsonl" }),
        "# Trailing comment",
      ].join("\n");
      await writeFile(logPath, content);

      const log = new ProcessedLog(logPath);
      await log.load();

      expect(log.getProcessedPaths().size).toBe(1);
      expect(log.has("/path/session.jsonl")).toBe(true);
    });
  });

  it("skips empty lines", async () => {
    await withTempDir("tracking-empty-lines", async (tempDir) => {
      const logPath = join(tempDir, "processed.tsv");
      const content = [
        "# header",
        "",
        JSON.stringify({ sessionPath: "/path/session.jsonl" }),
        "",
        JSON.stringify({ sessionPath: "/path/session2.jsonl" }),
        "",
      ].join("\n");
      await writeFile(logPath, content);

      const log = new ProcessedLog(logPath);
      await log.load();

      expect(log.getProcessedPaths().size).toBe(2);
    });
  });

  it("skips malformed lines without crashing", async () => {
    await withTempDir("tracking-malformed", async (tempDir) => {
      const logPath = join(tempDir, "processed.tsv");
      const content = [
        "# header",
        "invalid-json",
        JSON.stringify({ sessionPath: "/path/session.jsonl" }),
        "{ incomplete json",
        JSON.stringify({ sessionPath: "/path/session2.jsonl" }),
      ].join("\n");
      await writeFile(logPath, content);

      const log = new ProcessedLog(logPath);
      await log.load();

      // Should have loaded the valid entries
      expect(log.getProcessedPaths().size).toBe(2);
    });
  });

  it("handles missing diary ID as undefined", async () => {
    await withTempDir("tracking-no-id", async (tempDir) => {
      const logPath = join(tempDir, "processed.tsv");
      const content = [
        "# header",
        JSON.stringify({ sessionPath: "/path/session.jsonl" }), // No diaryId
      ].join("\n");
      await writeFile(logPath, content);

      const log = new ProcessedLog(logPath);
      await log.load();

      expect(log.has("/path/session.jsonl")).toBe(true);
    });
  });

  it("handles missing deltas count", async () => {
    await withTempDir("tracking-no-deltas", async (tempDir) => {
      const logPath = join(tempDir, "processed.tsv");
      const content = [
        "# header",
        JSON.stringify({ sessionPath: "/path/session.jsonl" }),
      ].join("\n");
      await writeFile(logPath, content);

      const log = new ProcessedLog(logPath);
      await log.load();

      expect(log.has("/path/session.jsonl")).toBe(true);
    });
  });
});

// =============================================================================
// ProcessedLog - Save
// =============================================================================
describe("ProcessedLog - Save", () => {
  it("saves entries to file", async () => {
    await withTempDir("tracking-save", async (tempDir) => {
      const logPath = join(tempDir, "processed.tsv");
      const log = new ProcessedLog(logPath);

      log.add({
        sessionPath: "/path/to/session.jsonl",
        processedAt: "2024-01-01T00:00:00Z",
        diaryId: "diary-123",
        deltasGenerated: 5,
      });

      await log.save();

      const content = await readFile(logPath, "utf-8");
      expect(content).toContain("/path/to/session.jsonl");
      expect(content).toContain("diary-123");
      expect(content).toContain("2024-01-01T00:00:00Z");
    });
  });

  it("creates parent directories if needed", async () => {
    await withTempDir("tracking-mkdir", async (tempDir) => {
      const logPath = join(tempDir, "nested/deep/processed.tsv");
      const log = new ProcessedLog(logPath);

      log.add({
        sessionPath: "/path/session.jsonl",
        processedAt: "2024-01-01T00:00:00Z",
        deltasGenerated: 0,
      });

      await log.save();

      const stats = await stat(logPath);
      expect(stats.isFile()).toBe(true);
    });
  });

  it("includes header comment", async () => {
    await withTempDir("tracking-header", async (tempDir) => {
      const logPath = join(tempDir, "processed.tsv");
      const log = new ProcessedLog(logPath);

      log.add({
        sessionPath: "/path/session.jsonl",
        processedAt: "2024-01-01T00:00:00Z",
        deltasGenerated: 0,
      });

      await log.save();

      const content = await readFile(logPath, "utf-8");
      expect(content.startsWith("# ")).toBe(true);
    });
  });

  it("omits missing diary ID", async () => {
    await withTempDir("tracking-dash", async (tempDir) => {
      const logPath = join(tempDir, "processed.tsv");
      const log = new ProcessedLog(logPath);

      log.add({
        sessionPath: "/path/session.jsonl",
        processedAt: "2024-01-01T00:00:00Z",
        deltasGenerated: 0,
        // No diaryId
      });

      await log.save();

      const content = await readFile(logPath, "utf-8");
      const lines = content.split("\n");
      const dataLine = lines.find(l => !l.startsWith("#") && l.includes("/path/session.jsonl"));
      const parsed = JSON.parse(dataLine || "{}");
      // Should be undefined or not present
      expect(parsed.diaryId).toBeUndefined();
    });
  });

  it("saves atomically (temp file rename)", async () => {
    await withTempDir("tracking-atomic", async (tempDir) => {
      const logPath = join(tempDir, "processed.tsv");
      const log = new ProcessedLog(logPath);

      log.add({
        sessionPath: "/path/session.jsonl",
        processedAt: "2024-01-01T00:00:00Z",
        deltasGenerated: 0,
      });

      await log.save();

      // No .tmp file should remain
      const { readdir } = await import("node:fs/promises");
      const files = await readdir(tempDir);
      const tmpFiles = files.filter(f => f.endsWith(".tmp"));
      expect(tmpFiles.length).toBe(0);
    });
  });

  it("overwrites existing file", async () => {
    await withTempDir("tracking-overwrite", async (tempDir) => {
      const logPath = join(tempDir, "processed.tsv");

      // Write initial content
      await writeFile(logPath, "old content");

      const log = new ProcessedLog(logPath);
      log.add({
        sessionPath: "/new/session.jsonl",
        processedAt: "2024-01-01T00:00:00Z",
        deltasGenerated: 0,
      });

      await log.save();

      const content = await readFile(logPath, "utf-8");
      expect(content).not.toContain("old content");
      expect(content).toContain("/new/session.jsonl");
    });
  });
});

// =============================================================================
// ProcessedLog - Has
// =============================================================================
describe("ProcessedLog - has", () => {
  it("returns true for existing entry", async () => {
    await withTempDir("tracking-has-true", async (tempDir) => {
      const logPath = join(tempDir, "processed.tsv");
      const log = new ProcessedLog(logPath);

      log.add({
        sessionPath: "/path/session.jsonl",
        processedAt: "2024-01-01T00:00:00Z",
        deltasGenerated: 0,
      });

      expect(log.has("/path/session.jsonl")).toBe(true);
    });
  });

  it("returns false for missing entry", async () => {
    await withTempDir("tracking-has-false", async (tempDir) => {
      const logPath = join(tempDir, "processed.tsv");
      const log = new ProcessedLog(logPath);

      expect(log.has("/path/nonexistent.jsonl")).toBe(false);
    });
  });

  it("is case-sensitive", async () => {
    await withTempDir("tracking-case", async (tempDir) => {
      const logPath = join(tempDir, "processed.tsv");
      const log = new ProcessedLog(logPath);

      log.add({
        sessionPath: "/Path/Session.jsonl",
        processedAt: "2024-01-01T00:00:00Z",
        deltasGenerated: 0,
      });

      expect(log.has("/Path/Session.jsonl")).toBe(true);
      expect(log.has("/path/session.jsonl")).toBe(false);
    });
  });
});

// =============================================================================
// ProcessedLog - Add
// =============================================================================
describe("ProcessedLog - add", () => {
  it("adds new entry", async () => {
    await withTempDir("tracking-add", async (tempDir) => {
      const logPath = join(tempDir, "processed.tsv");
      const log = new ProcessedLog(logPath);

      log.add({
        sessionPath: "/path/session.jsonl",
        processedAt: "2024-01-01T00:00:00Z",
        deltasGenerated: 5,
      });

      expect(log.has("/path/session.jsonl")).toBe(true);
    });
  });

  it("overwrites existing entry with same path", async () => {
    await withTempDir("tracking-add-overwrite", async (tempDir) => {
      const logPath = join(tempDir, "processed.tsv");
      const log = new ProcessedLog(logPath);

      log.add({
        sessionPath: "/path/session.jsonl",
        processedAt: "2024-01-01T00:00:00Z",
        deltasGenerated: 5,
      });

      log.add({
        sessionPath: "/path/session.jsonl",
        processedAt: "2024-01-02T00:00:00Z",
        deltasGenerated: 10,
      });

      const paths = log.getProcessedPaths();
      expect(paths.size).toBe(1);
    });
  });

  it("adds multiple different entries", async () => {
    await withTempDir("tracking-add-multi", async (tempDir) => {
      const logPath = join(tempDir, "processed.tsv");
      const log = new ProcessedLog(logPath);

      log.add({
        sessionPath: "/path/session1.jsonl",
        processedAt: "2024-01-01T00:00:00Z",
        deltasGenerated: 1,
      });

      log.add({
        sessionPath: "/path/session2.jsonl",
        processedAt: "2024-01-02T00:00:00Z",
        deltasGenerated: 2,
      });

      log.add({
        sessionPath: "/path/session3.jsonl",
        processedAt: "2024-01-03T00:00:00Z",
        deltasGenerated: 3,
      });

      expect(log.getProcessedPaths().size).toBe(3);
    });
  });
});

// =============================================================================
// ProcessedLog - getProcessedPaths
// =============================================================================
describe("ProcessedLog - getProcessedPaths", () => {
  it("returns empty set for new log", async () => {
    await withTempDir("tracking-paths-empty", async (tempDir) => {
      const logPath = join(tempDir, "processed.tsv");
      const log = new ProcessedLog(logPath);

      const paths = log.getProcessedPaths();
      expect(paths).toBeInstanceOf(Set);
      expect(paths.size).toBe(0);
    });
  });

  it("returns all session paths", async () => {
    await withTempDir("tracking-paths-all", async (tempDir) => {
      const logPath = join(tempDir, "processed.tsv");
      const log = new ProcessedLog(logPath);

      log.add({
        sessionPath: "/path/session1.jsonl",
        processedAt: "2024-01-01T00:00:00Z",
        deltasGenerated: 0,
      });

      log.add({
        sessionPath: "/path/session2.jsonl",
        processedAt: "2024-01-02T00:00:00Z",
        deltasGenerated: 0,
      });

      const paths = log.getProcessedPaths();
      expect(paths.has("/path/session1.jsonl")).toBe(true);
      expect(paths.has("/path/session2.jsonl")).toBe(true);
    });
  });

  it("returns copy of paths (immutable)", async () => {
    await withTempDir("tracking-paths-copy", async (tempDir) => {
      const logPath = join(tempDir, "processed.tsv");
      const log = new ProcessedLog(logPath);

      log.add({
        sessionPath: "/path/session.jsonl",
        processedAt: "2024-01-01T00:00:00Z",
        deltasGenerated: 0,
      });

      const paths = log.getProcessedPaths();
      paths.delete("/path/session.jsonl");

      // Original should still have the entry
      expect(log.has("/path/session.jsonl")).toBe(true);
    });
  });
});

// =============================================================================
// ProcessedLog - Round-trip
// =============================================================================
describe("ProcessedLog - Round-trip", () => {
  it("save then load preserves entries", async () => {
    await withTempDir("tracking-roundtrip", async (tempDir) => {
      const logPath = join(tempDir, "processed.tsv");

      // Create and populate log
      const log1 = new ProcessedLog(logPath);
      log1.add({
        sessionPath: "/path/session1.jsonl",
        processedAt: "2024-01-01T00:00:00Z",
        diaryId: "diary-abc",
        deltasGenerated: 5,
      });
      log1.add({
        sessionPath: "/path/session2.jsonl",
        processedAt: "2024-01-02T00:00:00Z",
        deltasGenerated: 3,
      });
      await log1.save();

      // Load into new instance
      const log2 = new ProcessedLog(logPath);
      await log2.load();

      expect(log2.has("/path/session1.jsonl")).toBe(true);
      expect(log2.has("/path/session2.jsonl")).toBe(true);
      expect(log2.getProcessedPaths().size).toBe(2);
    });
  });

  it("handles unicode paths in round-trip", async () => {
    await withTempDir("tracking-unicode", async (tempDir) => {
      const logPath = join(tempDir, "processed.tsv");
      const unicodePath = "/путь/到/session_日本語.jsonl";

      const log1 = new ProcessedLog(logPath);
      log1.add({
        sessionPath: unicodePath,
        processedAt: "2024-01-01T00:00:00Z",
        deltasGenerated: 0,
      });
      await log1.save();

      const log2 = new ProcessedLog(logPath);
      await log2.load();

      expect(log2.has(unicodePath)).toBe(true);
    });
  });

  it("handles paths with special characters in round-trip", async () => {
    await withTempDir("tracking-special", async (tempDir) => {
      const logPath = join(tempDir, "processed.tsv");
      const specialPath = "/path/with spaces/and-dashes/file.jsonl";

      const log1 = new ProcessedLog(logPath);
      log1.add({
        sessionPath: specialPath,
        processedAt: "2024-01-01T00:00:00Z",
        deltasGenerated: 0,
      });
      await log1.save();

      const log2 = new ProcessedLog(logPath);
      await log2.load();

      expect(log2.has(specialPath)).toBe(true);
    });
  });
});

// =============================================================================
// ProcessedLog - Edge Cases
// =============================================================================
describe("ProcessedLog - Edge Cases", () => {
  it("handles very long paths", async () => {
    await withTempDir("tracking-long-path", async (tempDir) => {
      const logPath = join(tempDir, "processed.tsv");
      const longPath = "/" + "a".repeat(500) + "/session.jsonl";

      const log = new ProcessedLog(logPath);
      log.add({
        sessionPath: longPath,
        processedAt: "2024-01-01T00:00:00Z",
        deltasGenerated: 0,
      });
      await log.save();

      const log2 = new ProcessedLog(logPath);
      await log2.load();

      expect(log2.has(longPath)).toBe(true);
    });
  });

  it("handles large number of entries", async () => {
    await withTempDir("tracking-many", async (tempDir) => {
      const logPath = join(tempDir, "processed.tsv");
      const log = new ProcessedLog(logPath);

      // Add 1000 entries
      for (let i = 0; i < 1000; i++) {
        log.add({
          sessionPath: `/path/session-${i}.jsonl`,
          processedAt: new Date().toISOString(),
          deltasGenerated: i % 10,
        });
      }
      await log.save();

      const log2 = new ProcessedLog(logPath);
      await log2.load();

      expect(log2.getProcessedPaths().size).toBe(1000);
      expect(log2.has("/path/session-0.jsonl")).toBe(true);
      expect(log2.has("/path/session-999.jsonl")).toBe(true);
    });
  });

  it("handles empty session path gracefully", async () => {
    await withTempDir("tracking-empty-path", async (tempDir) => {
      const logPath = join(tempDir, "processed.tsv");
      const content = [
        "# header",
        JSON.stringify({ sessionPath: "", processedAt: "2024-01-01T00:00:00Z" }),
        JSON.stringify({ sessionPath: "/valid/session.jsonl", processedAt: "2024-01-02T00:00:00Z" }),
      ].join("\n");
      await writeFile(logPath, content);

      const log = new ProcessedLog(logPath);
      await log.load();

      // Empty path should be skipped or handled (if implementation skips)
      // Current implementation checks if (entry.sessionPath)
      expect(log.has("")).toBe(false);
      expect(log.has("/valid/session.jsonl")).toBe(true);
    });
  });
});
