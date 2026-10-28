import { describe, expect, it, spyOn } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import { join, resolve } from "node:path";
import { InputLimitError, PLAYBOOK_INPUT_LIMITS } from "../src/input-limits.js";
import { getProcessedLogPath, ProcessedLog } from "../src/tracking.js";
import { atomicWrite, canonicalStoragePath } from "../src/utils.js";
import { withTempDir } from "./helpers/index.js";

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
        JSON.stringify({
          sessionPath: "/path/to/session1.jsonl",
          processedAt: "2024-01-01T00:00:00Z",
          deltasGenerated: 5,
        }),
        JSON.stringify({
          sessionPath: "/path/to/session2.jsonl",
          processedAt: "2024-01-02T00:00:00Z",
          deltasGenerated: 3,
        }),
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
      const content = ["# header", JSON.stringify({ sessionPath: "/path/session.jsonl" })].join(
        "\n",
      );
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
      const dataLine = lines.find((l) => !l.startsWith("#") && l.includes("/path/session.jsonl"));
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
      const tmpFiles = files.filter((f) => f.endsWith(".tmp"));
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

describe("ProcessedLog - durable outcome recovery", () => {
  const pendingOutcome = {
    id: "outcome-recovery-test",
    sessionId: "/sessions/queued.jsonl",
    outcome: "success" as const,
    rulesUsed: ["b-recover"],
    recordedAt: "2026-01-01T00:00:00.000Z",
    workspace: "/projects/original",
    path: "/projects/original/.cass/outcomes.jsonl",
    ruleTargets: [{ ruleId: "b-recover", playbookPath: "/projects/original/.cass/playbook.yaml" }],
  };
  const queuedEntry = {
    sessionPath: pendingOutcome.sessionId,
    processedAt: pendingOutcome.recordedAt,
    deltasGenerated: 0,
    recordCount: 2,
    pendingOutcomes: [pendingOutcome],
  };

  it("retains entries when appending after save", async () => {
    await withTempDir("tracking-save-append", async (tempDir) => {
      const logPath = join(tempDir, "processed.log");
      const log = new ProcessedLog(logPath);
      log.add({ sessionPath: "/sessions/first.jsonl", processedAt: pendingOutcome.recordedAt, deltasGenerated: 0 });
      await log.save();
      await log.append(queuedEntry);

      const reloaded = new ProcessedLog(logPath);
      await reloaded.load();
      expect(reloaded.has("/sessions/first.jsonl")).toBe(true);
      expect(reloaded.get(queuedEntry.sessionPath)).toEqual(queuedEntry);
    });
  });

  it.each(["complete legacy entry", "interrupted tail"])("separates a new recovery record from an unterminated %s", async (kind) => {
    await withTempDir("tracking-tail-recovery", async (tempDir) => {
      const logPath = join(tempDir, "processed.log");
      const first = { sessionPath: "/sessions/earlier.jsonl", processedAt: pendingOutcome.recordedAt, deltasGenerated: 0 };
      await writeFile(logPath, kind === "interrupted tail" ? '{"sessionPath":"/sessions/truncated' : JSON.stringify(first));
      await new ProcessedLog(logPath).append(queuedEntry);

      const reloaded = new ProcessedLog(logPath);
      await reloaded.load();
      expect(reloaded.get(queuedEntry.sessionPath)).toEqual(queuedEntry);
      if (kind === "complete legacy entry") expect(reloaded.has(first.sessionPath)).toBe(true);
    });
  });

  it("does not mark an entry processed in memory when its append fails", async () => {
    await withTempDir("tracking-failed-append", async (tempDir) => {
      const logPath = join(tempDir, "blocked.log");
      await mkdir(logPath);
      const log = new ProcessedLog(logPath);
      await expect(log.append(queuedEntry)).rejects.toThrow();
      expect(log.has(queuedEntry.sessionPath)).toBe(false);
      expect(log.getPendingOutcomeEntries()).toEqual([]);
    });
  });

  it("does not acknowledge pending work in memory when its append fails", async () => {
    await withTempDir("tracking-failed-ack", async (tempDir) => {
      const logPath = join(tempDir, "processed.log");
      const log = new ProcessedLog(logPath);
      await log.append(queuedEntry);
      await rename(logPath, `${logPath}.preserved`);
      await mkdir(logPath);

      await expect(log.acknowledgeOutcomes([{ sessionPath: queuedEntry.sessionPath, outcomeIds: [pendingOutcome.id] }])).rejects.toThrow();
      expect(log.getPendingOutcomeEntries()).toEqual([queuedEntry]);
    });
  });

  it("retains recovery data for failed sessions and clears only acknowledged records", async () => {
    await withTempDir("tracking-pending-roundtrip", async (tempDir) => {
      const logPath = join(tempDir, "processed.log");
      await new ProcessedLog(logPath).append({ ...queuedEntry, status: "failed", failures: 1 });
      const loaded = new ProcessedLog(logPath);
      await loaded.load();
      expect(loaded.has(queuedEntry.sessionPath)).toBe(false);
      expect(loaded.getPendingOutcomeEntries()[0]?.pendingOutcomes).toEqual([pendingOutcome]);
      await loaded.acknowledgeOutcomes([{ sessionPath: queuedEntry.sessionPath, outcomeIds: [pendingOutcome.id] }]);

      const acknowledged = new ProcessedLog(logPath);
      await acknowledged.load();
      expect(acknowledged.getPendingOutcomeEntries()).toEqual([]);
      expect(acknowledged.get(queuedEntry.sessionPath)?.recordCount).toBe(2);
    });
  });

  it("reports invalid pending records instead of silently losing recovery work", async () => {
    await withTempDir("tracking-invalid-recovery", async (tempDir) => {
      const logPath = join(tempDir, "processed.log");
      await writeFile(logPath, JSON.stringify({ ...queuedEntry, pendingOutcomes: [{ id: "truncated-record" }] }) + "\n");
      await expect(new ProcessedLog(logPath).load()).rejects.toThrow("invalid pending outcomes");
    });
  });

  it("reports a processed-log read failure instead of treating its recovery state as empty", async () => {
    await withTempDir("tracking-unreadable-recovery", async (tempDir) => {
      const logPath = join(tempDir, "processed.log");
      await mkdir(logPath);
      await expect(new ProcessedLog(logPath).load()).rejects.toThrow();
    });
  });

  it.each([undefined, 42, "   "])("reports a pending queue with invalid session owner %s instead of discarding it", async (sessionPath) => {
    await withTempDir("tracking-invalid-pending-owner", async (tempDir) => {
      const logPath = join(tempDir, "processed.log");
      await writeFile(logPath, JSON.stringify({ ...queuedEntry, sessionPath }) + "\n");
      await expect(new ProcessedLog(logPath).load()).rejects.toThrow("pending outcomes without a valid session path");
    });
  });

  it("keeps a pending queue when a stale manual marker omits it", async () => {
    await withTempDir("tracking-manual-marker", async (tempDir) => {
      const logPath = join(tempDir, "processed.log");
      const staleMarker = new ProcessedLog(logPath);
      await staleMarker.load();
      await new ProcessedLog(logPath).append(queuedEntry);
      await staleMarker.append({
        sessionPath: queuedEntry.sessionPath,
        processedAt: "2026-01-02T00:00:00.000Z",
        deltasGenerated: 0,
      });
      const loaded = new ProcessedLog(logPath);
      await loaded.load();
      expect(loaded.getPendingOutcomeEntries()[0]?.pendingOutcomes).toEqual([pendingOutcome]);
    });
  });

  it("acknowledges only completed IDs without overwriting a newer watermark or queued outcome", async () => {
    await withTempDir("tracking-stale-ack", async (tempDir) => {
      const logPath = join(tempDir, "processed.log");
      await new ProcessedLog(logPath).append(queuedEntry);
      const staleReader = new ProcessedLog(logPath);
      await staleReader.load();
      const newerOutcome = { ...pendingOutcome, id: "outcome-later-segment", recordedAt: "2026-01-02T00:00:00.000Z" };
      await new ProcessedLog(logPath).append({ ...queuedEntry, recordCount: 4, pendingOutcomes: [newerOutcome] });
      await staleReader.acknowledgeOutcomes([{ sessionPath: queuedEntry.sessionPath, outcomeIds: [pendingOutcome.id] }]);

      const loaded = new ProcessedLog(logPath);
      await loaded.load();
      expect(loaded.get(queuedEntry.sessionPath)?.recordCount).toBe(4);
      expect(loaded.getPendingOutcomeEntries()[0]?.pendingOutcomes).toEqual([newerOutcome]);
      expect(staleReader.get(queuedEntry.sessionPath)?.recordCount).toBe(4);
    });
  });

  it("does not clear pending work through an empty queue on append or a stale save", async () => {
    await withTempDir("tracking-queue-ownership", async (tempDir) => {
      const logPath = join(tempDir, "processed.log");
      const staleWriter = new ProcessedLog(logPath);
      await staleWriter.load();
      await new ProcessedLog(logPath).append(queuedEntry);
      await new ProcessedLog(logPath).append({ ...queuedEntry, pendingOutcomes: [] });
      await staleWriter.save();

      const loaded = new ProcessedLog(logPath);
      await loaded.load();
      expect(loaded.getPendingOutcomeEntries()[0]?.pendingOutcomes).toEqual([pendingOutcome]);
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
        JSON.stringify({
          sessionPath: "/valid/session.jsonl",
          processedAt: "2024-01-02T00:00:00Z",
        }),
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

// =============================================================================
// Reflection commits: durable acknowledgment across retries and compaction
// =============================================================================
describe("ProcessedLog - committed reflection batches", () => {
  const timestamp = "2026-10-28T12:00:00.000Z";
  const outcome = {
    id: "outcome-commit-test",
    sessionId: "/sessions/committed.jsonl",
    outcome: "success" as const,
    rulesUsed: ["b-committed"],
    recordedAt: timestamp,
    workspace: "/projects/committed",
    path: "/projects/committed/.cass/outcomes.jsonl",
    ruleTargets: [{ ruleId: "b-committed", playbookPath: "/projects/committed/.cass/playbook.yaml" }],
  };
  const entry = {
    sessionPath: outcome.sessionId,
    processedAt: timestamp,
    deltasGenerated: 2,
    recordCount: 3,
    lastRecordHash: "record-three",
    pendingOutcomes: [outcome],
  };

  it("round-trips a complete batch and its exact owner acknowledgment in one record", async () => {
    await withTempDir("tracking-commit", async (directory) => {
      const logPath = join(directory, "processed.log");
      const owner = join(directory, "playbook.yaml");
      const second = { ...entry, sessionPath: "/sessions/second.jsonl", pendingOutcomes: [] };
      const log = new ProcessedLog(logPath);
      expect(await log.appendCommittedBatch(owner, "commit-one", [entry, second]))
        .toEqual({ alreadyCommitted: false });
      const lines = (await readFile(logPath, "utf8")).split("\n").filter(line => line.startsWith("{"));
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!).entries).toHaveLength(2);
      const loaded = new ProcessedLog(logPath);
      await loaded.load();
      expect(loaded.get(entry.sessionPath)).toEqual(entry);
      expect(loaded.get(second.sessionPath)).toEqual(second);
      expect(loaded.hasCommittedBatch(join(directory, "unused", "..", "playbook.yaml"), "commit-one")).toBe(true);
      expect(loaded.hasCommittedBatch(owner, "different-commit")).toBe(false);
      expect(loaded.hasCommittedBatch(join(directory, "another.yaml"), "commit-one")).toBe(false);
    });
  });

  it("replays an ACK without regressing a newer manual watermark or resurrecting outcomes", async () => {
    await withTempDir("tracking-commit-replay", async (directory) => {
      const logPath = join(directory, "processed.log");
      const owner = join(directory, "playbook.yaml");
      await new ProcessedLog(logPath).appendCommittedBatch(owner, "commit-one", [entry]);
      const newer = new ProcessedLog(logPath);
      await newer.append({ ...entry, processedAt: "2026-10-28T13:00:00.000Z", recordCount: 9, pendingOutcomes: [] });
      await newer.acknowledgeOutcomes([{ sessionPath: entry.sessionPath, outcomeIds: [outcome.id] }]);
      const beforeReplay = await readFile(logPath, "utf8");
      const replay = new ProcessedLog(logPath);
      expect(await replay.appendCommittedBatch(owner, "commit-one", [entry]))
        .toEqual({ alreadyCommitted: true });
      expect(replay.get(entry.sessionPath)?.recordCount).toBe(9);
      expect(replay.getPendingOutcomeEntries()).toEqual([]);
      expect(await readFile(logPath, "utf8")).toBe(beforeReplay);
      expect(newer.hasCommittedBatch(owner, "commit-one")).toBe(true);
    });
  });

  it("retains the latest ACK for each owner and newer entries through stale compaction", async () => {
    await withTempDir("tracking-commit-compaction", async (directory) => {
      const logPath = join(directory, "processed.log");
      const owner = join(directory, "playbook.yaml");
      const otherOwner = join(directory, "other.yaml");
      const stale = new ProcessedLog(logPath);
      await stale.load();
      const writer = new ProcessedLog(logPath);
      await writer.appendCommittedBatch(owner, "commit-one", [entry]);
      await writer.appendCommittedBatch(owner, "commit-two", [{ ...entry, recordCount: 8 }]);
      await writer.appendCommittedBatch(otherOwner, "other-commit", [{ ...entry, sessionPath: "/sessions/other.jsonl" }]);
      await writer.acknowledgeOutcomes([{ sessionPath: entry.sessionPath, outcomeIds: [outcome.id] }]);
      stale.add({ sessionPath: "/sessions/manual.jsonl", processedAt: timestamp, deltasGenerated: 0 });
      await stale.save();
      const loaded = new ProcessedLog(logPath);
      await loaded.load();
      expect(loaded.get(entry.sessionPath)?.recordCount).toBe(8);
      expect(loaded.get(entry.sessionPath)?.pendingOutcomes).toEqual([]);
      expect(loaded.has("/sessions/manual.jsonl")).toBe(true);
      expect(loaded.has("/sessions/other.jsonl")).toBe(true);
      expect(loaded.hasCommittedBatch(owner, "commit-one")).toBe(false);
      expect(loaded.hasCommittedBatch(owner, "commit-two")).toBe(true);
      expect(loaded.hasCommittedBatch(otherOwner, "other-commit")).toBe(true);
      expect(await loaded.appendCommittedBatch(owner, "commit-two", [entry]))
        .toEqual({ alreadyCommitted: true });
      expect(loaded.get(entry.sessionPath)?.recordCount).toBe(8);
      expect(loaded.get(entry.sessionPath)?.pendingOutcomes).toEqual([]);
      const acknowledgments = (await readFile(logPath, "utf8")).split("\n")
        .filter(line => line.startsWith('{"reflectionCommit"'));
      expect(acknowledgments).toHaveLength(2);
    });
  });

  it("does not partially acknowledge a torn batch and replays it as a whole", async () => {
    await withTempDir("tracking-commit-torn", async (directory) => {
      const logPath = join(directory, "processed.log");
      const owner = join(directory, "playbook.yaml");
      const second = { ...entry, sessionPath: "/sessions/second.jsonl" };
      const complete = JSON.stringify({ reflectionCommit: { owner, id: "commit-one" }, entries: [entry, second] });
      const secondOffset = complete.indexOf(JSON.stringify(second));
      await writeFile(logPath, complete.slice(0, secondOffset + 10));
      const log = new ProcessedLog(logPath);
      await log.load();
      expect(log.getProcessedPaths().size).toBe(0);
      expect(log.hasCommittedBatch(owner, "commit-one")).toBe(false);
      expect(await log.appendCommittedBatch(owner, "commit-one", [entry, second]))
        .toEqual({ alreadyCommitted: false });
      const recovered = new ProcessedLog(logPath);
      await recovered.load();
      expect(recovered.get(entry.sessionPath)).toEqual(entry);
      expect(recovered.get(second.sessionPath)).toEqual(second);
      expect(recovered.hasCommittedBatch(owner, "commit-one")).toBe(true);
    });
  });

  it("rejects a malformed complete batch before applying any of its entries", async () => {
    await withTempDir("tracking-commit-invalid", async (directory) => {
      const logPath = join(directory, "processed.log");
      const owner = join(directory, "playbook.yaml");
      const content = JSON.stringify({
        reflectionCommit: { owner, id: "commit-one" },
        entries: [entry, { ...entry, sessionPath: "/sessions/invalid.jsonl", recordCount: "invalid" }],
      }) + "\n";
      await writeFile(logPath, content);
      const log = new ProcessedLog(logPath);
      await expect(log.load()).rejects.toThrow("invalid reflection commit");
      expect(log.getProcessedPaths().size).toBe(0);
      expect(log.hasCommittedBatch(owner, "commit-one")).toBe(false);
      await expect(log.appendCommittedBatch(owner, "commit-two", [entry])).rejects.toThrow("invalid reflection commit");
      expect(await readFile(logPath, "utf8")).toBe(content);
    });
  });

  it("merges an older pending queue into the committed batch instead of losing recovery work", async () => {
    await withTempDir("tracking-commit-queue", async (directory) => {
      const logPath = join(directory, "processed.log");
      const owner = join(directory, "playbook.yaml");
      await new ProcessedLog(logPath).append(entry);
      const laterOutcome = { ...outcome, id: "outcome-later" };
      await new ProcessedLog(logPath).appendCommittedBatch(owner, "commit-one", [{
        ...entry, recordCount: 6, pendingOutcomes: [laterOutcome],
      }]);
      const loaded = new ProcessedLog(logPath);
      await loaded.load();
      expect(loaded.get(entry.sessionPath)?.recordCount).toBe(6);
      expect(loaded.get(entry.sessionPath)?.pendingOutcomes).toEqual([outcome, laterOutcome]);
    });
  });

  it("rejects oversized batch structure and encoding before creating a ledger or lock", async () => {
    await withTempDir("tracking-commit-bounds", async (directory) => {
      const logPath = join(directory, "processed.log");
      const owner = join(directory, "playbook.yaml");
      const log = new ProcessedLog(logPath);
      await expect(log.appendCommittedBatch(owner, "too-many", Array(PLAYBOOK_INPUT_LIMITS.maxArrayLength + 1).fill(entry)))
        .rejects.toBeInstanceOf(InputLimitError);
      await expect(log.appendCommittedBatch(owner, "too-large", [{ ...entry, lastError: "x".repeat(PLAYBOOK_INPUT_LIMITS.maxBytes) }]))
        .rejects.toBeInstanceOf(InputLimitError);
      expect(await fs.readdir(directory)).toEqual([]);
      expect(log.getProcessedPaths().size).toBe(0);
    });
  });

  for (const failedFlush of ["file", ...(process.platform === "win32" ? [] : ["directory"])]) {
    it(`does not ACK a failed ${failedFlush} flush and flushes visible duplicate bytes before succeeding`, async () => {
      await withTempDir("tracking-commit-flush", async (directory) => {
        const logPath = join(directory, "processed.log");
        const owner = join(directory, "playbook.yaml");
        const realOpen = fs.open.bind(fs);
        const restoreHandles: Array<() => void> = [];
        let failing = true;
        let flushes = 0;
        let ledgerOpened = false;
        const openSpy = spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
          const handle = await realOpen(...args);
          if (String(args[0]) === logPath && args[1] === "a+") ledgerOpened = true;
          if (ledgerOpened && String(args[0]) === (failedFlush === "file" ? logPath : directory)) {
            const sync = handle.sync.bind(handle);
            const syncSpy = spyOn(handle, "sync").mockImplementation(async () => {
              flushes++;
              if (failing) throw new Error(`injected ${failedFlush} sync failure`);
              await sync();
            });
            restoreHandles.push(() => syncSpy.mockRestore());
          }
          return handle;
        });
        try {
          const log = new ProcessedLog(logPath);
          await expect(log.appendCommittedBatch(owner, "commit-one", [entry])).rejects.toThrow("sync failure");
          expect(log.hasCommittedBatch(owner, "commit-one")).toBe(false);
          expect(log.get(entry.sessionPath)).toBeUndefined();
          const visible = new ProcessedLog(logPath);
          await visible.load();
          expect(visible.hasCommittedBatch(owner, "commit-one")).toBe(true);
          await expect(log.appendCommittedBatch(owner, "commit-one", [entry])).rejects.toThrow("sync failure");
          expect(log.hasCommittedBatch(owner, "commit-one")).toBe(false);
          failing = false;
          expect(await log.appendCommittedBatch(owner, "commit-one", [entry])).toEqual({ alreadyCommitted: true });
          expect(flushes).toBeGreaterThanOrEqual(3);
          expect(log.hasCommittedBatch(owner, "commit-one")).toBe(true);
          const records = (await readFile(logPath, "utf8")).split("\n").filter(line => line.startsWith("{"));
          expect(records).toHaveLength(1);
        } finally {
          openSpy.mockRestore();
          for (const restore of restoreHandles) restore();
        }
      });
    });
  }
});

// These fault probes exercise the same durable replacement primitive used by
// playbooks, reflection receipts and processed-log compaction.
describe("durable atomic replacement", () => {
  it("keeps the old file when the staged file cannot be flushed", async () => {
    await withTempDir("atomic-stage-flush", async (directory) => {
      const target = join(directory, "state.json");
      await writeFile(target, "original learned state");
      const realOpen = fs.open.bind(fs);
      const restoreHandles: Array<() => void> = [];
      const openSpy = spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        const handle = await realOpen(...args);
        if (String(args[0]).startsWith(`${target}.tmp.`)) {
          const syncSpy = spyOn(handle, "sync").mockImplementation(async () => { throw new Error("injected staged flush failure"); });
          restoreHandles.push(() => syncSpy.mockRestore());
        }
        return handle;
      });
      try {
        await expect(atomicWrite(target, "replacement state")).rejects.toThrow("staged flush failure");
        expect(await readFile(target, "utf8")).toBe("original learned state");
        expect(await fs.readdir(directory)).toEqual(["state.json"]);
      } finally {
        openSpy.mockRestore();
        for (const restore of restoreHandles) restore();
      }
    });
  });

  const posixIt = process.platform === "win32" ? it.skip : it;
  posixIt("reports a failed final directory flush while retaining the installed replacement", async () => {
    await withTempDir("atomic-directory-flush", async (directory) => {
      const target = join(directory, "state.json");
      await writeFile(target, "original learned state");
      const realOpen = fs.open.bind(fs);
      const restoreHandles: Array<() => void> = [];
      let staged = false;
      const openSpy = spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        const handle = await realOpen(...args);
        if (String(args[0]).startsWith(`${target}.tmp.`)) staged = true;
        if (staged && String(args[0]) === directory) {
          const syncSpy = spyOn(handle, "sync").mockImplementation(async () => { throw new Error("injected directory flush failure"); });
          restoreHandles.push(() => syncSpy.mockRestore());
        }
        return handle;
      });
      try {
        await expect(atomicWrite(target, "replacement state")).rejects.toThrow("directory flush failure");
        expect(await readFile(target, "utf8")).toBe("replacement state");
        expect(await fs.readdir(directory)).toEqual(["state.json"]);
      } finally {
        openSpy.mockRestore();
        for (const restore of restoreHandles) restore();
      }
    });
  });
});

