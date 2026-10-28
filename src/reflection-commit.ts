import crypto from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  assertInputLimits, assertTextSize, formatValidationIssues, InputLimitError,
  parseJsonInput, PLAYBOOK_INPUT_LIMITS,
} from "./input-limits.js";
import { withLock } from "./lock.js";
import {
  createEmptyPlaybook, loadPlaybook as loadStoredPlaybook, savePlaybook as saveStoredPlaybook,
} from "./playbook.js";
import { ProcessedLog } from "./tracking.js";
import { type Playbook, type ProcessedEntry, ProcessedEntrySchema } from "./types.js";
import { atomicWrite, canonicalStoragePath, ensureDurableDirectory, expandPath, resolveGlobalDir, syncDirectory } from "./utils.js";

/** Journal limits do not relax the limits on any individual playbook. */
export const REFLECTION_COMMIT_LIMITS = Object.freeze({
  maxTargets: 64,
  maxManifestBytes: PLAYBOOK_INPUT_LIMITS.maxBytes,
  maxStagedBytes: 256 * 1024 * 1024,
  maxCleanupEntries: 1024,
});

const ManifestSchema = z.object({
  version: z.literal(1),
  id: z.string().uuid(),
  owner: z.string().min(1).max(4096),
  logPath: z.string().min(1).max(4096),
  sessionsProcessed: z.number().int().nonnegative(),
  entries: z.array(ProcessedEntrySchema).max(PLAYBOOK_INPUT_LIMITS.maxArrayLength),
  targets: z.array(z.object({
    path: z.string().min(1).max(4096),
    file: z.string().regex(/^target-(0|[1-9]\d*)\.yaml$/).max(32),
    beforeSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    afterSha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict()).min(1).max(REFLECTION_COMMIT_LIMITS.maxTargets),
}).strict();

type Manifest = z.infer<typeof ManifestSchema>;
type Target = Manifest["targets"][number];
type Receipt = { owner: string; id: string };

export interface RecoveredReflectionCommit {
  id: string;
  logPath: string;
  sessionsProcessed: number;
}

function absolute(file: string): string {
  if (!file.trim()) throw new Error("Reflection commit paths must not be empty");
  return path.resolve(expandPath(file));
}

function sha256(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

export function reflectionCommitPendingPath(globalPath: string): string {
  const key = sha256(Buffer.from(canonicalStoragePath(globalPath)));
  return canonicalStoragePath(path.join(resolveGlobalDir(), "reflections", "commits", `${key}.pending.json`));
}

function stageDirectory(owner: string, id: string): string {
  const pending = reflectionCommitPendingPath(owner);
  return path.join(path.dirname(pending), `${path.basename(pending, ".pending.json")}.${id}.stage`);
}

/** Read exact bytes, including a limit check if the opened file grows. */
async function readBytes(
  file: string,
  options: { privateFile?: boolean; missingOk?: boolean } = {},
): Promise<Buffer | null> {
  const flags = constants.O_RDONLY | constants.O_NONBLOCK
    | (options.privateFile ? (constants.O_NOFOLLOW ?? 0) : 0);
  let handle;
  try {
    if (options.privateFile) {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Expected a regular reflection recovery file: ${file}`);
    }
    handle = await fs.open(file, flags);
  } catch (error: any) {
    if (options.missingOk && error?.code === "ENOENT") return null;
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new InputLimitError(file, "expected a regular file");
    if (stat.size > PLAYBOOK_INPUT_LIMITS.maxBytes) {
      throw new InputLimitError(file, `maximum file size is ${PLAYBOOK_INPUT_LIMITS.maxBytes} bytes`);
    }
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= PLAYBOOK_INPUT_LIMITS.maxBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, PLAYBOOK_INPUT_LIMITS.maxBytes + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > PLAYBOOK_INPUT_LIMITS.maxBytes) {
        throw new InputLimitError(file, `maximum file size is ${PLAYBOOK_INPUT_LIMITS.maxBytes} bytes`);
      }
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}

function validateManifest(raw: unknown, owner: string): Manifest {
  const source = reflectionCommitPendingPath(owner);
  assertInputLimits(raw, PLAYBOOK_INPUT_LIMITS, source);
  const parsed = ManifestSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Invalid reflection commit: ${formatValidationIssues(parsed.error)}`);
  const manifest = parsed.data;
  if (manifest.owner !== owner || manifest.owner !== canonicalStoragePath(manifest.owner)) {
    throw new Error("Reflection commit belongs to a different global playbook");
  }
  const reflectionsDirectory = path.dirname(path.dirname(source));
  if (manifest.logPath !== canonicalStoragePath(manifest.logPath)
    || path.dirname(manifest.logPath) !== reflectionsDirectory
    || !/^(global|ws-[a-f0-9]{8})\.processed\.log$/.test(path.basename(manifest.logPath))) {
    throw new Error("Reflection commit has an invalid processed-log destination");
  }
  const targetPaths = new Set<string>();
  const files = new Set<string>();
  for (const target of manifest.targets) {
    const journalRelative = path.relative(path.dirname(source), target.path);
    if (target.path !== canonicalStoragePath(target.path) || target.path === manifest.logPath
      || (!journalRelative.startsWith(`..${path.sep}`) && journalRelative !== ".." && !path.isAbsolute(journalRelative))) {
      throw new Error("Reflection commit has an invalid playbook destination");
    }
    if (targetPaths.has(target.path) || files.has(target.file)) throw new Error("Reflection commit has duplicate targets");
    targetPaths.add(target.path);
    files.add(target.file);
  }
  if (!targetPaths.has(owner)) throw new Error("Reflection commit must include its global playbook");
  if (manifest.sessionsProcessed > manifest.entries.length
    || manifest.entries.some(entry => entry.sessionPath !== absolute(entry.sessionPath))) {
    throw new Error("Reflection commit has invalid session records");
  }
  return manifest;
}

async function readManifest(owner: string): Promise<Manifest | null> {
  const pending = reflectionCommitPendingPath(owner);
  const bytes = await readBytes(pending, { privateFile: true, missingOk: true });
  if (bytes === null) return null;
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return validateManifest(parseJsonInput(text, PLAYBOOK_INPUT_LIMITS, pending), owner);
}

function receiptMatches(playbook: Playbook, expected: Receipt): boolean {
  const receipt = (playbook.metadata as unknown as Record<string, unknown>).reflectionCommit;
  return !!receipt && typeof receipt === "object"
    && (receipt as Receipt).owner === expected.owner && (receipt as Receipt).id === expected.id;
}

async function verifyStageDirectory(manifest: Pick<Manifest, "owner" | "id">): Promise<string> {
  const directory = stageDirectory(manifest.owner, manifest.id);
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Reflection commit stage is not a private directory");
  return directory;
}

async function readPayload(manifest: Manifest, target: Target): Promise<Buffer> {
  const directory = await verifyStageDirectory(manifest);
  const file = path.join(directory, target.file);
  const bytes = (await readBytes(file, { privateFile: true }))!;
  if (sha256(bytes) !== target.afterSha256) throw new Error(`Reflection commit payload checksum mismatch: ${target.path}`);
  const playbook = await loadStoredPlaybook(file);
  if (!receiptMatches(playbook, manifest)) throw new Error(`Reflection commit payload has the wrong receipt: ${target.path}`);
  return bytes;
}

async function targetState(manifest: Manifest, target: Target): Promise<"apply" | "applied"> {
  const bytes = await readBytes(target.path, { missingOk: true });
  const hash = bytes === null ? null : sha256(bytes);
  if (hash === target.afterSha256) return "applied";
  if (bytes !== null && receiptMatches(await loadStoredPlaybook(target.path), manifest)) return "applied";
  if (hash === target.beforeSha256) return "apply";
  throw new Error(
    `Reflection commit ${manifest.id} cannot replace a playbook changed since preparation: ${target.path}. `
    + `Current data and the pending commit were preserved. Resolve the conflict, then retry cm reflect.`,
  );
}

/** Validate every payload and live precondition before writing any playbook. */
async function preflight(manifest: Manifest): Promise<void> {
  let total = 0;
  for (const target of manifest.targets) {
    total += (await readPayload(manifest, target)).length;
    if (total > REFLECTION_COMMIT_LIMITS.maxStagedBytes) {
      throw new InputLimitError(reflectionCommitPendingPath(manifest.owner), "reflection commit staged-byte limit exceeded");
    }
    await targetState(manifest, target);
  }
}

async function withRepositoryLocks<T>(
  manifest: Manifest,
  operation: () => Promise<T>,
  readDependencies: string[] = [],
): Promise<T> {
  const repositories = [...new Set([...manifest.targets.map(target => target.path), ...readDependencies])]
    .filter(target => target !== manifest.owner).sort();
  const acquire = (index: number): Promise<T> => index === repositories.length
    ? operation() : withLock(repositories[index], () => acquire(index + 1));
  return acquire(0);
}

async function clearCommit(manifest: Manifest): Promise<void> {
  // The ledger acknowledgement makes missing stage files safe on restart.
  // Keep the manifest until cleanup succeeds, preventing an unbounded trail
  // of abandoned snapshots if storage refuses deletion.
  const directory = stageDirectory(manifest.owner, manifest.id);
  try {
    await verifyStageDirectory(manifest);
    await fs.rm(directory, { recursive: true, force: true });
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  const pending = reflectionCommitPendingPath(manifest.owner);
  await syncDirectory(path.dirname(pending));
  await fs.unlink(pending);
  await syncDirectory(path.dirname(pending));
}

async function syncFileAndParents(file: string, privateFile = false): Promise<void> {
  // A replacement can be visible after its directory flush failed. Reflush
  // both pending intent and already-applied targets before trusting them.
  if (privateFile) {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Expected a regular reflection recovery file: ${file}`);
  }
  const handle = await fs.open(file, constants.O_RDWR | constants.O_NONBLOCK
    | (privateFile ? (constants.O_NOFOLLOW ?? 0) : 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > PLAYBOOK_INPUT_LIMITS.maxBytes) {
      throw new InputLimitError(file, "expected a bounded regular playbook");
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  await ensureDurableDirectory(path.dirname(file));
}

/** Caller holds the global lock and, unless already acknowledged, every target lock. */
async function finishCommit(manifest: Manifest, preflighted = false): Promise<RecoveredReflectionCommit> {
  const log = new ProcessedLog(manifest.logPath);
  await log.load();
  if (!log.hasCommittedBatch(manifest.owner, manifest.id)) {
    // An earlier publish may have renamed the journal before its directory
    // sync failed. Recovery must make that intent durable before another
    // crash can leave live replacements without their recovery record.
    await syncFileAndParents(reflectionCommitPendingPath(manifest.owner), true);
    if (!preflighted) await preflight(manifest);
    // Replacements precede repository retirements, including cross-layer merges.
    const targets = [...manifest.targets].sort((a, b) =>
      a.path === manifest.owner ? -1 : b.path === manifest.owner ? 1 : a.path.localeCompare(b.path));
    for (const target of targets) {
      if (await targetState(manifest, target) === "applied") {
        await syncFileAndParents(target.path);
        continue;
      }
      const bytes = await readPayload(manifest, target);
      await atomicWrite(target.path, new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    }
  }
  // A visible ACK may have survived a failed flush. Duplicate acknowledgement
  // flushes the existing record before the only recovery copy is removed.
  await log.appendCommittedBatch(manifest.owner, manifest.id, manifest.entries);
  await clearCommit(manifest);
  return { id: manifest.id, logPath: manifest.logPath, sessionsProcessed: manifest.sessionsProcessed };
}

export async function recoverReflectionCommit(
  globalPath: string,
  options: { dryRun?: boolean; skipGlobalLock?: boolean } = {},
): Promise<RecoveredReflectionCommit | null> {
  const owner = canonicalStoragePath(globalPath);
  if (await readManifest(owner) === null) return null;
  if (options.dryRun) {
    throw new Error(`A pending reflection commit requires recovery. Run cm reflect without --dry-run first: ${reflectionCommitPendingPath(owner)}`);
  }
  const recover = async () => {
    const manifest = await readManifest(owner);
    if (!manifest) return null;
    const log = new ProcessedLog(manifest.logPath);
    await log.load();
    if (log.hasCommittedBatch(owner, manifest.id)) return finishCommit(manifest);
    return withRepositoryLocks(manifest, () => finishCommit(manifest));
  };
  return options.skipGlobalLock ? recover() : withLock(owner, recover);
}

interface StagedTarget {
  path: string;
  file: string;
  beforeSha256: string | null;
  bytes: number;
  saved: boolean;
}

/** Caller holds the owner lock and has established that no journal is pending. */
async function cleanAbandonedDrafts(owner: string): Promise<void> {
  const pending = reflectionCommitPendingPath(owner);
  const parent = path.dirname(pending);
  const prefix = `${path.basename(pending, ".pending.json")}.`;
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
  const payload = /^target-(0|[1-9]\d*)\.yaml(?:\.(?:tmp|bak)\.[a-f0-9]{16})?$/;
  const cleanup: Array<{ directory: string; files: string[] }> = [];
  let examined = 0;
  const countEntry = () => {
    if (++examined > REFLECTION_COMMIT_LIMITS.maxCleanupEntries) {
      throw new InputLimitError(parent,
        `reflection draft cleanup scan exceeds ${REFLECTION_COMMIT_LIMITS.maxCleanupEntries} entries; `
        + "inspect the abandoned draft directory before retrying cm reflect");
    }
  };
  for await (const entry of await fs.opendir(parent)) {
    countEntry();
    if (!entry.isDirectory() || entry.isSymbolicLink() || !entry.name.startsWith(prefix)
      || !entry.name.endsWith(".stage") || !uuid.test(entry.name.slice(prefix.length, -6))) continue;
    const directory = path.join(parent, entry.name);
    const files: string[] = [];
    let recognized = true;
    for await (const file of await fs.opendir(directory)) {
      countEntry();
      const match = payload.exec(file.name);
      if (!file.isFile() || file.isSymbolicLink() || !match || Number(match[1]) >= REFLECTION_COMMIT_LIMITS.maxTargets) {
        recognized = false;
      } else files.push(path.join(directory, file.name));
    }
    // An unexpected file or symlink may belong to the user. Preserve the
    // entire directory rather than guessing whether any part is disposable.
    if (recognized) cleanup.push({ directory, files });
  }
  // Finish the bounded inspection before deleting any known orphan payload.
  for (const { directory, files } of cleanup) {
    for (const file of files) await fs.unlink(file);
    await fs.rmdir(directory);
  }
  if (cleanup.length) await syncDirectory(parent);
}

/** A bounded, prepared reflection commit. All methods run under its global lock. */
export class ReflectionCommit {
  readonly id = crypto.randomUUID();
  private readonly targets = new Map<string, StagedTarget>();
  private published = false;
  private finished = false;

  private constructor(
    readonly owner: string,
    readonly logPath: string,
    private readonly entries: ProcessedEntry[],
    private readonly sessionsProcessed: number,
  ) {}

  static async create(
    globalPath: string,
    logPath: string,
    entries: ProcessedEntry[],
    options: { sessionsProcessed?: number } = {},
  ): Promise<ReflectionCommit> {
    const owner = canonicalStoragePath(globalPath);
    if (await readManifest(owner)) throw new Error("Recover the pending reflection commit before preparing another");
    assertInputLimits(entries, PLAYBOOK_INPUT_LIMITS, "reflection commit entries");
    const normalized = entries.map(entry => ({ ...entry, sessionPath: absolute(entry.sessionPath) }));
    const encoded = JSON.stringify(normalized);
    assertTextSize(encoded, REFLECTION_COMMIT_LIMITS.maxManifestBytes, "reflection commit entries");
    const frozen = JSON.parse(encoded) as ProcessedEntry[];
    const transaction = new ReflectionCommit(owner, canonicalStoragePath(logPath), frozen, options.sessionsProcessed ?? 0);
    const parent = path.dirname(reflectionCommitPendingPath(owner));
    await ensureDurableDirectory(parent);
    await fs.chmod(parent, 0o700);
    await cleanAbandonedDrafts(owner);
    await fs.mkdir(stageDirectory(owner, transaction.id), { mode: 0o700 });
    await syncDirectory(parent);
    return transaction;
  }

  private assertDraft(): void {
    if (this.published || this.finished) throw new Error("Reflection commit is no longer a draft; recover its pending journal");
  }

  private checkStageBudget(): void {
    const total = [...this.targets.values()].reduce((sum, target) => sum + target.bytes, 0);
    if (total > REFLECTION_COMMIT_LIMITS.maxStagedBytes) {
      throw new InputLimitError(this.owner, "reflection commit staged-byte limit exceeded; process fewer sessions per run");
    }
  }

  private async capture(targetPath: string): Promise<StagedTarget> {
    this.assertDraft();
    const target = canonicalStoragePath(targetPath);
    const existing = this.targets.get(target);
    if (existing) return existing;
    if (this.targets.size >= REFLECTION_COMMIT_LIMITS.maxTargets) {
      throw new InputLimitError(this.owner, `reflection commit maximum target count is ${REFLECTION_COMMIT_LIMITS.maxTargets}`);
    }
    const record: StagedTarget = {
      path: target, file: `target-${this.targets.size}.yaml`, beforeSha256: null, bytes: 0, saved: false,
    };
    const original = await readBytes(target, { missingOk: true });
    const file = path.join(stageDirectory(this.owner, this.id), record.file);
    if (original === null) await saveStoredPlaybook(createEmptyPlaybook(), file);
    else {
      record.beforeSha256 = sha256(original);
      const content = original.toString("utf8");
      assertTextSize(content, PLAYBOOK_INPUT_LIMITS.maxBytes, target);
      await atomicWrite(file, content);
    }
    // Parse the exact captured source through the normal bounded storage
    // schema; a second read of the live target could capture a different edit.
    await loadStoredPlaybook(file);
    record.bytes = (await fs.stat(file)).size;
    this.targets.set(target, record);
    this.checkStageBudget();
    return record;
  }

  async loadPlaybook(targetPath: string): Promise<Playbook> {
    const record = await this.capture(targetPath);
    const file = path.join(stageDirectory(this.owner, this.id), record.file);
    await readBytes(file, { privateFile: true }); // Missing recovery files must never become empty playbooks.
    return loadStoredPlaybook(file);
  }

  async savePlaybook(
    playbook: Playbook,
    targetPath: string,
    options: { updateLastReflection?: boolean } = {},
  ): Promise<void> {
    const record = await this.capture(targetPath);
    playbook.metadata = {
      ...playbook.metadata,
      reflectionCommit: { owner: this.owner, id: this.id },
    } as Playbook["metadata"];
    const file = path.join(stageDirectory(this.owner, this.id), record.file);
    await saveStoredPlaybook(playbook, file, options);
    record.bytes = (await fs.stat(file)).size;
    record.saved = true;
    this.checkStageBudget();
  }

  async commit(): Promise<RecoveredReflectionCommit> {
    this.assertDraft();
    const targets: Target[] = [];
    for (const record of this.targets.values()) {
      if (!record.saved) continue;
      const bytes = (await readBytes(path.join(stageDirectory(this.owner, this.id), record.file), { privateFile: true }))!;
      targets.push({ path: record.path, file: record.file, beforeSha256: record.beforeSha256, afterSha256: sha256(bytes) });
    }
    const manifest = validateManifest({
      version: 1, owner: this.owner, id: this.id, logPath: this.logPath,
      entries: this.entries, sessionsProcessed: this.sessionsProcessed, targets,
    }, this.owner);
    const pending = reflectionCommitPendingPath(this.owner);
    const serialized = JSON.stringify(manifest);
    assertTextSize(serialized, REFLECTION_COMMIT_LIMITS.maxManifestBytes, pending);
    return withRepositoryLocks(manifest, async () => {
      // A draft made stale by an ordinary writer can still be abandoned
      // safely. Publish only after all originals and all payloads check out.
      for (const record of this.targets.values()) {
        if (record.saved) continue;
        const current = await readBytes(record.path, { missingOk: true });
        if ((current === null ? null : sha256(current)) !== record.beforeSha256) {
          throw new Error(`Reflection read dependency changed since preparation: ${record.path}; no commit was published`);
        }
      }
      await preflight(manifest);
      if (await readManifest(this.owner)) throw new Error("Another reflection commit is pending recovery");
      try {
        await atomicWrite(pending, serialized);
        this.published = true;
      } catch (error) {
        // rename may have succeeded before its directory flush failed.
        this.published = (await readManifest(this.owner))?.id === this.id;
        throw error;
      }
      const result = await finishCommit(manifest, true);
      this.finished = true;
      return result;
    }, [...this.targets.keys()]);
  }

  /** Discard private drafts only; a published recovery journal is never abandoned. */
  async abort(): Promise<void> {
    if (this.published || this.finished) return;
    if ((await readManifest(this.owner))?.id === this.id) return;
    await fs.rm(stageDirectory(this.owner, this.id), { recursive: true, force: true });
    await syncDirectory(path.dirname(reflectionCommitPendingPath(this.owner)));
    this.finished = true;
  }
}
