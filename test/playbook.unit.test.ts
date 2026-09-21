import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  addBullet,
  createEmptyPlaybook,
  loadMergedPlaybook,
  loadPlaybook,
  removeFromBlockedLog,
  savePlaybook,
} from "../src/playbook.js";
import { createTestBullet, createTestConfig } from "./helpers/factories.js";

function tempFile(name: string) {
  return path.join(os.tmpdir(), `cm-playbook-${Date.now()}-${name}.yaml`);
}

describe("playbook.ts CRUD and loading", () => {
  test("createEmptyPlaybook produces schema with metadata and no bullets", () => {
    const pb = createEmptyPlaybook("unit");
    expect(pb.name).toBe("unit");
    expect(pb.bullets.length).toBe(0);
    expect(pb.metadata.createdAt).toBeTruthy();
  });

  test("loadPlaybook returns empty playbook when file missing", async () => {
    const missing = tempFile("missing");
    const pb = await loadPlaybook(missing);
    expect(pb.bullets.length).toBe(0);
  });

  test("savePlaybook writes YAML and loadPlaybook reads it back", async () => {
    const target = tempFile("roundtrip");
    const pb = createEmptyPlaybook("roundtrip");
    pb.bullets.push(createTestBullet({ content: "Test rule", category: "testing" }));

    await savePlaybook(pb, target);
    const loaded = await loadPlaybook(target);

    expect(loaded.bullets.length).toBe(1);
    expect(loaded.bullets[0].content).toBe("Test rule");
  });

  test("addBullet appends new bullet with generated id", () => {
    const pb = createEmptyPlaybook("add");
    const added = addBullet(pb, { content: "Rule", category: "testing" }, "session-1", 90);
    expect(added.id).toBeTruthy();
    expect(pb.bullets.find((b) => b.id === added.id)).toBeTruthy();
  });

  test("loadMergedPlaybook merges repo playbook if present", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cm-merge-"));
    const originalCwd = process.cwd();
    try {
      // Initialize git repo so resolveRepoDir() can find it
      execSync("git init", { cwd: tmpDir, stdio: "pipe" });
      process.chdir(tmpDir);

      const globalPath = path.join(tmpDir, "global.yaml");
      const repoDir = path.join(tmpDir, ".cass");
      const repoPath = path.join(repoDir, "playbook.yaml");

      const globalPb = createEmptyPlaybook("global");
      globalPb.bullets.push(createTestBullet({ id: "g1", content: "Global rule", category: "g" }));
      await fs.writeFile(globalPath, (await import("yaml")).default.stringify(globalPb), "utf-8");

      await fs.mkdir(repoDir, { recursive: true });
      const repoPb = createEmptyPlaybook("repo");
      repoPb.bullets.push(createTestBullet({ id: "r1", content: "Repo rule", category: "r" }));
      await fs.writeFile(repoPath, (await import("yaml")).default.stringify(repoPb), "utf-8");

      const config = createTestConfig({ playbookPath: globalPath });

      const merged = await loadMergedPlaybook(config);
      expect(merged.bullets.find((b) => b.id === "g1")).toBeTruthy();
      const repoRule = merged.bullets.find((b) => b.content === "Repo rule");
      expect(repoRule).toBeTruthy();
    } finally {
      process.chdir(originalCwd);
    }
  });
});

describe("removeFromBlockedLog", () => {
  function tempBlockedLog(name: string) {
    return path.join(os.tmpdir(), `cm-blocked-${Date.now()}-${name}.log`);
  }

  test("returns false if file does not exist", async () => {
    const logPath = tempBlockedLog("missing");
    const result = await removeFromBlockedLog("b-123", logPath);
    expect(result).toBe(false);
  });

  test("removes matching entry and returns true", async () => {
    const logPath = tempBlockedLog("remove");
    const entries = [
      { id: "b-1", reason: "harmful", timestamp: "2025-01-01" },
      { id: "b-2", reason: "forgot", timestamp: "2025-01-02" },
      { id: "b-3", reason: "expired", timestamp: "2025-01-03" },
    ];
    await fs.writeFile(logPath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");

    const result = await removeFromBlockedLog("b-2", logPath);
    expect(result).toBe(true);

    const content = await fs.readFile(logPath, "utf-8");
    const remaining = content
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(remaining.length).toBe(2);
    expect(remaining.find((e: any) => e.id === "b-2")).toBeUndefined();
    expect(remaining.find((e: any) => e.id === "b-1")).toBeTruthy();
    expect(remaining.find((e: any) => e.id === "b-3")).toBeTruthy();
  });

  test("returns false if entry not found", async () => {
    const logPath = tempBlockedLog("notfound");
    const entries = [{ id: "b-1", reason: "test" }];
    await fs.writeFile(logPath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");

    const result = await removeFromBlockedLog("b-nonexistent", logPath);
    expect(result).toBe(false);

    // File should be unchanged
    const content = await fs.readFile(logPath, "utf-8");
    expect(content.trim().split("\n").length).toBe(1);
  });

  test("preserves malformed lines", async () => {
    const logPath = tempBlockedLog("malformed");
    const content =
      '{"id":"b-1","reason":"test"}\nmalformed garbage\n{"id":"b-2","reason":"test"}\n';
    await fs.writeFile(logPath, content);

    const result = await removeFromBlockedLog("b-1", logPath);
    expect(result).toBe(true);

    const newContent = await fs.readFile(logPath, "utf-8");
    expect(newContent).toContain("malformed garbage");
    expect(newContent).toContain("b-2");
    expect(newContent).not.toContain("b-1");
  });

  test("handles removing last entry (empty result)", async () => {
    const logPath = tempBlockedLog("lastentry");
    await fs.writeFile(logPath, '{"id":"b-only","reason":"test"}\n');

    const result = await removeFromBlockedLog("b-only", logPath);
    expect(result).toBe(true);

    const content = await fs.readFile(logPath, "utf-8");
    expect(content).toBe("");
  });
});
