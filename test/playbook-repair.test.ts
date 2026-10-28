import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import yaml from "yaml";
import { InputLimitError, PLAYBOOK_INPUT_LIMITS } from "../src/input-limits.js";
import {
  createEmptyPlaybook,
  loadPlaybook,
  PLAYBOOK_REPAIR_INPUT_LIMITS,
  repairPlaybookEmbeddings,
} from "../src/playbook.js";
import { createTestBullet } from "./helpers/factories.js";
import { withTempDir } from "./helpers/temp.js";

const timestamp = "2026-10-28T12:00:00.000Z";
const realOpen = fs.open.bind(fs);
const realWriteFile = fs.writeFile.bind(fs);
const realRename = fs.rename.bind(fs);
const restoreSpies: Array<() => unknown> = [];

function rememberSpy<T extends { mockRestore(): unknown }>(spy: T): T {
  restoreSpies.push(() => spy.mockRestore());
  return spy;
}

afterEach(() => {
  while (restoreSpies.length) restoreSpies.pop()!();
});

function legacyState() {
  return {
    ...createEmptyPlaybook("preserve-legacy-state"),
    schema_version: 1,
    description: "Keep this description and its schema version.",
    metadata: {
      createdAt: timestamp,
      lastReflection: timestamp,
      totalReflections: 13,
      totalSessionsProcessed: 42,
      extension: { checkpoint: "9007199254740993", embedding: { keep: "metadata" } },
    },
    deprecatedPatterns: [{
      pattern: "An older pattern",
      deprecatedAt: timestamp,
      reason: "Keep its history",
      replacement: "Use the replacement",
      extension: { reviewed: true },
    }],
    extension: {
      values: [null, false, -0, 0.125, "No", "2026-10-28", "漢字 🍀"],
      embedding: [8, 9],
    },
    bullets: [
      {
        ...createTestBullet({
          id: "b-z",
          content: "First learned rule: preserve café and 漢字.\n  Keep indentation.\n",
          category: "recovery",
          state: "active",
          maturity: "proven",
          createdAt: timestamp,
          updatedAt: timestamp,
          helpfulCount: 7,
          harmfulCount: 2,
          sourceSessions: ["/sessions/first.jsonl", "/sessions/second.jsonl"],
          sourceAgents: ["claude", "codex"],
          tags: ["recovery", "history"],
          pinned: true,
          pinnedReason: "An explicit user decision",
        }),
        feedbackEvents: [{
          type: "helpful",
          timestamp,
          sessionPath: "/sessions/first.jsonl",
          context: "Preserve the original feedback.",
          decayedValue: 0.75,
          outcomeId: "outcome-original",
          transcriptEvidenceKeys: ["te1:" + "a".repeat(64)],
          extension: { evidence: ["one", "two"], embedding: [6, 7] },
        }],
        embedding: [0.125, -0.25, 0.5],
        extension: { annotation: "An unknown bullet field", embedding: [4, 5] },
      },
      createTestBullet({
        id: "b-a",
        content: "A rule without an inline embedding.",
        createdAt: timestamp,
        updatedAt: timestamp,
        deprecated: true,
        deprecationReason: "Keep retired rules too",
        replacedBy: "b-z",
      }),
      {
        ...createTestBullet({
          // Migration must preserve order and even existing duplicate IDs.
          id: "b-z",
          content: "Another rule with an existing duplicate ID.",
          createdAt: timestamp,
          updatedAt: timestamp,
        }),
        embedding: [],
      },
    ],
  };
}

function legacyYaml(): string {
  return yaml.stringify(legacyState(), { aliasDuplicateObjects: false });
}

type Fixture = { directory: string; file: string; original: Buffer<ArrayBuffer> };

