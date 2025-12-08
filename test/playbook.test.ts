import { describe, it, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import yaml from "yaml";

import {
  addBullet,
  createEmptyPlaybook,
  deprecateBullet,
  findBullet,
  loadPlaybook,
  savePlaybook,
} from "../src/playbook.js";
import { Playbook } from "../src/types.js";

async function withTempDir(run: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cass-playbook-"));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("playbook", () => {
  it("creates empty playbook when file missing", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "playbook.yaml");
      const playbook = await loadPlaybook(file);
      expect(playbook.bullets.length).toBe(0);
      expect(playbook.metadata.createdAt).toBeTruthy();
    });
  });

  it("saves and loads playbook roundtrip", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "playbook.yaml");
      const pb = createEmptyPlaybook("test");
      const bullet = addBullet(
        pb,
        { content: "Test rule content", category: "testing" },
        "~/.cursor/sessions/abc.jsonl"
      );
      expect(bullet.id).toMatch(/^b-/);
      await savePlaybook(pb, file);

      const reloaded = await loadPlaybook(file);
      expect(reloaded.bullets.length).toBe(1);
      const loadedBullet = reloaded.bullets[0];
      expect(loadedBullet.content).toBe("Test rule content");
      expect(loadedBullet.category).toBe("testing");
      expect(loadedBullet.sourceAgents).toContain("cursor");
    });
  });

  it("deprecates bullet with reason and replacedBy", async () => {
    const pb: Playbook = createEmptyPlaybook("test");
    const bullet = addBullet(
      pb,
      { content: "Rule to deprecate", category: "testing" },
      "~/.cursor/sessions/abc.jsonl"
    );
    const ok = deprecateBullet(pb, bullet.id, "Superseded", "new-id");
    expect(ok).toBe(true);
    const updated = findBullet(pb, bullet.id)!;
    expect(updated.deprecated).toBe(true);
    expect(updated.state).toBe("retired");
    expect(updated.maturity).toBe("deprecated");
    expect(updated.deprecationReason).toBe("Superseded");
    expect(updated.replacedBy).toBe("new-id");
    expect(updated.deprecatedAt).toBeTruthy();
  });
});

