import { describe, test, expect } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import {
  createEmptyPlaybook,
  loadPlaybook,
  savePlaybook,
  addBullet,
  loadMergedPlaybook
} from "../src/playbook.js";
import { createTestConfig, createTestBullet } from "./helpers/factories.js";

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
    expect(pb.bullets.find(b => b.id === added.id)).toBeTruthy();
  });

  test("loadMergedPlaybook merges repo playbook if present", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cm-merge-"));
    const originalCwd = process.cwd();
    try {
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
      expect(merged.bullets.find(b => b.id === "g1")).toBeTruthy();
      const repoRule = merged.bullets.find(b => b.content === "Repo rule");
      expect(repoRule).toBeTruthy();
    } finally {
      process.chdir(originalCwd);
    }
  });
});

