import { describe, expect, spyOn, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { PLAYBOOK_INPUT_LIMITS } from "../src/input-limits.js";
import { withLock } from "../src/lock.js";
import { loadPlaybook, savePlaybook } from "../src/playbook.js";
import {
  discoverPendingOutcomeLogs, pendingOutcomeRegistryPath, PENDING_OUTCOME_LIMITS,
  prunePendingOutcomeLog, recoverReflectionCommit, ReflectionCommit,
  reflectionCommitPendingPath, registerPendingOutcomeLog,
} from "../src/reflection-commit.js";
import { getProcessedLogPath, pendingOutcomeIdentity, ProcessedLog, PROCESSED_LOG_RECOVERY_MAX_BYTES } from "../src/tracking.js";
import type { ProcessedEntry } from "../src/types.js";
import { createBullet, createTestPlaybook } from "./helpers/factories.js";
import { type TestEnv, withTempCassHome } from "./helpers/temp.js";

interface Fixture {
  env: TestEnv;
  owner: string;
  other: string;
  logPath: string;
  entry: (name: string, owner?: string) => ProcessedEntry;
  prepare: (entry: ProcessedEntry) => Promise<ReflectionCommit>;
}

async function withFixture(check: (fixture: Fixture) => Promise<void>) {
  await withTempCassHome(async env => {
    const owner = env.playbookPath;
    const other = path.join(env.home, "other-global.yaml");
    const logPath = getProcessedLogPath();
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    await savePlaybook(createTestPlaybook([createBullet({
      id: "b-registry1", content: "Keep queued feedback attributable to its original global playbook.",
    })]), owner);
    const entry = (name: string, globalPlaybookPath?: string): ProcessedEntry => ({
      sessionPath: path.join(env.home, `${name}.jsonl`), processedAt: "2026-10-29T00:00:00.000Z",
      deltasGenerated: 0, recordCount: 2,
      pendingOutcomes: [{
        id: name, sessionId: path.join(env.home, `${name}.jsonl`),
        recordedAt: "2026-10-29T00:00:00.000Z", outcome: "success",
        rulesUsed: ["b-registry1"], workspace: env.home,
        path: path.join(env.cassMemoryDir, "outcomes.jsonl"),
        ruleTargets: [{ ruleId: "b-registry1", playbookPath: globalPlaybookPath ?? owner }],
        ...(globalPlaybookPath ? { globalPlaybookPath } : {}),
      }],
    });
    const prepare = async (record: ProcessedEntry) => {
      const tx = await ReflectionCommit.create(owner, logPath, [record], { sessionsProcessed: 1 });
      const staged = await tx.loadPlaybook(owner);
      staged.metadata.totalReflections++;
      staged.metadata.totalSessionsProcessed++;
      await tx.savePlaybook(staged, owner);
      return tx;
    };
    await check({ env, owner, other, logPath, entry, prepare });
  }, "pending-outcome-registry");
}

async function registry(owner: string) {
  return JSON.parse(await fs.readFile(pendingOutcomeRegistryPath(owner), "utf8"));
}

function envelope(owner: string, entries: ProcessedEntry[]) {
  return { reflectionCommit: { owner, id: crypto.randomUUID() }, entries };
}

async function fillLedgerWithHistory(file: string, records: unknown[]) {
  const handle = await fs.open(file, "w");
  try {
    await handle.writeFile(records.map(record => JSON.stringify(record)).join("\n") + "\n#");
    // Sparse comment padding exercises the real ceiling without a large fixture allocation.
    await handle.truncate(PROCESSED_LOG_RECOVERY_MAX_BYTES - 8);
    await handle.write(Buffer.from("\n"), 0, 1, PROCESSED_LOG_RECOVERY_MAX_BYTES - 9);
  } finally {
    await handle.close();
  }
}

describe("durable pending-outcome discovery", () => {
  test("failed registry publication retains the acknowledged commit for exact recovery", async () => {
    await withFixture(async f => {
      const index = pendingOutcomeRegistryPath(f.owner);
      const rename = fs.rename;
      const fault = spyOn(fs, "rename").mockImplementation(async (source, destination) => {
        if (String(destination) === index) throw new Error("injected registry publication failure");
        return rename(source, destination);
      });
      let id = "";
      try {
        await withLock(f.owner, async () => {
          const tx = await f.prepare(f.entry("registered", f.owner));
          id = tx.id;
          await expect(tx.commit()).rejects.toThrow("registry publication failure");
          await tx.abort();
        });
      } finally { fault.mockRestore(); }
      const log = new ProcessedLog(f.logPath);
      await log.load();
      expect(log.hasCommittedBatch(f.owner, id)).toBe(true);
      expect(await Bun.file(reflectionCommitPendingPath(f.owner)).exists()).toBe(true);
      expect((await loadPlaybook(f.owner)).metadata.totalReflections).toBe(1);
      await recoverReflectionCommit(f.owner);
      expect(await Bun.file(reflectionCommitPendingPath(f.owner)).exists()).toBe(false);
      expect((await registry(f.owner)).logs).toEqual([f.logPath]);
      expect((await loadPlaybook(f.owner)).metadata.totalReflections).toBe(1);
    });
  });

  test("bootstraps an original envelope without a journal and keeps dry-run read-only", async () => {
    await withFixture(async f => {
      const legacy = f.entry("legacy-envelope");
      const bytes = JSON.stringify(envelope(f.owner, [legacy])) + "\n";
      await fs.writeFile(f.logPath, bytes);
      expect(await discoverPendingOutcomeLogs(f.owner, { dryRun: true })).toEqual({ logPaths: [f.logPath], errors: [] });
      expect(await Bun.file(pendingOutcomeRegistryPath(f.owner)).exists()).toBe(false);
      expect(await fs.readFile(f.logPath, "utf8")).toBe(bytes);
      expect(await discoverPendingOutcomeLogs(f.owner)).toEqual({ logPaths: [f.logPath], errors: [] });
      const log = new ProcessedLog(f.logPath);
      await log.load();
      expect(log.getPendingOutcomeEntries(f.owner)[0]!.pendingOutcomes![0]!.globalPlaybookPath).toBe(f.owner);
      expect((await registry(f.owner)).bootstrapped).toBe(true);
      expect(await fs.readFile(f.logPath, "utf8")).toBe(bytes);
    });
  });

  test("mixed-owner envelope provenance survives compaction and ordinary ACK rewrites", async () => {
    await withFixture(async f => {
      const first = f.entry("first-owner");
      const second = f.entry("second-owner");
      await fs.writeFile(f.logPath, [envelope(f.owner, [first]), envelope(f.other, [second])]
        .map(record => JSON.stringify(record)).join("\n") + "\n");
      const log = new ProcessedLog(f.logPath);
      await log.load();
      expect(log.getPendingOutcomeEntries(f.owner).map(entry => entry.sessionPath)).toEqual([first.sessionPath]);
      expect(log.getPendingOutcomeEntries(f.other).map(entry => entry.sessionPath)).toEqual([second.sessionPath]);
      await log.save();
      const compacted = new ProcessedLog(f.logPath);
      await compacted.load();
      expect(compacted.getPendingOutcomeEntries(f.owner)).toHaveLength(1);
      expect(compacted.getPendingOutcomeEntries(f.other)[0]!.pendingOutcomes![0]!.globalPlaybookPath).toBe(f.other);
      await registerPendingOutcomeLog(f.owner, f.logPath);
      await registerPendingOutcomeLog(f.other, f.logPath);
      await compacted.acknowledgeOutcomes([{ sessionPath: first.sessionPath, outcomeIds: ["first-owner"] }]);
      await prunePendingOutcomeLog(f.owner, f.logPath);
      expect((await registry(f.owner)).logs).toEqual([]);
      expect((await registry(f.other)).logs).toEqual([f.logPath]);
      await compacted.load();
      expect(compacted.getPendingOutcomeEntries(f.owner)).toEqual([]);
      expect(compacted.getPendingOutcomeEntries(f.other)[0]!.pendingOutcomes![0]!.id).toBe("second-owner");
    });
  });

  test("a later unrelated ACK cannot claim an earlier owner-unknown legacy outcome", async () => {
    await withFixture(async f => {
      const unknown = f.entry("unknown-original-owner");
      const other = f.entry("known-other-owner", f.other);
      const bytes = [unknown, envelope(f.other, [other])].map(record => JSON.stringify(record)).join("\n") + "\n";
      await fs.writeFile(f.logPath, bytes);
      const log = new ProcessedLog(f.logPath);
      await log.load();
      expect(log.hasOutcomeOwner(f.owner)).toBe(false);
      expect(() => log.getPendingOutcomeEntries(f.other)).toThrow("ownership is ambiguous");
      const unrelated = await discoverPendingOutcomeLogs(f.owner);
      expect(unrelated).toEqual({ logPaths: [], errors: [] });
      const relevant = await discoverPendingOutcomeLogs(f.other);
      expect(relevant.errors.join(" ")).toContain("ownership is ambiguous");
      expect(relevant.logPaths).toEqual([]);
      expect(await fs.readFile(f.logPath, "utf8")).toBe(bytes);
      await log.save();
      await log.load();
      expect(() => log.getPendingOutcomeEntries(f.other)).toThrow("ownership is ambiguous");
      expect(log.get(unknown.sessionPath)?.pendingOutcomes?.[0]?.globalPlaybookPath).toBeUndefined();
    });
  });

  test("a missing registered ledger remains an error and retains its discovery pointer", async () => {
    await withFixture(async f => {
      await registerPendingOutcomeLog(f.owner, f.logPath);
      const before = await fs.readFile(pendingOutcomeRegistryPath(f.owner), "utf8");
      await expect(prunePendingOutcomeLog(f.owner, f.logPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readFile(pendingOutcomeRegistryPath(f.owner), "utf8")).toBe(before);
      expect(await Bun.file(f.logPath).exists()).toBe(false);
    });
  });

  test("visible empty ACK state is flushed before pruning, including a retry after failed fsync", async () => {
    await withFixture(async f => {
      const entry = f.entry("uncertain-ack", f.owner);
      const log = new ProcessedLog(f.logPath);
      await log.appendCommittedBatch(f.owner, crypto.randomUUID(), [entry]);
      await registerPendingOutcomeLog(f.owner, f.logPath);
      const indexBefore = await fs.readFile(pendingOutcomeRegistryPath(f.owner), "utf8");
      const open = fs.open;
      const fault = spyOn(fs, "open").mockImplementation(async (file, ...options) => {
        const handle = await open(file, ...options);
        if (String(file) === f.logPath) handle.sync = async () => { throw new Error("injected ledger flush failure"); };
        return handle;
      });
      try {
        await expect(log.acknowledgeOutcomes([{ sessionPath: entry.sessionPath, outcomeIds: ["uncertain-ack"] }]))
          .rejects.toThrow("ledger flush failure");
        const visible = new ProcessedLog(f.logPath);
        await visible.load();
        expect(visible.getPendingOutcomeEntries(f.owner)).toEqual([]);
        await expect(prunePendingOutcomeLog(f.owner, f.logPath)).rejects.toThrow("ledger flush failure");
      } finally { fault.mockRestore(); }
      expect(await fs.readFile(pendingOutcomeRegistryPath(f.owner), "utf8")).toBe(indexBefore);
      await prunePendingOutcomeLog(f.owner, f.logPath);
      expect((await registry(f.owner)).logs).toEqual([]);
    });
  });

  test("a full registry rejects a new ledger before journal, playbook, or ledger publication", async () => {
    await withFixture(async f => {
      const index = pendingOutcomeRegistryPath(f.owner);
      await fs.mkdir(path.dirname(index), { recursive: true });
      const logs = Array.from({ length: PENDING_OUTCOME_LIMITS.maxLogs }, (_, i) =>
        path.join(path.dirname(f.logPath), `ws-${i.toString(16).padStart(8, "0")}.processed.log`));
      for (const [i, file] of logs.entries()) await fs.writeFile(file, JSON.stringify(envelope(f.owner, [f.entry(`held-${i}`, f.owner)])) + "\n");
      await fs.writeFile(index, JSON.stringify({ version: 1, owner: f.owner, bootstrapped: true, logs }));
      const original = await fs.readFile(f.owner, "utf8");
      const registryBefore = await fs.readFile(index, "utf8");
      await withLock(f.owner, async () => {
        const tx = await f.prepare(f.entry("overflow-owner", f.owner));
        await expect(tx.commit()).rejects.toThrow("registry capacity is full");
        await tx.abort();
      });
      expect(await fs.readFile(f.owner, "utf8")).toBe(original);
      expect(await fs.readFile(index, "utf8")).toBe(registryBefore);
      expect(await Bun.file(f.logPath).exists()).toBe(false);
      expect(await Bun.file(reflectionCommitPendingPath(f.owner)).exists()).toBe(false);
    });
  });

  test.skipIf(process.platform === "win32")("a symlinked ledger is rejected before live commit writes", async () => {
    await withFixture(async f => {
      const target = path.join(f.env.home, "unrelated-state.txt");
      await fs.writeFile(target, "preserve unrelated bytes\n");
      await fs.symlink(target, f.logPath);
      const original = await fs.readFile(f.owner, "utf8");
      await withLock(f.owner, async () => {
        const tx = await f.prepare(f.entry("symlink-ledger", f.owner));
        await expect(tx.commit()).rejects.toThrow("regular processed log");
        await tx.abort();
      });
      expect(await fs.readFile(target, "utf8")).toBe("preserve unrelated bytes\n");
      expect(await fs.readFile(f.owner, "utf8")).toBe(original);
      expect(await Bun.file(reflectionCommitPendingPath(f.owner)).exists()).toBe(false);
    });
  });

  test.each(["owner", "destination", "duplicate", "oversized"])("rejects a malformed registry %s without altering it", async kind => {
    await withFixture(async f => {
      const index = pendingOutcomeRegistryPath(f.owner);
      await fs.mkdir(path.dirname(index), { recursive: true });
      const data = { version: 1, owner: f.owner, bootstrapped: true, logs: [f.logPath] };
      if (kind === "owner") data.owner = f.other;
      if (kind === "destination") data.logs = [path.join(f.env.home, "outside.processed.log")];
      if (kind === "duplicate") data.logs.push(f.logPath);
      await fs.writeFile(index, JSON.stringify(data));
      if (kind === "oversized") await fs.truncate(index, PENDING_OUTCOME_LIMITS.maxRegistryBytes + 1);
      const before = await fs.readFile(index);
      await expect(discoverPendingOutcomeLogs(f.owner, { dryRun: true })).rejects.toThrow();
      expect(await fs.readFile(index)).toEqual(before);
      expect(await Bun.file(f.logPath).exists()).toBe(false);
    });
  });

  test("discovery enumeration is bounded and leaves an incomplete bootstrap retryable", async () => {
    await withFixture(async f => {
      for (let i = 0; i <= PENDING_OUTCOME_LIMITS.maxDiscoveryEntries; i++) {
        await fs.writeFile(path.join(path.dirname(f.logPath), `unrelated-${i}`), "preserved");
      }
      const result = await discoverPendingOutcomeLogs(f.owner);
      expect(result.errors.join(" ")).toContain("discovery entry limit exceeded");
      expect((await registry(f.owner)).bootstrapped).toBe(false);
      expect(await fs.readFile(path.join(path.dirname(f.logPath), "unrelated-0"), "utf8")).toBe("preserved");
    });
  });

  test("merged pending records must fit before a journal or playbook replacement is published", async () => {
    await withFixture(async f => {
      const prior = f.entry("prior-large", f.owner);
      prior.pendingOutcomes![0]!.notes = "x".repeat(9 * 1024 * 1024);
      await new ProcessedLog(f.logPath).append(prior);
      const incoming = f.entry("incoming-large", f.owner);
      incoming.sessionPath = prior.sessionPath;
      incoming.pendingOutcomes![0]!.notes = "y".repeat(9 * 1024 * 1024);
      const beforeLog = await fs.readFile(f.logPath, "utf8");
      const beforeBook = await fs.readFile(f.owner, "utf8");
      await withLock(f.owner, async () => {
        const tx = await f.prepare(incoming);
        await expect(tx.commit()).rejects.toThrow("Input limit exceeded");
        await tx.abort();
      });
      expect(await fs.readFile(f.logPath, "utf8")).toBe(beforeLog);
      expect(await fs.readFile(f.owner, "utf8")).toBe(beforeBook);
      expect(await Bun.file(reflectionCommitPendingPath(f.owner)).exists()).toBe(false);
    });
  });

  test("an oversized compacted ledger is rejected before publishing a new playbook commit", async () => {
    await withFixture(async f => {
      const oldEntries = Array.from({ length: 4 }, (_, i) => ({
        sessionPath: path.join(f.env.home, `history-${i}.jsonl`), processedAt: "2026-10-29T00:00:00.000Z",
        deltasGenerated: 0, diaryId: "x".repeat(15 * 1024 * 1024),
      }));
      await fs.writeFile(f.logPath, oldEntries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
      const incoming = f.entry("over-total-ceiling", f.owner);
      incoming.diaryId = "y".repeat(5 * 1024 * 1024);
      const beforeSize = (await fs.stat(f.logPath)).size;
      const beforeBook = await fs.readFile(f.owner, "utf8");
      await withLock(f.owner, async () => {
        const tx = await f.prepare(incoming);
        await expect(tx.commit()).rejects.toThrow("Input limit exceeded");
        await tx.abort();
      });
      expect((await fs.stat(f.logPath)).size).toBe(beforeSize);
      expect(await fs.readFile(f.owner, "utf8")).toBe(beforeBook);
      expect(await Bun.file(reflectionCommitPendingPath(f.owner)).exists()).toBe(false);
    });
  });

  test("bounded reads count actual bytes even if the file grows after stat", async () => {
    await withFixture(async f => {
      await fs.writeFile(f.logPath, "#" + "x".repeat(80));
      const open = fs.open;
      const fault = spyOn(fs, "open").mockImplementation(async (file, ...options) => {
        const handle = await open(file, ...options);
        if (String(file) === f.logPath) {
          const stat = handle.stat.bind(handle);
          handle.stat = (async (...args: any[]) => ({ ...(await (stat as any)(...args)), size: 1, isFile: () => true })) as typeof handle.stat;
        }
        return handle;
      });
      const budget = { remainingBytes: 16 };
      try {
        await expect(new ProcessedLog(f.logPath).load({ budget, requireExists: true })).rejects.toThrow("byte budget exceeded");
      } finally { fault.mockRestore(); }
      expect(budget.remainingBytes).toBe(-1);
    });
  });

  test("ordinary pending records enforce structural limits before ownership traversal or writes", async () => {
    await withFixture(async f => {
      const entry = f.entry("too-many-events", f.owner);
      entry.pendingOutcomes = Array.from({ length: PLAYBOOK_INPUT_LIMITS.maxArrayLength + 1 }, (_, i) =>
        ({ ...entry.pendingOutcomes![0]!, id: `event-${i}` }));
      await fs.writeFile(f.logPath, JSON.stringify(entry) + "\n");
      const before = await fs.readFile(f.logPath, "utf8");
      await expect(new ProcessedLog(f.logPath).load({ budget: { remainingBytes: PENDING_OUTCOME_LIMITS.maxReadBytes } }))
        .rejects.toThrow("Input limit exceeded");
      const destination = getProcessedLogPath(f.env.home);
      await expect(new ProcessedLog(destination).append(entry)).rejects.toThrow("Input limit exceeded");
      expect(await fs.readFile(f.logPath, "utf8")).toBe(before);
      expect(await Bun.file(destination).exists()).toBe(false);
    });
  });

  test.each(["committed batch", "ordinary append", "outcome ACK"])("%s compacts near-ceiling history while preserving owners and ACKs", async kind => {
    await withFixture(async f => {
      const first = f.entry("retained", f.owner);
      const firstId = crypto.randomUUID();
      await fillLedgerWithHistory(f.logPath, [{ reflectionCommit: { owner: f.owner, id: firstId }, entries: [first] }]);
      const log = new ProcessedLog(f.logPath);
      if (kind === "committed batch") await log.appendCommittedBatch(f.other, "second-owner-commit", [f.entry("new-owner", f.other)]);
      else if (kind === "ordinary append") await log.append({ ...first, recordCount: 9, pendingOutcomes: [] });
      else await log.acknowledgeOutcomes([{ sessionPath: first.sessionPath, outcomeIds: ["retained"] }]);
      expect((await fs.stat(f.logPath)).size).toBeLessThan(20_000);
      await log.load({ budget: { remainingBytes: PENDING_OUTCOME_LIMITS.maxReadBytes } });
      expect(log.hasCommittedBatch(f.owner, firstId)).toBe(true);
      expect(log.get(first.sessionPath)?.recordCount).toBe(kind === "ordinary append" ? 9 : 2);
      expect(log.getPendingOutcomeEntries(f.owner)).toHaveLength(kind === "outcome ACK" ? 0 : 1);
      if (kind === "committed batch") {
        expect(log.hasCommittedBatch(f.other, "second-owner-commit")).toBe(true);
        expect(log.getPendingOutcomeEntries(f.other)).toHaveLength(1);
      }
    });
  });

  test("legacy no-ID acknowledgement uses the same frozen identity as delivery tracking", async () => {
    await withFixture(async f => {
      const entry = f.entry("no-id", f.owner);
      delete entry.pendingOutcomes![0]!.id;
      const log = new ProcessedLog(f.logPath);
      await log.append(entry);
      await log.acknowledgeOutcomes([{ sessionPath: entry.sessionPath,
        outcomeIds: [pendingOutcomeIdentity(entry.pendingOutcomes![0]!)] }]);
      await log.load();
      expect(log.getPendingOutcomeEntries(f.owner)).toEqual([]);
    });
  });
});
