import { describe, expect, it, spyOn } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import yaml from "yaml";
import {
  loadConfig,
  resolvePlaybookInputLimits,
  resolveTrustedPlaybookPolicy,
} from "../src/config.js";
import {
  assertInputLimits,
  CONFIG_INPUT_LIMITS,
  InputLimitError,
  parseYamlInput,
  PLAYBOOK_INPUT_LIMITS,
} from "../src/input-limits.js";
import { createEmptyPlaybook, loadPlaybook, savePlaybook } from "../src/playbook.js";
import { PlaybookBulletSchema, PlaybookSchema } from "../src/types.js";
import { createTestBullet } from "./helpers/factories.js";
import { withTempDir } from "./helpers/temp.js";

const CLI = path.resolve(import.meta.dir, "../src/cm.ts");
const stamp = "2026-10-27T12:00:00.000Z";
const environmentKeys = [
  "HOME", "USERPROFILE", "CASS_MEMORY_HOME", "XDG_DATA_HOME",
  "CM_PLAYBOOK_MAX_NODES", "CM_PLAYBOOK_MAX_BYTES", "CM_PLAYBOOK_MAX_ARRAY_LENGTH",
] as const;

type Fixture = {
  directory: string;
  memory: string;
  configFile: string;
  playbook: string;
  writeConfig: (value: unknown) => Promise<void>;
};