async function withFixture(
  run: (fixture: Fixture) => Promise<void>,
  content: string | Buffer = legacyYaml(),
): Promise<void> {
  await withTempDir("playbook-repair-safety", async (directory) => {
    const file = path.join(directory, "playbook.yaml");
    const original = Buffer.isBuffer(content) ? Buffer.from(content) : Buffer.from(content, "utf8");
    await fs.writeFile(file, original, { mode: 0o640 });
    await run({ directory, file, original });
  });
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function expectNoChanges(fixture: Fixture): Promise<void> {
  expect(await fs.readFile(fixture.file)).toEqual(fixture.original);
  expect(await fs.readdir(fixture.directory)).toEqual(["playbook.yaml"]);
}

async function getOnlyBackup(directory: string): Promise<string> {
  const entries = await fs.readdir(directory);
  const backups = entries.filter((entry) => entry.includes(".backup.strip-embeddings."));
  expect(backups).toHaveLength(1);
  expect(entries.filter((entry) => entry.includes(".repair.") || entry.endsWith(".lock.d"))).toEqual([]);
  expect(entries).toHaveLength(2);
  return path.join(directory, backups[0]);
}

async function captureRepairFailure(file: string): Promise<Error> {
  let failure: unknown;
  try {
    await repairPlaybookEmbeddings(file);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  return failure as Error;
}

describe("trusted local playbook repair: preservation", () => {
  it("preserves every non-embedding field, bullet order, duplicate IDs, and feedback", async () => {
    await withFixture(async ({ directory, file, original }) => {
      const expected = yaml.parse(original.toString("utf8"));
      delete expected.bullets[0].embedding;
      delete expected.bullets[2].embedding;

      const result = await repairPlaybookEmbeddings(file);
      const repairedBytes = await fs.readFile(file);
      expect(yaml.parse(repairedBytes.toString("utf8"))).toEqual(expected);
      expect(result).toMatchObject({
        path: file,
        dryRun: false,
        changed: true,
        wouldChange: true,
        bulletCount: 3,
        embeddingsRemoved: 2,
        preservationVerified: true,
        originalBytes: original.length,
        repairedBytes: repairedBytes.length,
        bytesSaved: original.length - repairedBytes.length,
        sha256Before: sha256(original),
        sha256After: sha256(repairedBytes),
      });
      expect(result.backupPath).toBe(await getOnlyBackup(directory));
      expect(await fs.readFile(result.backupPath!)).toEqual(original);
      if (process.platform !== "win32") {
        expect((await fs.stat(result.backupPath!)).mode & 0o777).toBe(0o600);
        expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
      }
      const loaded = await loadPlaybook(file);
      expect(loaded.bullets.map((bullet) => bullet.id)).toEqual(["b-z", "b-a", "b-z"]);
      expect(loaded.bullets[0].feedbackEvents[0].outcomeId).toBe("outcome-original");
      expect(loaded.metadata.totalSessionsProcessed).toBe(42);
      expect(loaded.schema_version).toBe(1);
    });
  });

  it("does not remove fields from aliases outside bullets or from nested extension fields", async () => {
    const bullet = {
      ...createTestBullet({
        id: "b-aliased",
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
      embedding: [0.25, 0.5],
      extension: { embedding: [3, 4] },
    };
    const state = {
      ...createEmptyPlaybook(),
      snapshot: bullet,
      bullets: [bullet, bullet],
    };
    const source = yaml.stringify(state);
    expect(source).toContain("*");
    await withFixture(async ({ file, original }) => {
      const result = await repairPlaybookEmbeddings(file);
      const repaired = yaml.parse(await fs.readFile(file, "utf8"));
      expect(result.embeddingsRemoved).toBe(2);
      expect(repaired.snapshot).toEqual(yaml.parse(original.toString("utf8")).snapshot);
      expect(repaired.snapshot.embedding).toEqual([0.25, 0.5]);
      expect(repaired.bullets).toHaveLength(2);
      for (const item of repaired.bullets) {
        expect(Object.hasOwn(item, "embedding")).toBe(false);
        expect(item.extension.embedding).toEqual([3, 4]);
      }
    }, source);
  });

  it("previews without creating locks, backups, temporary files, or any writes", async () => {
    await withFixture(async (fixture) => {
      const before = await fs.stat(fixture.file);
      const mkdir = rememberSpy(spyOn(fs, "mkdir"));
      const writeFile = rememberSpy(spyOn(fs, "writeFile"));
      const rename = rememberSpy(spyOn(fs, "rename"));

      const preview = await repairPlaybookEmbeddings(fixture.file, { dryRun: true });
      expect(preview).toMatchObject({
        dryRun: true, changed: false, wouldChange: true,
        embeddingsRemoved: 2, bulletCount: 3, backupPath: null,
        preservationVerified: true, sha256Before: sha256(fixture.original),
      });
      expect(preview.repairedBytes).toBeLessThan(preview.originalBytes);
      expect(preview.sha256After).not.toBe(preview.sha256Before);
      expect(mkdir).not.toHaveBeenCalled();
      expect(writeFile).not.toHaveBeenCalled();
      expect(rename).not.toHaveBeenCalled();
      expect((await fs.stat(fixture.file)).mtimeMs).toBe(before.mtimeMs);
      await expectNoChanges(fixture);
    });
  });

  it("keeps normal-sized embedding-free files byte-exact, including comments and a BOM", async () => {
    const source = Buffer.from("\ufeff# Retain this comment.\n" + yaml.stringify(createEmptyPlaybook()));
    await withFixture(async (fixture) => {
      const before = await fs.stat(fixture.file);
      for (const dryRun of [true, false]) {
        const result = await repairPlaybookEmbeddings(fixture.file, { dryRun });
        expect(result).toMatchObject({
          dryRun, changed: false, wouldChange: false, embeddingsRemoved: 0,
          backupPath: null, bytesSaved: 0, originalBytes: source.length, repairedBytes: source.length,
          sha256Before: sha256(source), sha256After: sha256(source),
        });
        await expectNoChanges(fixture);
      }
      const after = await fs.stat(fixture.file);
      expect(after.ino).toBe(before.ino);
      expect(after.mtimeMs).toBe(before.mtimeMs);
    }, source);
  });

  it("is idempotent and does not overwrite or add to the first verified backup", async () => {
    await withFixture(async ({ directory, file, original }) => {
      const first = await repairPlaybookEmbeddings(file);
      const installed = await fs.readFile(file);
      const second = await repairPlaybookEmbeddings(file);
      expect(second).toMatchObject({ changed: false, wouldChange: false, backupPath: null, bytesSaved: 0 });
      expect(await fs.readFile(file)).toEqual(installed);
      expect(await getOnlyBackup(directory)).toBe(first.backupPath!);
      expect(await fs.readFile(first.backupPath!)).toEqual(original);
    });
  });

  it("preserves quoted numeric keys and large numeric strings exactly", async () => {
    const source = legacyYaml() + "quotedKeys: { '1.0': one, '0x10': sixteen, '9007199254740993': large }\n";
    await withFixture(async ({ file }) => {
      await repairPlaybookEmbeddings(file);
      expect(yaml.parse(await fs.readFile(file, "utf8")).quotedKeys).toEqual({
        "1.0": "one", "0x10": "sixteen", "9007199254740993": "large",
      });
    }, source);
  });
});

describe("trusted local playbook repair: rejected inputs", () => {
  const invalidCases: Array<[string, () => string | Buffer]> = [
    ["invalid YAML", () => "bullets: [\n"],
    ["invalid UTF-8", () => Buffer.concat([Buffer.from(legacyYaml()), Buffer.from([0xff])])],
    ["invalid bullet schema", () => yaml.stringify({
      ...createEmptyPlaybook(), bullets: [{ id: "b-invalid", embedding: [1] }],
    })],
    ["missing explicit bullet array", () => yaml.stringify({ metadata: { createdAt: timestamp } })],
    ["non-object bullet", () => yaml.stringify({ ...createEmptyPlaybook(), bullets: [null] })],
    ["non-numeric embedding", () => yaml.stringify({
      ...createEmptyPlaybook(), bullets: [{ ...createTestBullet(), embedding: [1, "not a vector"] }],
    })],
    ["unsafe integer", () => legacyYaml() + "unsafe: 9007199254740993\n"],
    ["non-finite learned value", () => legacyYaml() + "nonfinite: .nan\n"],
    ["unknown YAML tag", () => legacyYaml() + "tagged: !custom keep\n"],
    ["explicit timestamp tag", () => legacyYaml() + "tagged: !!timestamp 2026-10-28T12:00:00Z\n"],
    ["complex mapping key", () => legacyYaml() + "complex:\n  ? [one, two]\n  : keep\n"],
    ["numeric mapping key", () => legacyYaml() + "numeric: {1.0: one}\n"],
    ["hexadecimal mapping key", () => legacyYaml() + "numeric: {0x10: sixteen}\n"],
    ["boolean mapping key", () => legacyYaml() + "boolean: {true: affirmative}\n"],
    ["coercion-colliding keys", () => legacyYaml() + "collision: {1: one, '1': other}\n"],
    ["duplicate string keys", () => legacyYaml() + "collision: {field: one, field: other}\n"],
    ["cyclic alias", () => legacyYaml() + "cycle: &cycle {self: *cycle}\n"],
    ["excessive aliases", () => legacyYaml() +
      "a: &a [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]\n" +
      "b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]\n" +
      "c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]\n"],
    ["multiple YAML documents", () => legacyYaml() + "---\n" + legacyYaml()],
  ];

  for (const [name, content] of invalidCases) {
    it("refuses " + name + " without changing or backing up the source", async () => {
      await withFixture(async (fixture) => {
        await expect(repairPlaybookEmbeddings(fixture.file)).rejects.toThrow();
        await expectNoChanges(fixture);
      }, content());
    });
  }

  it("retains source bounds on individual arrays even when values are derived", async () => {
    const source = JSON.stringify({
      ...createEmptyPlaybook(),
      bullets: [{ ...createTestBullet(), embedding: Array(PLAYBOOK_REPAIR_INPUT_LIMITS.maxArrayLength + 1).fill(0) }],
    });
    await withFixture(async (fixture) => {
      await expect(repairPlaybookEmbeddings(fixture.file)).rejects.toBeInstanceOf(InputLimitError);
      await expectNoChanges(fixture);
    }, source);
  });

  it("rejects excessive nesting before conversion or replacement", async () => {
    let nested: unknown = "leaf";
    for (let i = 0; i <= PLAYBOOK_REPAIR_INPUT_LIMITS.maxDepth; i++) nested = { child: nested };
    const source = JSON.stringify({ ...legacyState(), nested });
    await withFixture(async (fixture) => {
      await expect(repairPlaybookEmbeddings(fixture.file)).rejects.toBeInstanceOf(InputLimitError);
      await expectNoChanges(fixture);
    }, source);
  });

  it("rejects a source one byte over the 64 MiB ceiling before reading its contents", async () => {
    await withTempDir("playbook-repair-limit", async (directory) => {
      const file = path.join(directory, "playbook.yaml");
      const sparse = await realOpen(file, "wx");
      await sparse.truncate(PLAYBOOK_REPAIR_INPUT_LIMITS.maxBytes + 1);
      await sparse.close();
      let reads = 0;
      rememberSpy(spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        const handle = await realOpen(...args);
        if (String(args[0]) === file) {
          rememberSpy(spyOn(handle, "read").mockImplementation(async () => {
            reads++;
            throw new Error("Oversized source must never be read");
          }));
        }
        return handle;
      }));
      await expect(repairPlaybookEmbeddings(file, { dryRun: true })).rejects.toBeInstanceOf(InputLimitError);
      expect(reads).toBe(0);
      expect((await fs.stat(file)).size).toBe(PLAYBOOK_REPAIR_INPUT_LIMITS.maxBytes + 1);
      expect(await fs.readdir(directory)).toEqual(["playbook.yaml"]);
    });
  });

  it("accepts a trusted source at exactly the repair byte ceiling when stripping makes it readable", async () => {
    const base = legacyYaml();
    const source = base + "#" +
      " ".repeat(PLAYBOOK_REPAIR_INPUT_LIMITS.maxBytes - Buffer.byteLength(base) - 2) + "\n";
    expect(Buffer.byteLength(source)).toBe(PLAYBOOK_REPAIR_INPUT_LIMITS.maxBytes);
    await withFixture(async (fixture) => {
      const result = await repairPlaybookEmbeddings(fixture.file, { dryRun: true });
      expect(result.originalBytes).toBe(PLAYBOOK_REPAIR_INPUT_LIMITS.maxBytes);
      expect(result.repairedBytes).toBeLessThan(PLAYBOOK_INPUT_LIMITS.maxBytes);
      expect(result.embeddingsRemoved).toBe(2);
      expect(result.preservationVerified).toBe(true);
      await expectNoChanges(fixture);
    }, source);
  });

  it("refuses to replace a playbook whose surviving learned state still exceeds ordinary limits", async () => {
    const source = JSON.stringify({
      ...legacyState(), description: "x".repeat(PLAYBOOK_INPUT_LIMITS.maxBytes),
    });
    await withFixture(async (fixture) => {
      await expect(repairPlaybookEmbeddings(fixture.file)).rejects.toBeInstanceOf(InputLimitError);
      await expectNoChanges(fixture);
    }, source);
  });

  it("counts a BOM against the ordinary byte ceiling even for an embedding-free no-op", async () => {
    const base = yaml.stringify(createEmptyPlaybook());
    const bounded = base + "#" +
      " ".repeat(PLAYBOOK_INPUT_LIMITS.maxBytes - Buffer.byteLength(base) - 2) + "\n";
    expect(Buffer.byteLength(bounded)).toBe(PLAYBOOK_INPUT_LIMITS.maxBytes);
    await withFixture(async (fixture) => {
      await expect(repairPlaybookEmbeddings(fixture.file, { dryRun: true })).rejects.toBeInstanceOf(InputLimitError);
      await expectNoChanges(fixture);
    }, Buffer.from("\ufeff" + bounded));
  });
});

describe("trusted local playbook repair: filesystem targets", () => {
  const posixIt = process.platform === "win32" ? it.skip : it;

  posixIt("rejects a final symlink and preserves its target", async () => {
    await withFixture(async (fixture) => {
      const link = path.join(fixture.directory, "linked.yaml");
      await fs.symlink(fixture.file, link);
      await expect(repairPlaybookEmbeddings(link)).rejects.toThrow("regular local file");
      expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
      expect(await fs.readFile(fixture.file)).toEqual(fixture.original);
      expect((await fs.readdir(fixture.directory)).sort()).toEqual(["linked.yaml", "playbook.yaml"]);
    });
  });

  it("rejects hard links without changing either name", async () => {
    await withFixture(async (fixture) => {
      const link = path.join(fixture.directory, "hard-link.yaml");
      await fs.link(fixture.file, link);
      await expect(repairPlaybookEmbeddings(fixture.file)).rejects.toThrow("hard links");
      expect(await fs.readFile(fixture.file)).toEqual(fixture.original);
      expect(await fs.readFile(link)).toEqual(fixture.original);
      expect((await fs.readdir(fixture.directory)).sort()).toEqual(["hard-link.yaml", "playbook.yaml"]);
    });
  });

  posixIt("rejects a FIFO without waiting for a writer", async () => {
    await withTempDir("playbook-repair-fifo", async (directory) => {
      const file = path.join(directory, "playbook.yaml");
      const result = spawnSync("mkfifo", [file], { encoding: "utf8", timeout: 5000 });
      expect(result.status).toBe(0);
      await expect(repairPlaybookEmbeddings(file)).rejects.toThrow("regular local file");
      expect((await fs.lstat(file)).isFIFO()).toBe(true);
      expect(await fs.readdir(directory)).toEqual(["playbook.yaml"]);
    });
  });

  it("rejects a directory without creating a playbook or leaving a lock", async () => {
    await withTempDir("playbook-repair-directory", async (directory) => {
      const target = path.join(directory, "playbook.yaml");
      await fs.mkdir(target);
      await expect(repairPlaybookEmbeddings(target)).rejects.toThrow("regular local file");
      expect(await fs.readdir(target)).toEqual([]);
      expect(await fs.readdir(directory)).toEqual(["playbook.yaml"]);
    });
  });
});

type Fault =
  | "backup-create" | "backup-write" | "backup-sync" | "backup-verify"
  | "directory-sync" | "temporary-create" | "temporary-write"
  | "temporary-sync" | "temporary-verify";

function injectIoFailure(fault: Fault, directory: string): () => number {
  let failures = 0;
  const fail = () => {
    failures++;
    throw new Error("injected " + fault);
  };
  rememberSpy(spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const opened = String(args[0]);
    const creating = args[1] === "wx";
    const backup = opened.includes(".backup.strip-embeddings.");
    const temporary = opened.includes(".repair.") && opened.endsWith(".tmp");
    if (creating && ((backup && fault === "backup-create") || (temporary && fault === "temporary-create"))) {
      fail();
    }
    if (!creating && ((backup && fault === "backup-verify") || (temporary && fault === "temporary-verify"))) {
      failures++;
      await realWriteFile(opened, backup ? "corrupt-backup" : "corrupt-temporary");
    }
    const handle: FileHandle = await realOpen(...args);
    if (creating && ((backup && fault === "backup-write") || (temporary && fault === "temporary-write"))) {
      rememberSpy(spyOn(handle, "writeFile").mockImplementation(async () => {
        await handle.write(Buffer.from(backup ? "partial-backup" : "partial-temporary"));
        fail();
      }));
    }
    if ((creating && ((backup && fault === "backup-sync") || (temporary && fault === "temporary-sync"))) ||
        (opened === directory && fault === "directory-sync")) {
      rememberSpy(spyOn(handle, "sync").mockImplementation(async () => fail()));
    }
    return handle;
  }));
  return () => failures;
}

