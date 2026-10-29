import { describe, expect, spyOn, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { PLAYBOOK_INPUT_LIMITS } from "../src/input-limits.js";
import { withLock } from "../src/lock.js";
import { loadPlaybook, recordReflectionRun, savePlaybook } from "../src/playbook.js";
import {
  pendingOutcomeRegistryPath, recoverReflectionCommit, REFLECTION_COMMIT_LIMITS, ReflectionCommit, reflectionCommitPendingPath,
} from "../src/reflection-commit.js";
import { getProcessedLogPath, ProcessedLog } from "../src/tracking.js";
import type { ProcessedEntry } from "../src/types.js";
import { createBullet, createTestPlaybook } from "./helpers/factories.js";
import { type TestEnv, withTempCassHome } from "./helpers/temp.js";

interface Fixture {
  env: TestEnv;
  repoPath: string;
  logPath: string;
  entry: ProcessedEntry;
  prepare: () => Promise<ReflectionCommit>;
}

async function withFixture(check: (fixture: Fixture) => Promise<void>): Promise<void> {
  await withTempCassHome(async env => {
    const repoPath = path.join(env.home, "project", ".cass", "playbook.yaml");
    await savePlaybook(createTestPlaybook([createBullet({
      id: "b-global111", content: "Check command exit status before accepting a result.",
    })]), env.playbookPath);
    await savePlaybook(createTestPlaybook([createBullet({
      id: "b-repo222", content: "Run project-specific migration checks before release.", scope: "workspace",
    })]), repoPath);
    const logPath = getProcessedLogPath();
    const sessionPath = path.join(env.home, "session.jsonl");
    const entry: ProcessedEntry = {
      sessionPath, processedAt: "2026-10-28T12:00:00.000Z", deltasGenerated: 2,
      recordCount: 4, lastRecordHash: "frozen-transcript-boundary",
      pendingOutcomes: [{
        id: "outcome-frozen-before-commit", sessionId: sessionPath, outcome: "success",
        rulesUsed: ["b-repo222"], recordedAt: "2026-10-28T12:00:00.000Z",
        globalPlaybookPath: env.playbookPath,
        workspace: path.dirname(path.dirname(repoPath)), path: path.join(path.dirname(repoPath), "outcomes.jsonl"),
        ruleTargets: [{ ruleId: "b-repo222", playbookPath: repoPath }],
      }],
    };
    const prepare = async () => {
      const transaction = await ReflectionCommit.create(env.playbookPath, logPath, [entry], { sessionsProcessed: 1 });
      const global = await transaction.loadPlaybook(env.playbookPath);
      global.bullets[0]!.content = "Inspect both structured errors and process exit status before accepting reflection success.";
      recordReflectionRun(global, 1);
      await transaction.savePlaybook(global, env.playbookPath, { updateLastReflection: true });
      const repo = await transaction.loadPlaybook(repoPath);
      repo.bullets[0]!.helpfulCount++;
      repo.bullets[0]!.feedbackEvents.push({
        type: "helpful", timestamp: entry.processedAt, sessionPath,
      });
      await transaction.savePlaybook(repo, repoPath, { updateLastReflection: true });
      return transaction;
    };
    await check({ env, repoPath, logPath, entry, prepare });
  }, "reflection-commit");
}

async function publishBeforeFirstWrite(fixture: Fixture, transaction: ReflectionCommit): Promise<void> {
  const rename = fs.rename;
  const interruption = spyOn(fs, "rename").mockImplementation(async (source, destination) => {
    if (String(destination) === fixture.env.playbookPath) throw new Error("injected first live rename failure");
    return rename(source, destination);
  });
  try {
    await expect(transaction.commit()).rejects.toThrow("injected first live rename failure");
  } finally {
    interruption.mockRestore();
  }
  expect(await fs.stat(reflectionCommitPendingPath(fixture.env.playbookPath))).toBeDefined();
}

async function pendingData(globalPath: string) {
  const pending = reflectionCommitPendingPath(globalPath);
  const manifest = JSON.parse(await fs.readFile(pending, "utf8"));
  const directory = path.join(path.dirname(pending), `${path.basename(pending, ".pending.json")}.${manifest.id}.stage`);
  return { pending, manifest, directory };
}

describe("prepared reflection commits", () => {
  test("stages accumulated changes and preserves extension state while stripping derived embeddings", async () => {
    await withFixture(async f => {
      const original = await loadPlaybook(f.env.playbookPath);
      Object.assign(original.metadata, { producerVersion: "legacy-producer" });
      Object.assign(original.bullets[0]!, { derivedFrom: ["b-prior"], producerEvidence: { retained: true }, embedding: [0.1, 0.2] });
      await savePlaybook(original, f.env.playbookPath);
      const globalBefore = await fs.readFile(f.env.playbookPath, "utf8");
      const repoBefore = await fs.readFile(f.repoPath, "utf8");
      await withLock(f.env.playbookPath, async () => {
        const transaction = await f.prepare();
        if (process.platform !== "win32") {
          const journalRoot = path.dirname(reflectionCommitPendingPath(f.env.playbookPath));
          expect((await fs.stat(journalRoot)).mode & 0o077).toBe(0);
        }
        const staged = await transaction.loadPlaybook(f.env.playbookPath);
        staged.bullets[0]!.tags.push("reviewed");
        staged.bullets[0]!.embedding = [0.3, 0.4];
        await transaction.savePlaybook(staged, f.env.playbookPath);
        expect(await fs.readFile(f.env.playbookPath, "utf8")).toBe(globalBefore);
        expect(await fs.readFile(f.repoPath, "utf8")).toBe(repoBefore);
        expect(await Bun.file(reflectionCommitPendingPath(f.env.playbookPath)).exists()).toBe(false);
        const committed = await transaction.commit();
        expect(committed.sessionsProcessed).toBe(1);
        const saved = await loadPlaybook(f.env.playbookPath);
        expect(saved.metadata).toMatchObject({
          totalReflections: 1, totalSessionsProcessed: 1, producerVersion: "legacy-producer",
          reflectionCommit: { owner: f.env.playbookPath, id: transaction.id },
        });
        expect(saved.bullets[0]).toMatchObject({
          id: "b-global111", derivedFrom: ["b-prior"], producerEvidence: { retained: true }, tags: ["reviewed"],
        });
        expect(saved.bullets[0]!.embedding).toBeUndefined();
        const ledger = new ProcessedLog(f.logPath);
        await ledger.load();
        expect(ledger.hasCommittedBatch(f.env.playbookPath, transaction.id)).toBe(true);
        expect(ledger.get(f.entry.sessionPath)?.pendingOutcomes).toEqual(f.entry.pendingOutcomes);
      });
      expect(await recoverReflectionCommit(f.env.playbookPath)).toBeNull();
      const registryPath = pendingOutcomeRegistryPath(f.env.playbookPath);
      expect(await fs.readdir(path.dirname(registryPath))).toEqual([path.basename(registryPath)]);
      expect(JSON.parse(await fs.readFile(registryPath, "utf8"))).toMatchObject({
        owner: f.env.playbookPath, logs: [f.logPath],
      });
    });
  });

  test.skipIf(process.platform === "win32")("directory aliases share recovery identity while final symlinks remain separate addresses", async () => {
    await withFixture(async f => {
      const aliasDirectory = path.join(f.env.home, "state-alias");
      await fs.symlink(f.env.cassMemoryDir, aliasDirectory, "dir");
      const aliasPath = path.join(aliasDirectory, "playbook.yaml");
      const aliasLog = path.join(aliasDirectory, "reflections", "global.processed.log");
      const aliasSession = path.join(aliasDirectory, "session.jsonl");
      expect(reflectionCommitPendingPath(aliasPath)).toBe(reflectionCommitPendingPath(f.env.playbookPath));
      let id = "";
      await withLock(aliasPath, async () => {
        const transaction = await ReflectionCommit.create(aliasPath, aliasLog,
          [{ ...f.entry, sessionPath: aliasSession, pendingOutcomes: [] }], { sessionsProcessed: 1 });
        id = transaction.id;
        const global = await transaction.loadPlaybook(aliasPath);
        recordReflectionRun(global, 1);
        await transaction.savePlaybook(global, aliasPath);
        await publishBeforeFirstWrite(f, transaction);
      });
      await recoverReflectionCommit(f.env.playbookPath);
      const log = new ProcessedLog(f.logPath);
      await log.load();
      expect(log.hasCommittedBatch(aliasPath, id)).toBe(true);
      expect(log.hasCommittedBatch(f.env.playbookPath, id)).toBe(true);
      // Session keys retain their existing lexical normalization semantics.
      expect(log.get(aliasSession)?.recordCount).toBe(4);
      expect(log.get(path.join(f.env.cassMemoryDir, "session.jsonl"))).toBeUndefined();
      expect((await loadPlaybook(f.env.playbookPath)).metadata.totalReflections).toBe(1);

      const finalLink = path.join(f.env.cassMemoryDir, "alternate.yaml");
      await fs.symlink(f.env.playbookPath, finalLink);
      expect(reflectionCommitPendingPath(finalLink)).not.toBe(reflectionCommitPendingPath(f.env.playbookPath));
      const original = await fs.readFile(f.env.playbookPath, "utf8");
      await withLock(finalLink, async () => {
        const transaction = await ReflectionCommit.create(finalLink, f.logPath, []);
        const playbook = await transaction.loadPlaybook(finalLink);
        playbook.bullets[0]!.content = "This instruction belongs only to the replaced logical file address.";
        await transaction.savePlaybook(playbook, finalLink);
        await transaction.commit();
      });
      expect((await fs.lstat(finalLink)).isSymbolicLink()).toBe(false);
      expect(await fs.readFile(f.env.playbookPath, "utf8")).toBe(original);
      expect((await loadPlaybook(finalLink)).bullets[0]!.content).toContain("logical file address");
    });
  });

  test("cleans only recognized abandoned drafts for this owner before preparing another", async () => {
    await withFixture(async f => {
      await withLock(f.env.playbookPath, async () => {
        const abandoned = await f.prepare(); // Simulate a process exiting before publication.
        const pending = reflectionCommitPendingPath(f.env.playbookPath);
        const parent = path.dirname(pending);
        const key = path.basename(pending, ".pending.json");
        const draft = path.join(parent, `${key}.${abandoned.id}.stage`);
        await fs.writeFile(path.join(draft, "target-0.yaml.tmp.0123456789abcdef"), "incomplete private write");
        const foreignKey = crypto.createHash("sha256").update(f.repoPath).digest("hex");
        const foreign = path.join(parent, `${foreignKey}.${crypto.randomUUID()}.stage`);
        const unknown = path.join(parent, `${key}.${crypto.randomUUID()}.stage`);
        await fs.mkdir(foreign);
        await fs.mkdir(unknown);
        await fs.writeFile(path.join(foreign, "target-0.yaml"), "another owner's staged work");
        await fs.writeFile(path.join(unknown, "notes.txt"), "preserve unknown user files");
        await fs.writeFile(path.join(unknown, "target-0.yaml"), "preserve this directory as a whole");
        const link = path.join(parent, `${key}.${crypto.randomUUID()}.stage`);
        if (process.platform !== "win32") await fs.symlink(f.env.home, link, "dir");
        const replacement = await ReflectionCommit.create(f.env.playbookPath, f.logPath, [f.entry]);
        await expect(fs.stat(draft)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await fs.readFile(path.join(foreign, "target-0.yaml"), "utf8")).toBe("another owner's staged work");
        expect(await fs.readFile(path.join(unknown, "notes.txt"), "utf8")).toBe("preserve unknown user files");
        expect(await fs.readFile(path.join(unknown, "target-0.yaml"), "utf8")).toBe("preserve this directory as a whole");
        if (process.platform !== "win32") expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
        expect(await Bun.file(pending).exists()).toBe(false);
        expect((await loadPlaybook(f.env.playbookPath)).metadata.totalReflections).toBe(0);
        await replacement.abort();
      });
    });
  });

  test("bounded orphan inspection fails before removing any draft when the scan is too large", async () => {
    await withFixture(async f => {
      await withLock(f.env.playbookPath, async () => {
        const abandoned = await f.prepare();
        const pending = reflectionCommitPendingPath(f.env.playbookPath);
        const parent = path.dirname(pending);
        const draft = path.join(parent, `${path.basename(pending, ".pending.json")}.${abandoned.id}.stage`);
        const staged = await fs.readFile(path.join(draft, "target-0.yaml"), "utf8");
        for (let index = 0; index < REFLECTION_COMMIT_LIMITS.maxCleanupEntries; index++) {
          await fs.writeFile(path.join(parent, `unrelated-${index}`), "");
        }
        await expect(ReflectionCommit.create(f.env.playbookPath, f.logPath, [f.entry])).rejects.toThrow("cleanup scan exceeds");
        expect(await fs.readFile(path.join(draft, "target-0.yaml"), "utf8")).toBe(staged);
        expect(await Bun.file(pending).exists()).toBe(false);
        expect(await Bun.file(f.logPath).exists()).toBe(false);
      });
    });
  });

  test("a changed write target aborts before journal publication and preserves every live file", async () => {
    await withFixture(async f => {
      const globalBefore = await fs.readFile(f.env.playbookPath, "utf8");
      await withLock(f.env.playbookPath, async () => {
        const transaction = await f.prepare();
        await withLock(f.repoPath, async () => {
          const edited = await loadPlaybook(f.repoPath);
          edited.bullets[0]!.content = "An ordinary writer's newer instruction must survive.";
          await savePlaybook(edited, f.repoPath);
        });
        const repoEdited = await fs.readFile(f.repoPath, "utf8");
        await expect(transaction.commit()).rejects.toThrow("changed since preparation");
        expect(await fs.readFile(f.env.playbookPath, "utf8")).toBe(globalBefore);
        expect(await fs.readFile(f.repoPath, "utf8")).toBe(repoEdited);
        expect(await Bun.file(reflectionCommitPendingPath(f.env.playbookPath)).exists()).toBe(false);
        await transaction.abort();
      });
      expect(await fs.readdir(path.dirname(reflectionCommitPendingPath(f.env.playbookPath)))).toEqual([]);
    });
  });

  test("an unsaved read dependency cannot change between curation and publication", async () => {
    await withFixture(async f => {
      const globalBefore = await fs.readFile(f.env.playbookPath, "utf8");
      await withLock(f.env.playbookPath, async () => {
        const transaction = await ReflectionCommit.create(f.env.playbookPath, f.logPath, [f.entry]);
        await transaction.loadPlaybook(f.repoPath); // Deduplication inspected this file without modifying it.
        const global = await transaction.loadPlaybook(f.env.playbookPath);
        recordReflectionRun(global, 1);
        await transaction.savePlaybook(global, f.env.playbookPath);
        await withLock(f.repoPath, async () => {
          const edited = await loadPlaybook(f.repoPath);
          edited.bullets[0]!.content = "The repository rule changed after the curation decision.";
          await savePlaybook(edited, f.repoPath);
        });
        const repoEdited = await fs.readFile(f.repoPath, "utf8");
        await expect(transaction.commit()).rejects.toThrow("read dependency changed");
        expect(await fs.readFile(f.env.playbookPath, "utf8")).toBe(globalBefore);
        expect(await fs.readFile(f.repoPath, "utf8")).toBe(repoEdited);
        expect(await Bun.file(reflectionCommitPendingPath(f.env.playbookPath)).exists()).toBe(false);
        await transaction.abort();
      });
    });
  });

  test("a published journal survives abort and completes in a fresh process", async () => {
    await withFixture(async f => {
      let id = "";
      await withLock(f.env.playbookPath, async () => {
        const transaction = await f.prepare();
        id = transaction.id;
        await publishBeforeFirstWrite(f, transaction);
        await transaction.abort();
        expect(await fs.stat(reflectionCommitPendingPath(f.env.playbookPath))).toBeDefined();
        await expect(ReflectionCommit.create(f.env.playbookPath, f.logPath, [f.entry])).rejects.toThrow("pending reflection commit");
      });
      const modulePath = path.resolve(import.meta.dir, "../src/reflection-commit.ts");
      const child = Bun.spawn([process.execPath, "-e", `
import { recoverReflectionCommit } from ${JSON.stringify(modulePath)};
console.log(JSON.stringify(await recoverReflectionCommit(process.argv[1])));
`, f.env.playbookPath], {
        cwd: f.env.home, env: { ...process.env, HOME: f.env.home }, stdout: "pipe", stderr: "pipe",
      });
      const [status, output, errors] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]);
      expect(errors).toBe("");
      expect(status).toBe(0);
      expect(JSON.parse(output)).toEqual({ id, logPath: f.logPath, sessionsProcessed: 1 });
      const saved = await loadPlaybook(f.env.playbookPath);
      expect(saved.metadata.totalReflections).toBe(1);
      expect(saved.metadata.totalSessionsProcessed).toBe(1);
      expect((await loadPlaybook(f.repoPath)).bullets[0]!.helpfulCount).toBe(1);
      const log = new ProcessedLog(f.logPath);
      await log.load();
      expect(log.get(f.entry.sessionPath)).toMatchObject({ recordCount: 4, lastRecordHash: f.entry.lastRecordHash });
      expect(log.get(f.entry.sessionPath)?.pendingOutcomes).toEqual(f.entry.pendingOutcomes);
      expect(await recoverReflectionCommit(f.env.playbookPath)).toBeNull();
    });
  });

  test("pending dry-run recovery is read-only and tells the caller how to resume", async () => {
    await withFixture(async f => {
      await withLock(f.env.playbookPath, async () => publishBeforeFirstWrite(f, await f.prepare()));
      const { pending, directory } = await pendingData(f.env.playbookPath);
      const before = await fs.readFile(pending, "utf8");
      const files = await fs.readdir(directory);
      const global = await fs.readFile(f.env.playbookPath, "utf8");
      const repo = await fs.readFile(f.repoPath, "utf8");
      await expect(recoverReflectionCommit(f.env.playbookPath, { dryRun: true })).rejects.toThrow("without --dry-run");
      expect(await fs.readFile(pending, "utf8")).toBe(before);
      expect(await fs.readdir(directory)).toEqual(files);
      expect(await fs.readFile(f.env.playbookPath, "utf8")).toBe(global);
      expect(await fs.readFile(f.repoPath, "utf8")).toBe(repo);
    });
  });

  test("corrupted staged data is rejected before any live replacement", async () => {
    await withFixture(async f => {
      await withLock(f.env.playbookPath, async () => publishBeforeFirstWrite(f, await f.prepare()));
      const { manifest, directory } = await pendingData(f.env.playbookPath);
      const target = manifest.targets.find((entry: { path: string }) => entry.path === f.repoPath);
      await fs.appendFile(path.join(directory, target.file), "\n# interrupted or tampered stage\n");
      const global = await fs.readFile(f.env.playbookPath, "utf8");
      const repo = await fs.readFile(f.repoPath, "utf8");
      await expect(recoverReflectionCommit(f.env.playbookPath)).rejects.toThrow("checksum mismatch");
      expect(await fs.readFile(f.env.playbookPath, "utf8")).toBe(global);
      expect(await fs.readFile(f.repoPath, "utf8")).toBe(repo);
      expect(await Bun.file(f.logPath).exists()).toBe(false);
    });
  });

  test("a visible journal must become durable before recovery replaces any playbook", async () => {
    await withFixture(async f => {
      const pending = reflectionCommitPendingPath(f.env.playbookPath);
      const global = await fs.readFile(f.env.playbookPath, "utf8");
      const repo = await fs.readFile(f.repoPath, "utf8");
      const rename = fs.rename;
      const interrupted = spyOn(fs, "rename").mockImplementation(async (source, destination) => {
        await rename(source, destination);
        if (String(destination) === pending) throw new Error("injected failure after journal rename");
      });
      try {
        await withLock(f.env.playbookPath, async () => {
          const transaction = await f.prepare();
          await expect(transaction.commit()).rejects.toThrow("failure after journal rename");
          await transaction.abort();
        });
      } finally {
        interrupted.mockRestore();
      }
      const open = fs.open;
      const unflushed = spyOn(fs, "open").mockImplementation(async (file, ...options) => {
        const handle = await open(file, ...options);
        if (String(file) === pending) {
          handle.sync = async () => { throw new Error("injected journal flush failure"); };
        }
        return handle;
      });
      try {
        await expect(recoverReflectionCommit(f.env.playbookPath)).rejects.toThrow("journal flush failure");
      } finally {
        unflushed.mockRestore();
      }
      expect(await fs.readFile(f.env.playbookPath, "utf8")).toBe(global);
      expect(await fs.readFile(f.repoPath, "utf8")).toBe(repo);
      expect(await Bun.file(f.logPath).exists()).toBe(false);
      expect(await Bun.file(pending).exists()).toBe(true);
      await recoverReflectionCommit(f.env.playbookPath);
      expect((await loadPlaybook(f.env.playbookPath)).metadata.totalReflections).toBe(1);
      expect((await loadPlaybook(f.repoPath)).bullets[0]!.helpfulCount).toBe(1);
    });
  });

  test("a visible receipt is flushed before acknowledgement after an interrupted replacement", async () => {
    await withFixture(async f => {
      const rename = fs.rename;
      const interrupted = spyOn(fs, "rename").mockImplementation(async (source, destination) => {
        await rename(source, destination);
        if (String(destination) === f.env.playbookPath) throw new Error("injected failure after successful replacement");
      });
      try {
        await withLock(f.env.playbookPath, async () => {
          const transaction = await f.prepare();
          await expect(transaction.commit()).rejects.toThrow("failure after successful replacement");
        });
      } finally {
        interrupted.mockRestore();
      }
      const global = await fs.readFile(f.env.playbookPath, "utf8");
      const repo = await fs.readFile(f.repoPath, "utf8");
      const open = fs.open;
      const unflushed = spyOn(fs, "open").mockImplementation(async (file, ...options) => {
        const handle = await open(file, ...options);
        if (String(file) === f.env.playbookPath) {
          handle.sync = async () => { throw new Error("injected receipt-target flush failure"); };
        }
        return handle;
      });
      try {
        await expect(recoverReflectionCommit(f.env.playbookPath)).rejects.toThrow("receipt-target flush failure");
      } finally {
        unflushed.mockRestore();
      }
      expect(await Bun.file(f.logPath).exists()).toBe(false);
      expect(await fs.readFile(f.env.playbookPath, "utf8")).toBe(global);
      expect(await fs.readFile(f.repoPath, "utf8")).toBe(repo);
      expect(await Bun.file(reflectionCommitPendingPath(f.env.playbookPath)).exists()).toBe(true);
      await recoverReflectionCommit(f.env.playbookPath);
      const saved = await loadPlaybook(f.env.playbookPath);
      expect(saved.metadata.totalReflections).toBe(1);
      expect(saved.metadata.totalSessionsProcessed).toBe(1);
      expect((await loadPlaybook(f.repoPath)).bullets[0]!.helpfulCount).toBe(1);
    });
  });

  test("a ledger ACK permits cleanup after stage removal without replaying newer state", async () => {
    await withFixture(async f => {
      const pending = reflectionCommitPendingPath(f.env.playbookPath);
      const unlink = fs.unlink;
      const interruption = spyOn(fs, "unlink").mockImplementation(async file => {
        if (String(file) === pending) throw new Error("injected pending-manifest removal failure");
        return unlink(file);
      });
      try {
        await withLock(f.env.playbookPath, async () => {
          const transaction = await f.prepare();
          await expect(transaction.commit()).rejects.toThrow("pending-manifest removal failure");
        });
      } finally {
        interruption.mockRestore();
      }
      const { directory } = await pendingData(f.env.playbookPath);
      expect(await Bun.file(path.join(directory, "target-0.yaml")).exists()).toBe(false);
      await withLock(f.env.playbookPath, async () => {
        const edited = await loadPlaybook(f.env.playbookPath);
        edited.bullets[0]!.content = "A later ordinary edit made after the ledger committed.";
        await savePlaybook(edited, f.env.playbookPath);
      });
      const beforeRecovery = await fs.readFile(f.env.playbookPath, "utf8");
      const ledger = new ProcessedLog(f.logPath);
      await ledger.load();
      await ledger.acknowledgeOutcomes([{ sessionPath: f.entry.sessionPath, outcomeIds: [f.entry.pendingOutcomes![0]!.id!] }]);
      await ledger.append({ ...f.entry, recordCount: 9, pendingOutcomes: [] });
      await ledger.save(); // ACKs must survive compaction too.
      expect(await recoverReflectionCommit(f.env.playbookPath)).not.toBeNull();
      expect(await fs.readFile(f.env.playbookPath, "utf8")).toBe(beforeRecovery);
      const recovered = new ProcessedLog(f.logPath);
      await recovered.load();
      expect(recovered.get(f.entry.sessionPath)?.recordCount).toBe(9);
      expect(recovered.get(f.entry.sessionPath)?.pendingOutcomes).toEqual([]);
      expect(await Bun.file(pending).exists()).toBe(false);
    });
  });

  test.each(["owner", "duplicate target", "payload traversal", "ledger destination"])("rejects a malformed %s without touching live files", async kind => {
    await withFixture(async f => {
      await withLock(f.env.playbookPath, async () => publishBeforeFirstWrite(f, await f.prepare()));
      const { pending, manifest } = await pendingData(f.env.playbookPath);
      if (kind === "owner") manifest.owner = f.repoPath;
      if (kind === "duplicate target") manifest.targets.push(manifest.targets[0]);
      if (kind === "payload traversal") manifest.targets[0].file = "../playbook.yaml";
      if (kind === "ledger destination") manifest.logPath = f.repoPath;
      await fs.writeFile(pending, JSON.stringify(manifest));
      const global = await fs.readFile(f.env.playbookPath, "utf8");
      const repo = await fs.readFile(f.repoPath, "utf8");
      await expect(recoverReflectionCommit(f.env.playbookPath)).rejects.toThrow();
      expect(await fs.readFile(f.env.playbookPath, "utf8")).toBe(global);
      expect(await fs.readFile(f.repoPath, "utf8")).toBe(repo);
      expect(await Bun.file(f.logPath).exists()).toBe(false);
    });
  });

  test("a checksum-valid payload still requires the matching transaction receipt", async () => {
    await withFixture(async f => {
      await withLock(f.env.playbookPath, async () => publishBeforeFirstWrite(f, await f.prepare()));
      const { pending, manifest, directory } = await pendingData(f.env.playbookPath);
      const target = manifest.targets[0];
      const file = path.join(directory, target.file);
      const staged = await loadPlaybook(file);
      Object.assign(staged.metadata, { reflectionCommit: { owner: f.env.playbookPath, id: crypto.randomUUID() } });
      await savePlaybook(staged, file);
      target.afterSha256 = crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex");
      await fs.writeFile(pending, JSON.stringify(manifest));
      const original = await fs.readFile(f.env.playbookPath, "utf8");
      await expect(recoverReflectionCommit(f.env.playbookPath)).rejects.toThrow("wrong receipt");
      expect(await fs.readFile(f.env.playbookPath, "utf8")).toBe(original);
    });
  });

  test("oversized originals and pending manifests are rejected before parsing", async () => {
    await withFixture(async f => {
      await withLock(f.env.playbookPath, async () => {
        const transaction = await ReflectionCommit.create(f.env.playbookPath, f.logPath, [f.entry]);
        await fs.truncate(f.repoPath, PLAYBOOK_INPUT_LIMITS.maxBytes + 1); // Sparse fixture: no large allocation.
        await expect(transaction.loadPlaybook(f.repoPath)).rejects.toThrow("Input limit exceeded");
        await transaction.abort();
      });
      const pending = reflectionCommitPendingPath(f.env.playbookPath);
      await fs.writeFile(pending, "{}");
      await fs.truncate(pending, PLAYBOOK_INPUT_LIMITS.maxBytes + 1);
      await expect(recoverReflectionCommit(f.env.playbookPath)).rejects.toThrow("Input limit exceeded");
      expect(await Bun.file(f.logPath).exists()).toBe(false);
    });
  });

  test("staged output must fit the ordinary playbook limit before publication", async () => {
    await withFixture(async f => {
      const original = await fs.readFile(f.env.playbookPath, "utf8");
      await withLock(f.env.playbookPath, async () => {
        const transaction = await ReflectionCommit.create(f.env.playbookPath, f.logPath, [f.entry]);
        const staged = await transaction.loadPlaybook(f.env.playbookPath);
        staged.description = "x".repeat(PLAYBOOK_INPUT_LIMITS.maxBytes);
        await expect(transaction.savePlaybook(staged, f.env.playbookPath)).rejects.toThrow("Input limit exceeded");
        await transaction.abort();
      });
      expect(await fs.readFile(f.env.playbookPath, "utf8")).toBe(original);
      expect(await Bun.file(reflectionCommitPendingPath(f.env.playbookPath)).exists()).toBe(false);
    });
  });

  test("target count is bounded even for unsaved read dependencies", async () => {
    await withFixture(async f => {
      await withLock(f.env.playbookPath, async () => {
        const transaction = await ReflectionCommit.create(f.env.playbookPath, f.logPath, [f.entry]);
        for (let index = 0; index < REFLECTION_COMMIT_LIMITS.maxTargets; index++) {
          await transaction.loadPlaybook(path.join(f.env.home, `missing-${index}.yaml`));
        }
        await expect(transaction.loadPlaybook(f.env.playbookPath)).rejects.toThrow("maximum target count");
        await transaction.abort();
      });
      expect(await fs.readdir(path.dirname(reflectionCommitPendingPath(f.env.playbookPath)))).toEqual([]);
    });
  });
});
