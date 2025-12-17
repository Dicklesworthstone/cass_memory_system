import { describe, test, expect } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { listStarters, loadStarter, applyStarter } from "../src/starters.js";
import { createEmptyPlaybook } from "../src/playbook.js";
import { withTempCassHome } from "./helpers/temp.js";

describe("starters module (unit)", () => {
  test("listStarters returns builtins sorted by name in a fresh HOME", async () => {
    await withTempCassHome(async () => {
      const starters = await listStarters();
      const names = starters.map((s) => s.name);

      expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
      expect(starters).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "general", source: "builtin", bulletCount: 5 }),
        expect.objectContaining({ name: "node", source: "builtin", bulletCount: 4 }),
        expect.objectContaining({ name: "python", source: "builtin", bulletCount: 4 }),
        expect.objectContaining({ name: "react", source: "builtin", bulletCount: 4 }),
        expect.objectContaining({ name: "rust", source: "builtin", bulletCount: 4 }),
      ]));
    }, "starters-list-builtin");
  });

  test("loadStarter loads builtin starters case-insensitively and normalizes bullets", async () => {
    await withTempCassHome(async () => {
      const playbook = await loadStarter("GeNeRaL");
      expect(playbook).not.toBeNull();

      expect(playbook!.name).toBe("general");
      expect(playbook!.description).toContain("Universal engineering practices");
      expect(playbook!.bullets.length).toBe(5);

      const first = playbook!.bullets[0];
      expect(first.id).toBe("starter-general-small-functions");
      expect(first.source).toBe("community");
      expect(first.kind).toBe("workflow_rule");
      expect(first.state).toBe("active");
      expect(first.sourceSessions).toEqual(["starter:general"]);
      expect(first.sourceAgents).toEqual(["starter"]);
      expect(first.searchPointer).toBe(first.content.slice(0, 80));
      expect(() => new Date(first.createdAt)).not.toThrow();
      expect(first.createdAt).toBe(first.updatedAt);
    }, "starters-load-builtin");
  });

  test("custom starters can be discovered and loaded by either filename or declared name", async () => {
    await withTempCassHome(async (env) => {
      const startersDir = path.join(env.cassMemoryDir, "starters", "custom");
      await mkdir(startersDir, { recursive: true });

      const yamlContents = [
        "name: MyCustom",
        "description: Custom rules for testing",
        "bullets:",
        "  - content: Always write deterministic tests.",
        "    category: testing",
        "  - content: Prefer stable IDs for persisted data.",
        "    category: architecture",
      ].join("\n");

      // Intentionally mismatched filename vs declared name.
      await writeFile(path.join(startersDir, "file-name.yaml"), yamlContents);

      const summaries = await listStarters();
      expect(summaries).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "MyCustom", source: "custom", bulletCount: 2 }),
      ]));

      const byDeclared = await loadStarter("mycustom");
      expect(byDeclared).not.toBeNull();
      expect(byDeclared!.name).toBe("MyCustom");
      expect(byDeclared!.bullets[0].source).toBe("custom");

      const byFilename = await loadStarter("file-name");
      expect(byFilename).not.toBeNull();
      expect(byFilename!.name).toBe("MyCustom");

      // IDs derived from content should be stable across loads.
      const again = await loadStarter("mycustom");
      expect(again!.bullets[0].id).toBe(byDeclared!.bullets[0].id);
    }, "starters-custom-discovery");
  });

  test("applyStarter merges deterministically and respects preferExisting", async () => {
    await withTempCassHome(async () => {
      const starter = await loadStarter("general");
      expect(starter).not.toBeNull();

      const target = createEmptyPlaybook("target");
      const first = applyStarter(target, starter!);
      expect(first.added).toBe(starter!.bullets.length);
      expect(first.skipped).toBe(0);

      // Default behavior: skip duplicates by id or content.
      target.bullets[0].id = "different-id";
      const second = applyStarter(target, starter!);
      expect(second.added).toBe(0);
      expect(second.skipped).toBe(starter!.bullets.length);

      // With preferExisting=false, duplicates are added with a deterministic suffix for id collisions.
      target.bullets[0].id = starter!.bullets[0].id;
      const third = applyStarter(target, starter!, { preferExisting: false });
      expect(third.added).toBe(starter!.bullets.length);
      expect(third.skipped).toBe(0);

      const appended = target.bullets.slice(-starter!.bullets.length);
      for (const bullet of appended) {
        expect(bullet.id.endsWith("-starter")).toBeTrue();
      }
    }, "starters-apply");
  });
});