async function withLimitsHome(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  await withTempDir("trusted-playbook-limits", async (temporary) => {
    const directory = await fs.realpath(temporary);
    const memory = path.join(directory, ".cass-memory");
    const configFile = path.join(memory, "config.json");
    const playbook = path.join(memory, "playbook.yaml");
    const previous = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
    await fs.mkdir(memory);
    try {
      for (const key of environmentKeys) delete process.env[key];
      process.env.HOME = directory;
      process.env.USERPROFILE = directory;
      process.env.CASS_MEMORY_HOME = memory;
      await run({
        directory, memory, configFile, playbook,
        writeConfig: async value => { await fs.writeFile(configFile, JSON.stringify(value)); },
      });
    } finally {
      for (const key of environmentKeys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    }
  });
}

async function createRepo(directory: string): Promise<string> {
  await fs.mkdir(directory, { recursive: true });
  const result = spawnSync("git", ["init", "--quiet"], { cwd: directory, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`Cannot initialize security fixture: ${result.stderr}`);
  await fs.mkdir(path.join(directory, ".cass"));
  return directory;
}

/** A pre-limit reflection artifact, including extension fields old schemas accepted. */
function legacyReflectionPlaybook() {
  return {
    ...createEmptyPlaybook("v0.5.0 reflection state"),
    schema_version: 1,
    metadata: {
      createdAt: stamp,
      lastReflection: stamp,
      totalReflections: 47,
      totalSessionsProcessed: 987,
      legacyProducer: "v0.5.0",
      checkpoint: { workspace: "/old/project", sequence: "9007199254740993" },
    },
    extension: { keep: ["café", "漢字", null, false], source: "historical reflection" },
    deprecatedPatterns: [{
      pattern: "Do not lose historical replacements",
      reason: "replaced after review",
      deprecatedAt: stamp,
      replacement: "b-legacy-1",
      audit: { reviewedBy: "operator" },
    }],
    bullets: Array.from({ length: 6_543 }, (_, index) => ({
      ...createTestBullet({
        id: `b-legacy-${index}`,
        content: `Retain learned rule ${index} and its complete history.`,
        category: "compatibility",
        createdAt: stamp,
        updatedAt: stamp,
        state: index >= 6_393 ? "retired" : "active",
        maturity: index < 6_267 ? "candidate" : "proven",
        helpfulCount: index % 5 === 0 ? 2 : 0,
        harmfulCount: index % 31 === 0 ? 1 : 0,
        pinned: index === 1,
        sourceSessions: [`/sessions/${index}.jsonl`, "/sessions/shared.jsonl"],
        sourceAgents: ["claude", "codex"],
        tags: ["history", "learned"],
      }),
      // Identical events are intentional: recovery is not permission to deduplicate.
      feedbackEvents: index % 5 === 0 ? Array.from({ length: 2 }, () => ({
        type: "helpful" as const,
        timestamp: stamp,
        sessionPath: `/sessions/${index}.jsonl`,
        context: "Keep both recorded events",
        extension: { source: "v0.5.0", confidence: 0.5 },
      })) : [],
      helpfulEvents: [{ timestamp: stamp, context: "Preserve the legacy event representation" }],
      derivedFrom: { diaryIds: [`diary-${index}`], keyEvidence: ["Do not discard evidence"] },
    })),
  };
}

describe("trusted local playbook configuration (#101)", () => {
  it("keeps strict defaults and allows a not-yet-created local destination", async () => {
    await withLimitsHome(async ({ playbook }) => {
      const policy = await resolveTrustedPlaybookPolicy();
      expect(policy.path).toBe(playbook);
      expect(policy.trusted).toBe(true);
      expect(policy.limits).toEqual(PLAYBOOK_INPUT_LIMITS);
      expect(await resolvePlaybookInputLimits(playbook)).toEqual(PLAYBOOK_INPUT_LIMITS);
      expect(PLAYBOOK_INPUT_LIMITS.maxNodes).toBe(200_000);
      expect(PLAYBOOK_INPUT_LIMITS.maxBytes).toBe(16 * 1024 * 1024);
      expect(PLAYBOOK_INPUT_LIMITS.maxArrayLength).toBe(10_000);
    });
  });

  it("merges environment overrides with local settings without changing structural ceilings", async () => {
    await withLimitsHome(async ({ writeConfig, playbook }) => {
      await writeConfig({ playbookLimits: { maxNodes: 400_000, maxArrayLength: 12_000 } });
      process.env.CM_PLAYBOOK_MAX_NODES = "500000";
      process.env.CM_PLAYBOOK_MAX_BYTES = "33554432";
      const expected = { ...PLAYBOOK_INPUT_LIMITS, maxNodes: 500_000, maxBytes: 32 * 1024 * 1024, maxArrayLength: 12_000 };
      expect((await resolveTrustedPlaybookPolicy()).limits).toEqual(expected);
      expect(await resolvePlaybookInputLimits(playbook)).toEqual(expected);
      expect((await loadConfig()).playbookLimits).toMatchObject({ maxNodes: 500_000, maxBytes: 32 * 1024 * 1024, maxArrayLength: 12_000 });
    });
  });

  for (const extension of ["yaml", "yml"]) {
    it(`reads trusted ${extension} configuration with the normal format rules`, async () => {
      await withLimitsHome(async ({ memory, playbook }) => {
        await fs.writeFile(path.join(memory, `config.${extension}`), "playbook_limits:\n  max_nodes: 450000\n");
        expect((await resolveTrustedPlaybookPolicy()).configFile.path).toBe(path.join(memory, `config.${extension}`));
        expect((await resolvePlaybookInputLimits(playbook)).maxNodes).toBe(450_000);
      });
    });
  }

  it("uses JSON precedence without borrowing limits from a shadowed YAML file", async () => {
    await withLimitsHome(async ({ memory, writeConfig, playbook }) => {
      await writeConfig({ playbookLimits: { maxNodes: 250_000 } });
      await fs.writeFile(path.join(memory, "config.yaml"), "playbookLimits:\n  maxNodes: 1800000\n");
      expect((await resolvePlaybookInputLimits(playbook)).maxNodes).toBe(250_000);
    });
  });

  for (const [field, maximum] of [
    ["maxNodes", 2_000_000], ["maxBytes", 64 * 1024 * 1024], ["maxArrayLength", 100_000],
  ] as const) {
    it(`enforces positive safe integers and the immutable ${field} ceiling`, async () => {
      await withLimitsHome(async ({ writeConfig, playbook }) => {
        await writeConfig({ playbookLimits: { [field]: maximum } });
        expect((await resolvePlaybookInputLimits(playbook))[field]).toBe(maximum);
        for (const value of [0, -1, 1.5, maximum + 1, Number.MAX_SAFE_INTEGER, "500000", null]) {
          await writeConfig({ playbookLimits: { [field]: value } });
          await expect(resolveTrustedPlaybookPolicy()).rejects.toThrow();
          await expect(loadConfig()).rejects.toThrow();
        }
      });
    });
  }

  for (const [name, maximum] of [
    ["CM_PLAYBOOK_MAX_NODES", 2_000_000],
    ["CM_PLAYBOOK_MAX_BYTES", 64 * 1024 * 1024],
    ["CM_PLAYBOOK_MAX_ARRAY_LENGTH", 100_000],
  ] as const) {
    it(`rejects invalid ${name} instead of treating it as an unlimited budget`, async () => {
      await withLimitsHome(async () => {
        for (const value of ["0", "-1", "1.5", "Infinity", "NaN", "invalid", String(maximum + 1)]) {
          process.env[name] = value;
          await expect(resolveTrustedPlaybookPolicy()).rejects.toThrow();
          await expect(loadConfig()).rejects.toThrow();
        }
      });
    });
  }

  it("never lets a global config raise its own parser's node or byte budget", async () => {
    await withLimitsHome(async ({ configFile, writeConfig }) => {
      await writeConfig({
        playbookLimits: { maxNodes: 2_000_000, maxBytes: 64 * 1024 * 1024, maxArrayLength: 100_000 },
        extension: Array.from({ length: 1_000 }, () => Array(25).fill(0)),
      });
      await expect(resolveTrustedPlaybookPolicy()).rejects.toThrow(InputLimitError);
      await expect(loadConfig()).rejects.toThrow(InputLimitError);
      await fs.writeFile(configFile, JSON.stringify({
        playbookLimits: { maxBytes: 64 * 1024 * 1024 },
        extension: "x".repeat(CONFIG_INPUT_LIMITS.maxBytes),
      }));
      await expect(resolveTrustedPlaybookPolicy()).rejects.toThrow(InputLimitError);
      await expect(loadConfig()).rejects.toThrow(InputLimitError);
    });
  });

  it("ignores repository limit settings while still applying an allowed repository setting", async () => {
    await withLimitsHome(async ({ directory, writeConfig, playbook }) => {
      const repo = await createRepo(path.join(directory, "repo"));
      await writeConfig({ playbookLimits: { maxNodes: 300_000 } });
      await fs.writeFile(path.join(repo, ".cass", "config.yaml"), yaml.stringify({
        model: "repository-model",
        playbookPath: path.join(repo, "malicious.yaml"),
        playbookLimits: { maxNodes: 2_000_000, maxBytes: 64 * 1024 * 1024, maxArrayLength: 100_000 },
      }));
      const config = await loadConfig({}, { cwd: repo });
      expect(config.model).toBe("repository-model");
      expect(config.playbookPath).toBe(playbook);
      expect(config.playbookLimits.maxNodes).toBe(300_000);
      expect(await resolvePlaybookInputLimits(path.join(repo, ".cass", "playbook.yaml"))).toEqual(PLAYBOOK_INPUT_LIMITS);
    });
  });

  it("does not grant authority to a programmatic merged config or a relative global path", async () => {
    await withLimitsHome(async ({ directory, writeConfig, playbook }) => {
      const foreign = path.join(directory, "foreign.yaml");
      await writeConfig({ playbookLimits: { maxNodes: 500_000 } });
      await loadConfig({
        playbookPath: foreign,
        playbookLimits: { maxNodes: 1_000_000, maxBytes: 32 * 1024 * 1024, maxArrayLength: 20_000 },
      });
      expect(await resolvePlaybookInputLimits(foreign)).toEqual(PLAYBOOK_INPUT_LIMITS);
      expect((await resolvePlaybookInputLimits(playbook)).maxNodes).toBe(500_000);
      await writeConfig({ playbookPath: "relative.yaml", playbookLimits: { maxNodes: 500_000 } });
      expect((await resolveTrustedPlaybookPolicy()).trusted).toBe(false);
      expect(await resolvePlaybookInputLimits(path.resolve("relative.yaml"))).toEqual(PLAYBOOK_INPUT_LIMITS);
    });
  });

  it("supports an explicit absolute personal path without trusting neighboring files", async () => {
    await withLimitsHome(async ({ directory, writeConfig }) => {
      const personal = path.join(directory, "personal-memory.yaml");
      await writeConfig({ playbookPath: personal, playbookLimits: { maxNodes: 500_000 } });
      expect((await resolvePlaybookInputLimits(personal)).maxNodes).toBe(500_000);
      expect(await resolvePlaybookInputLimits(path.join(directory, "shared-memory.yaml"))).toEqual(PLAYBOOK_INPUT_LIMITS);
      expect(await resolvePlaybookInputLimits(personal, { untrusted: true })).toEqual(PLAYBOOK_INPUT_LIMITS);
    });
  });
});

describe("repository and link boundaries for trusted limits (#101)", () => {
  for (const location of [".cass/playbook.yaml", "data/playbook.yaml"]) {
    it(`keeps ${location} strict even when global config selects it`, async () => {
      await withLimitsHome(async ({ directory, writeConfig }) => {
        const repo = await createRepo(path.join(directory, "repo"));
        const target = path.join(repo, location);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await writeConfig({ playbookPath: target, playbookLimits: { maxNodes: 500_000 } });
        expect((await resolveTrustedPlaybookPolicy()).trusted).toBe(false);
        expect(await resolvePlaybookInputLimits(target)).toEqual(PLAYBOOK_INPUT_LIMITS);
      });
    });
  }

  it("keeps .cass data strict even outside a currently discoverable repository", async () => {
    await withLimitsHome(async ({ directory, writeConfig }) => {
      const target = path.join(directory, "unpacked-checkout", ".cass", "playbook.yaml");
      await fs.mkdir(path.dirname(target), { recursive: true });
      await writeConfig({ playbookPath: target, playbookLimits: { maxNodes: 500_000 } });
      expect(await resolvePlaybookInputLimits(target)).toEqual(PLAYBOOK_INPUT_LIMITS);
    });
  });

  it("does not trust global config stored inside a repository", async () => {
    await withLimitsHome(async ({ directory, playbook }) => {
      const repo = await createRepo(path.join(directory, "repo"));
      const memory = path.join(repo, "memory");
      await fs.mkdir(memory);
      process.env.CASS_MEMORY_HOME = memory;
      await fs.writeFile(path.join(memory, "config.json"), JSON.stringify({
        playbookPath: playbook, playbookLimits: { maxNodes: 500_000 },
      }));
      expect((await resolveTrustedPlaybookPolicy()).trusted).toBe(false);
      expect(await resolvePlaybookInputLimits(playbook)).toEqual(PLAYBOOK_INPUT_LIMITS);
    });
  });

  it("recognizes .git files used by linked worktrees", async () => {
    await withLimitsHome(async ({ directory, writeConfig }) => {
      const gitRoot = await createRepo(path.join(directory, "main-checkout"));
      const worktree = path.join(directory, "linked-checkout");
      await fs.mkdir(worktree);
      await fs.writeFile(path.join(worktree, ".git"), `gitdir: ${path.join(gitRoot, ".git")}\n`);
      const target = path.join(worktree, "memory.yaml");
      await writeConfig({ playbookPath: target, playbookLimits: { maxNodes: 500_000 } });
      expect(await resolvePlaybookInputLimits(target)).toEqual(PLAYBOOK_INPUT_LIMITS);
    });
  });

  for (const linkType of ["symbolic", "hard"] as const) {
    it.skipIf(process.platform === "win32")(`does not elevate a ${linkType}-linked global playbook`, async () => {
      await withLimitsHome(async ({ directory, writeConfig, playbook }) => {
        const original = path.join(directory, "original.yaml");
        await fs.writeFile(original, yaml.stringify(createEmptyPlaybook()));
        if (linkType === "symbolic") await fs.symlink(original, playbook);
        else await fs.link(original, playbook);
        await writeConfig({ playbookLimits: { maxNodes: 500_000 } });
        expect((await resolveTrustedPlaybookPolicy()).trusted).toBe(false);
        expect(await resolvePlaybookInputLimits(playbook)).toEqual(PLAYBOOK_INPUT_LIMITS);
      });
    });

    it.skipIf(process.platform === "win32")(`does not take elevated limits from a ${linkType}-linked global config`, async () => {
      await withLimitsHome(async ({ directory, configFile, playbook }) => {
        const original = path.join(directory, "config-source.json");
        await fs.writeFile(original, JSON.stringify({ playbookLimits: { maxNodes: 500_000 } }));
        if (linkType === "symbolic") await fs.symlink(original, configFile);
        else await fs.link(original, configFile);
        expect((await resolveTrustedPlaybookPolicy()).trusted).toBe(false);
        expect(await resolvePlaybookInputLimits(playbook)).toEqual(PLAYBOOK_INPUT_LIMITS);
      });
    });
  }

  it.skipIf(process.platform === "win32")("does not launder a repository target through a parent directory symlink", async () => {
    await withLimitsHome(async ({ directory, writeConfig }) => {
      const repo = await createRepo(path.join(directory, "repo"));
      const alias = path.join(directory, "personal-looking-directory");
      await fs.symlink(repo, alias, "dir");
      const target = path.join(alias, "memory.yaml");
      await writeConfig({ playbookPath: target, playbookLimits: { maxNodes: 500_000 } });
      expect(await resolvePlaybookInputLimits(target)).toEqual(PLAYBOOK_INPUT_LIMITS);
    });
  });

  it.skipIf(process.platform === "win32")("does not authorize a symlink followed by .. using its lexical destination", async () => {
    await withLimitsHome(async ({ directory, memory, writeConfig }) => {
      const repo = await createRepo(path.join(directory, "repo"));
      const child = path.join(repo, "child");
      await fs.mkdir(child);
      await fs.symlink(child, path.join(memory, "alias"), "dir");
      // path.join would erase the critical traversal before the OS sees it.
      const selected = `${memory}/alias/../playbook.yaml`;
      await fs.writeFile(path.join(repo, "playbook.yaml"), yaml.stringify(createEmptyPlaybook("repository-owned")));
      await writeConfig({ playbookPath: selected, playbookLimits: { maxNodes: 500_000 } });
      expect(await fs.realpath(selected)).toBe(path.join(repo, "playbook.yaml"));
      expect(await resolvePlaybookInputLimits(selected)).toEqual(PLAYBOOK_INPUT_LIMITS);
    });
  });
});

describe("bounded legacy storage compatibility (#101)", () => {
  it("loads and round-trips 6,543 legacy rules without pruning records or feedback", async () => {
    await withLimitsHome(async ({ playbook, writeConfig }) => {
      const legacy = legacyReflectionPlaybook();
      const original = yaml.stringify(legacy, { aliasDuplicateObjects: false });
      expect(Buffer.byteLength(original)).toBeLessThan(PLAYBOOK_INPUT_LIMITS.maxBytes);
      expect(() => assertInputLimits(legacy, PLAYBOOK_INPUT_LIMITS, "v0.5.0 fixture")).toThrow(InputLimitError);
      await fs.writeFile(playbook, original);
      await expect(loadPlaybook(playbook)).rejects.toThrow(InputLimitError);
      await writeConfig({ playbookLimits: { maxNodes: 750_000 } });
      const loaded = await loadPlaybook(playbook);
      expect(loaded).toEqual(legacy);
      expect(loaded.bullets).toHaveLength(6_543);
      expect(loaded.bullets.filter(bullet => bullet.state === "retired")).toHaveLength(150);
      expect(loaded.bullets[0].feedbackEvents).toHaveLength(2);
      await savePlaybook(loaded, playbook);
      expect(await loadPlaybook(playbook)).toEqual(legacy);
    });
  }, 30_000);

  it("uses strict provenance even for the exact file selected as a personal playbook", async () => {
    await withLimitsHome(async ({ directory, playbook, writeConfig }) => {
      const original = JSON.stringify({
        ...createEmptyPlaybook(),
        extension: Array.from({ length: 500 }, () => Array(500).fill(0)),
      });
      await fs.writeFile(playbook, original);
      await writeConfig({ playbookLimits: { maxNodes: 500_000 } });
      expect((await loadPlaybook(playbook)).bullets).toHaveLength(0);
      await expect(loadPlaybook(playbook, { untrusted: true })).rejects.toThrow(InputLimitError);
      const imported = path.join(directory, "imported.yaml");
      await fs.writeFile(imported, original);
      await expect(loadPlaybook(imported)).rejects.toThrow(InputLimitError);
      // An internal staging hint is not a public import escape hatch.
      await expect(loadPlaybook(imported, { limitsSourcePath: playbook })).rejects.toThrow();
    });
  }, 30_000);

  it("loads a file above the old byte cap only under the configured personal budget", async () => {
    await withLimitsHome(async ({ playbook, writeConfig }) => {
      // One bounded comment makes byte size the only exceeded dimension.
      const content = `#${"x".repeat(PLAYBOOK_INPUT_LIMITS.maxBytes)}\n${yaml.stringify(createEmptyPlaybook("large personal file"))}`;
      await fs.writeFile(playbook, content);
      await expect(loadPlaybook(playbook)).rejects.toThrow("maximum file size");
      await writeConfig({ playbookLimits: { maxBytes: 32 * 1024 * 1024 } });
      expect((await loadPlaybook(playbook)).name).toBe("large personal file");
      await expect(loadPlaybook(playbook, { untrusted: true })).rejects.toThrow("maximum file size");
    });
  });

  it("honors maxArrayLength for storage while import schemas retain their hard ceilings", async () => {
    await withLimitsHome(async ({ playbook, writeConfig }) => {
      const length = PLAYBOOK_INPUT_LIMITS.maxArrayLength + 1;
      const raw = {
        ...createEmptyPlaybook(),
        bullets: [createTestBullet({
          tags: Array(length).fill("tag"),
          sourceAgents: Array(length).fill("claude"),
          sourceSessions: Array(length).fill("/session.jsonl"),
          embedding: Array(length).fill(0.25),
          feedbackEvents: [{
            type: "helpful", timestamp: stamp,
            transcriptEvidenceKeys: Array(length).fill("te1:" + "a".repeat(64)),
          }],
        }), createTestBullet({
          feedbackEvents: Array.from({ length }, () => ({ type: "helpful" as const, timestamp: stamp })),
        })],
        deprecatedPatterns: Array.from({ length }, () => ({ pattern: "historical", reason: "keep", deprecatedAt: stamp })),
      };
      expect(PlaybookSchema.safeParse(raw).success).toBe(false);
      expect(PlaybookBulletSchema.safeParse(raw.bullets[0]).success).toBe(false);
      await writeConfig({ playbookLimits: { maxArrayLength: length, maxNodes: 750_000 } });
      await fs.writeFile(playbook, JSON.stringify(raw));
      const loaded = await loadPlaybook(playbook);
      expect(loaded).toEqual(raw);
      await savePlaybook(loaded, playbook);
      // Inline embeddings remain derived data and must not reappear on disk (#99).
      const { embedding: _embedding, ...learned } = raw.bullets[0];
      expect(await loadPlaybook(playbook)).toEqual({ ...raw, bullets: [learned, raw.bullets[1]] });
      await expect(loadPlaybook(playbook, { untrusted: true })).rejects.toThrow(InputLimitError);
    });
  }, 30_000);

  it("accepts a trusted bullet array above 10,000 while preserving public schema bounds", async () => {
    await withLimitsHome(async ({ playbook, writeConfig }) => {
      const length = PLAYBOOK_INPUT_LIMITS.maxArrayLength + 1;
      const raw = {
        ...createEmptyPlaybook(),
        bullets: Array.from({ length }, (_, index) => ({
          id: `retained-${index}`, content: `Learned rule ${index}`, category: "legacy",
          createdAt: stamp, updatedAt: stamp,
        })),
      };
      expect(PlaybookSchema.safeParse(raw).success).toBe(false);
      await fs.writeFile(playbook, JSON.stringify(raw));
      await writeConfig({ playbookLimits: { maxArrayLength: length, maxNodes: 500_000 } });
      const loaded = await loadPlaybook(playbook);
      expect(loaded.bullets).toHaveLength(length);
      expect(loaded.bullets.map(bullet => bullet.id)).toEqual(raw.bullets.map(bullet => bullet.id));
      expect(loaded.bullets[length - 1].content).toBe(`Learned rule ${length - 1}`);
    });
  });

  it("enforces configured node and array limits before replacing existing state", async () => {
    await withLimitsHome(async ({ playbook, writeConfig }) => {
      const initial = createEmptyPlaybook();
      const original = yaml.stringify(initial);
      await fs.writeFile(playbook, original);
      await writeConfig({ playbookLimits: { maxNodes: 100, maxArrayLength: 5 } });
      const tooManyNodes = {
        ...initial,
        bullets: Array.from({ length: 5 }, () => createTestBullet()),
      };
      await expect(savePlaybook(tooManyNodes, playbook)).rejects.toThrow(InputLimitError);
      expect(await fs.readFile(playbook, "utf8")).toBe(original);
      const tooManyBullets = { ...initial, bullets: Array.from({ length: 6 }, () => createTestBullet()) };
      await expect(savePlaybook(tooManyBullets, playbook)).rejects.toThrow("maximum array length");
      expect(await fs.readFile(playbook, "utf8")).toBe(original);
    });
  });

  it("applies the byte budget to both reads and serialization", async () => {
    await withLimitsHome(async ({ playbook, writeConfig }) => {
      const original = yaml.stringify(createEmptyPlaybook());
      await fs.writeFile(playbook, original);
      await writeConfig({ playbookLimits: { maxBytes: Buffer.byteLength(original) } });
      expect((await loadPlaybook(playbook)).bullets).toHaveLength(0);
      await expect(savePlaybook({ ...createEmptyPlaybook(), description: "é".repeat(400) }, playbook))
        .rejects.toThrow(InputLimitError);
      expect(await fs.readFile(playbook, "utf8")).toBe(original);
      await fs.appendFile(playbook, " ");
      await expect(loadPlaybook(playbook)).rejects.toThrow(InputLimitError);
    });
  });

  it("leaves committed bytes intact if the atomic replacement is interrupted", async () => {
    await withLimitsHome(async ({ playbook, writeConfig }) => {
      await writeConfig({ playbookLimits: { maxNodes: 500_000 } });
      const original = yaml.stringify({ ...createEmptyPlaybook(), bullets: [createTestBullet({ id: "keep-original" })] });
      await fs.writeFile(playbook, original);
      const draft = await loadPlaybook(playbook);
      draft.bullets.push(createTestBullet({ id: "not-committed" }));
      const realRename = fs.rename.bind(fs);
      const rename = spyOn(fs, "rename").mockImplementation(async (from, to) => {
        if (String(to) === playbook) throw Object.assign(new Error("simulated interruption before rename"), { code: "EIO" });
        return realRename(from, to);
      });
      try {
        await expect(savePlaybook(draft, playbook)).rejects.toThrow("simulated interruption");
        expect(await fs.readFile(playbook, "utf8")).toBe(original);
        expect((await loadPlaybook(playbook)).bullets.map(bullet => bullet.id)).toEqual(["keep-original"]);
      } finally {
        rename.mockRestore();
      }
    });
  });

  it("does not relax depth, mapping-width, cycle or YAML alias protections", async () => {
    await withLimitsHome(async ({ writeConfig, playbook }) => {
      await writeConfig({ playbookLimits: { maxNodes: 2_000_000, maxBytes: 64 * 1024 * 1024, maxArrayLength: 100_000 } });
      const limits = await resolvePlaybookInputLimits(playbook);
      expect(limits.maxDepth).toBe(PLAYBOOK_INPUT_LIMITS.maxDepth);
      expect(limits.maxObjectKeys).toBe(PLAYBOOK_INPUT_LIMITS.maxObjectKeys);
      let nested: unknown = null;
      for (let i = 0; i <= PLAYBOOK_INPUT_LIMITS.maxDepth; i++) nested = [nested];
      expect(() => assertInputLimits(nested, limits, "depth")).toThrow(InputLimitError);
      const keys = Object.fromEntries(Array.from({ length: PLAYBOOK_INPUT_LIMITS.maxObjectKeys + 1 }, (_, index) => [`k${index}`, 1]));
      expect(() => assertInputLimits(keys, limits, "mapping")).toThrow(InputLimitError);
      expect(() => parseYamlInput("a: &cycle [*cycle]", limits, "cycle")).toThrow(InputLimitError);
      expect(() => parseYamlInput(`a: &a [1, 2]\nb: [${Array(101).fill("*a").join(",")}]`, limits, "aliases"))
        .toThrow(InputLimitError);
    });
  });

  it("keeps CLI import strict even when the personal playbook has a larger budget", async () => {
    await withLimitsHome(async ({ directory, writeConfig, playbook }) => {
      await writeConfig({ playbookLimits: { maxNodes: 500_000 } });
      const initial = yaml.stringify({ ...createEmptyPlaybook(), bullets: [createTestBullet({ id: "keep-personal" })] });
      await fs.writeFile(playbook, initial);
      const imported = path.join(directory, "shared.yaml");
      await fs.writeFile(imported, JSON.stringify({
        ...createEmptyPlaybook(),
        extension: Array.from({ length: 500 }, () => Array(500).fill(0)),
      }));
      const result = spawnSync(process.execPath, [CLI, "playbook", "import", imported, "--json"], {
        cwd: directory, env: { ...process.env }, encoding: "utf8", timeout: 30_000,
      });
      expect(result.status).toBe(2);
      const output = JSON.parse(result.stdout);
      expect(output.success).toBe(false);
      expect(result.stdout).toContain("200000");
      expect(await fs.readFile(playbook, "utf8")).toBe(initial);
    });
  }, 30_000);
});