describe("trusted local playbook repair: transactional failures", () => {
  const faults: Fault[] = [
    "backup-create", "backup-write", "backup-sync", "backup-verify",
    "temporary-create", "temporary-write", "temporary-sync", "temporary-verify",
  ];
  if (process.platform !== "win32") faults.push("directory-sync");

  for (const fault of faults) {
    it("preserves the source and cleans staged files after " + fault + " fails", async () => {
      await withFixture(async (fixture) => {
        const failures = injectIoFailure(fault, fixture.directory);
        const failure = await captureRepairFailure(fixture.file);
        expect(failures()).toBe(1);
        expect(failure.message).toContain("Repair aborted");
        expect(await fs.readFile(fixture.file)).toEqual(fixture.original);
        if (fault === "backup-create") {
          await expectNoChanges(fixture);
          return;
        }
        const backup = await getOnlyBackup(fixture.directory);
        if (fault === "backup-write") {
          expect(await fs.readFile(backup, "utf8")).toBe("partial-backup");
        } else if (fault === "backup-verify") {
          expect(await fs.readFile(backup, "utf8")).toBe("corrupt-backup");
        } else {
          expect(await fs.readFile(backup)).toEqual(fixture.original);
        }
        expect(failure.message).toContain(backup);
        expect(failure.message).toContain(
          fault.startsWith("temporary-") ? "verified original backup" : "backup file (may be incomplete)",
        );
      });
    });
  }

  it("retains a verified original backup and source when replacement rename fails", async () => {
    await withFixture(async (fixture) => {
      let attempts = 0;
      rememberSpy(spyOn(fs, "rename").mockImplementation(async (from, to) => {
        attempts++;
        expect(String(from)).toContain(".repair.");
        expect(String(to)).toBe(fixture.file);
        throw new Error("injected replacement failure");
      }));
      const failure = await captureRepairFailure(fixture.file);
      expect(attempts).toBe(1);
      expect(failure.message).toContain("injected replacement failure");
      expect(failure.message).toContain("verified original backup");
      expect(await fs.readFile(fixture.file)).toEqual(fixture.original);
      expect(await fs.readFile(await getOnlyBackup(fixture.directory))).toEqual(fixture.original);
    });
  });

  const posixIt = process.platform === "win32" ? it.skip : it;
  posixIt("reports installation accurately if the final directory flush fails", async () => {
    await withFixture(async (fixture) => {
      let directoryFlushes = 0;
      rememberSpy(spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        const handle = await realOpen(...args);
        if (String(args[0]) === fixture.directory) {
          const sync = handle.sync.bind(handle);
          rememberSpy(spyOn(handle, "sync").mockImplementation(async () => {
            if (++directoryFlushes === 2) throw new Error("injected final directory flush");
            await sync();
          }));
        }
        return handle;
      }));
      const failure = await captureRepairFailure(fixture.file);
      expect(directoryFlushes).toBe(2);
      expect(failure.message).toContain("Repaired file installed, but final directory flush failed");
      expect(failure.message).toContain("verified original backup");
      const installed = await loadPlaybook(fixture.file);
      expect(installed.bullets).toHaveLength(3);
      expect(installed.bullets.every((bullet) => bullet.embedding === undefined)).toBe(true);
      expect(await fs.readFile(await getOnlyBackup(fixture.directory))).toEqual(fixture.original);
    });
  });

  it("refuses to overwrite a non-cooperating writer's edit after the backup", async () => {
    await withFixture(async (fixture) => {
      const changed = Buffer.concat([fixture.original, Buffer.from("\n# External writer added this.\n")]);
      let edits = 0;
      rememberSpy(spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        if (args[1] === "wx" && String(args[0]).includes(".repair.")) {
          edits++;
          await realWriteFile(fixture.file, changed);
        }
        return realOpen(...args);
      }));
      const failure = await captureRepairFailure(fixture.file);
      expect(edits).toBe(1);
      expect(failure.message).toContain("Playbook changed during repair");
      expect(await fs.readFile(fixture.file)).toEqual(changed);
      expect(await fs.readFile(await getOnlyBackup(fixture.directory))).toEqual(fixture.original);
    });
  });

  it("detects replacement of the source inode even when its bytes are identical", async () => {
    await withFixture(async (fixture) => {
      const before = await fs.stat(fixture.file);
      let replacements = 0;
      rememberSpy(spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        if (args[1] === "wx" && String(args[0]).includes(".repair.")) {
          replacements++;
          const alternate = path.join(fixture.directory, "external.yaml");
          await realWriteFile(alternate, fixture.original);
          await realRename(alternate, fixture.file);
        }
        return realOpen(...args);
      }));
      const failure = await captureRepairFailure(fixture.file);
      expect(replacements).toBe(1);
      expect(failure.message).toContain("Playbook changed during repair");
      expect((await fs.stat(fixture.file)).ino).not.toBe(before.ino);
      expect(await fs.readFile(fixture.file)).toEqual(fixture.original);
      expect(await fs.readFile(await getOnlyBackup(fixture.directory))).toEqual(fixture.original);
    });
  });
});