const directoryDurabilityIt = process.platform === "win32" ? it.skip : it;
directoryDurabilityIt("retries failed ancestor flushes even after mkdir already created the directory chain", async () => {
  await withTempDir("atomic-ancestor-flush", async (directory) => {
    const target = join(directory, "new", "nested", "state.json");
    const realOpen = fs.open.bind(fs);
    const restoreHandles: Array<() => void> = [];
    let failing = true;
    let ancestorFlushes = 0;
    const openSpy = spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await realOpen(...args);
      if (String(args[0]) === directory) {
        const sync = handle.sync.bind(handle);
        const syncSpy = spyOn(handle, "sync").mockImplementation(async () => {
          ancestorFlushes++;
          if (failing) throw new Error("injected ancestor flush failure");
          await sync();
        });
        restoreHandles.push(() => syncSpy.mockRestore());
      }
      return handle;
    });
    try {
      await expect(atomicWrite(target, "durable state")).rejects.toThrow("ancestor flush failure");
      expect((await stat(join(directory, "new", "nested"))).isDirectory()).toBe(true);
      await expect(atomicWrite(target, "durable state")).rejects.toThrow("ancestor flush failure");
      expect(ancestorFlushes).toBe(2);
      await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
      failing = false;
      await atomicWrite(target, "durable state");
      expect(ancestorFlushes).toBe(3);
      expect(await readFile(target, "utf8")).toBe("durable state");
    } finally {
      openSpy.mockRestore();
      for (const restore of restoreHandles) restore();
    }
  });
});

