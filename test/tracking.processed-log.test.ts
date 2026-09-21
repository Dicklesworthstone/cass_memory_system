import { describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getProcessedLogPath, ProcessedLog } from "../src/tracking.js";

async function createTmpDir(prefix = "tracking-test-") {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("getProcessedLogPath", () => {
  it("uses global path when workspace not provided", () => {
    const p = getProcessedLogPath();
    expect(p.endsWith(path.join(".cass-memory", "reflections", "global.processed.log"))).toBeTrue();
  });

  it("hashes workspace path into ws-<hash>.processed.log", () => {
    const p = getProcessedLogPath("/tmp/my-workspace");
    expect(p.includes("ws-")).toBeTrue();
    expect(p.endsWith(".processed.log")).toBeTrue();
  });
});

describe("ProcessedLog", () => {
  it("saves and reloads entries round-trip", async () => {
    const dir = await createTmpDir();
    const logPath = path.join(dir, "log.processed.log");

    const log = new ProcessedLog(logPath);
    log.add({
      sessionPath: "s1",
      processedAt: "2025-12-01T00:00:00Z",
      diaryId: "d1",
      deltasGenerated: 3,
    });
    log.add({ sessionPath: "s2", processedAt: "2025-12-02T00:00:00Z", deltasGenerated: 0 });
    await log.save();

    const loaded = new ProcessedLog(logPath);
    await loaded.load();

    expect(loaded.has("s1")).toBeTrue();
    expect(loaded.has("s2")).toBeTrue();
    expect(loaded.getProcessedPaths().size).toBe(2);
  });

  it("ignores malformed lines and continues loading", async () => {
    const dir = await createTmpDir();
    const logPath = path.join(dir, "log.processed.log");

    const content = [
      "# header",
      "-\ts1\t2025-12-01T00:00:00Z\t1\t0",
      "malformed line with no tabs",
      "-\ts2\t2025-12-02T00:00:00Z\t0\t0",
      "", // empty line should be skipped
    ].join("\n");
    await fs.writeFile(logPath, content, "utf-8");

    const log = new ProcessedLog(logPath);
    await log.load();

    // Use has() which normalizes paths internally
    expect(log.has("s1")).toBeTrue();
    expect(log.has("s2")).toBeTrue();
    expect(log.getProcessedPaths().size).toBe(2);
  });

  it("adds entries and reports has()/getProcessedPaths()", async () => {
    const dir = await createTmpDir();
    const logPath = path.join(dir, "log.processed.log");
    const log = new ProcessedLog(logPath);

    log.add({ sessionPath: "a", processedAt: "t1", deltasGenerated: 1 });
    log.add({ sessionPath: "b", processedAt: "t2", deltasGenerated: 0 });

    // has() normalizes paths internally, so relative paths work
    expect(log.has("a")).toBeTrue();
    expect(log.has("c")).toBeFalse();
    // getProcessedPaths() returns normalized (absolute) paths
    expect(log.getProcessedPaths().size).toBe(2);
    // The paths should be normalized versions of "a" and "b"
    expect(log.getProcessedPaths().has(path.resolve("a"))).toBeTrue();
    expect(log.getProcessedPaths().has(path.resolve("b"))).toBeTrue();
  });
});