describe("canonical reflection commit owners", () => {
  it("rejects absent, non-string and blank storage paths instead of treating them as cwd", () => {
    for (const value of [undefined, null, 42, "", "   "]) {
      expect(() => canonicalStoragePath(value as unknown as string)).toThrow("non-empty string");
    }
  });

  it("shares an ACK across directory aliases, including parents created after commitment", async () => {
    await withTempDir("tracking-commit-owner-alias", async (directory) => {
      const realParent = join(directory, "real");
      const aliasParent = join(directory, "alias");
      await mkdir(realParent);
      await fs.symlink(realParent, aliasParent, process.platform === "win32" ? "junction" : "dir");
      const aliasOwner = join(aliasParent, "future", "playbook.yaml");
      const realOwner = join(await fs.realpath(realParent), "future", "playbook.yaml");
      expect(canonicalStoragePath(aliasOwner)).toBe(realOwner);
      const logPath = join(directory, "processed.log");
      const log = new ProcessedLog(logPath);
      await log.appendCommittedBatch(aliasOwner, "aliased-commit", []);
      expect(log.hasCommittedBatch(realOwner, "aliased-commit")).toBe(true);
      await mkdir(join(realParent, "future"));
      const loaded = new ProcessedLog(logPath);
      await loaded.load();
      expect(loaded.hasCommittedBatch(aliasOwner, "aliased-commit")).toBe(true);
      expect(loaded.hasCommittedBatch(realOwner, "aliased-commit")).toBe(true);
      expect(await loaded.appendCommittedBatch(realOwner, "aliased-commit", []))
        .toEqual({ alreadyCommitted: true });
    });
  });

  const posixIt = process.platform === "win32" ? it.skip : it;
  posixIt("keeps a final-component symlink distinct and stable when atomic replacement replaces it", async () => {
    await withTempDir("tracking-commit-owner-final-link", async (directory) => {
      const target = join(directory, "target.yaml");
      const alias = join(directory, "alias.yaml");
      await writeFile(target, "original target");
      await fs.symlink(target, alias);
      const logPath = join(directory, "processed.log");
      const log = new ProcessedLog(logPath);
      await log.appendCommittedBatch(alias, "final-link-commit", []);
      expect(log.hasCommittedBatch(alias, "final-link-commit")).toBe(true);
      expect(log.hasCommittedBatch(target, "final-link-commit")).toBe(false);
      await atomicWrite(alias, "replacement at alias");
      expect(await readFile(target, "utf8")).toBe("original target");
      const loaded = new ProcessedLog(logPath);
      await loaded.load();
      expect(loaded.hasCommittedBatch(alias, "final-link-commit")).toBe(true);
      expect(loaded.hasCommittedBatch(target, "final-link-commit")).toBe(false);
      expect(await loaded.appendCommittedBatch(alias, "final-link-commit", []))
        .toEqual({ alreadyCommitted: true });
    });
  });

  posixIt("preserves meaningful trailing spaces in storage filenames", async () => {
    await withTempDir("tracking-commit-owner-spaces", async (directory) => {
      const owner = join(directory, "playbook.yaml ");
      const trimmedOwner = join(directory, "playbook.yaml");
      const logPath = join(directory, "processed.log");
      await new ProcessedLog(logPath).appendCommittedBatch(owner, "spaced-filename", []);
      const loaded = new ProcessedLog(logPath);
      await loaded.load();
      expect(loaded.hasCommittedBatch(owner, "spaced-filename")).toBe(true);
      expect(loaded.hasCommittedBatch(trimmedOwner, "spaced-filename")).toBe(false);
    });
  });
});
