import crypto from "node:crypto";
import { constants, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import yaml, { isMap, isScalar, isSeq, Lexer, YAMLParseError } from "yaml";
import { z } from "zod";
import {
  assertInputLimits,
  assertTextSize,
  assertYamlTokenLimits,
  formatValidationIssues,
  InputLimitError,
  type InputLimits,
  parseYamlInput,
  PLAYBOOK_INPUT_LIMITS,
  readBoundedFile,
} from "./input-limits.js";
import { withLock } from "./lock.js";
import { normalizeWorkspacePath, resolveProjectRoot } from "./workspace.js";
import { formatMaturityIcon, iconPrefix } from "./output.js";
import { calculateMaturityState, getEffectiveScore, isStale } from "./scoring.js";
import {
  BulletMaturity,
  type Config,
  DeprecatedPatternSchema,
  FeedbackEventSchema,
  NewBulletData,
  type Playbook,
  type PlaybookBullet,
  PlaybookBulletSchema,
  PlaybookMetadataSchema,
  PlaybookSchema,
  type PlaybookStats,
} from "./types.js";
import {
  atomicWrite,
  ensureDir,
  expandPath,
  extractAgentFromPath,
  fileExists,
  generateBulletId,
  hashContent,
  jaccardSimilarity,
  log,
  error as logError,
  now,
  truncate,
  resolveGlobalDir,
  resolveRepoDir,
  tokenize,
  warn,
} from "./utils.js";

// --- Interfaces ---

export interface BlockedEntry {
  id: string;
  content: string;
  reason: string;
  forgottenAt: string;
}

/** @deprecated Use BlockedEntry instead */
export type ToxicEntry = BlockedEntry;

// --- Core Functions ---

// Persisted playbooks may contain evidence from older/newer producers (for
// example derivedFrom and helpfulEvents). Validate and default the fields we
// understand without deleting other learned state on the next mark/reflect
// write. Keep these storage-only schemas private: LLM and import contracts
// continue to use the existing schemas. loadPlaybook bounds the entire raw
// document before this validation, including every retained extension field.
function storedPlaybookSchema(limits: InputLimits) {
  const feedback = FeedbackEventSchema.extend({
    transcriptEvidenceKeys: z.array(FeedbackEventSchema.shape.transcriptEvidenceKeys.unwrap().element)
      .min(1).max(limits.maxArrayLength).optional(),
  }).passthrough();
  const bullet = PlaybookBulletSchema.extend({
    feedbackEvents: z.array(feedback).max(limits.maxArrayLength).default([]),
    sourceSessions: z.array(z.string()).max(limits.maxArrayLength).default([]),
    sourceAgents: z.array(z.string()).max(limits.maxArrayLength).default([]),
    tags: z.array(z.string()).max(limits.maxArrayLength).default([]),
    embedding: z.array(z.number()).max(limits.maxArrayLength).optional(),
  }).passthrough();
  return PlaybookSchema.extend({
    metadata: PlaybookMetadataSchema.passthrough(),
    deprecatedPatterns: z.array(DeprecatedPatternSchema.passthrough())
      .max(limits.maxArrayLength).default([]),
    bullets: z.array(bullet).max(limits.maxArrayLength).default([]),
  }).passthrough();
}

/** Validate bounded persisted state without stripping extension fields. */
export function validateStoredPlaybook(raw: unknown, limits: InputLimits, source: string): Playbook {
  assertInputLimits(raw, limits, source);
  const result = storedPlaybookSchema(limits).safeParse(raw);
  if (!result.success) {
    logError(`Playbook validation failed for ${source}: ${formatValidationIssues(result.error)}`);
    throw new PlaybookValidationError(
      `Playbook at ${source} is invalid. Please fix it manually or remove it to reset.`,
    );
  }
  // Schema defaults also consume resources when an older producer omitted them.
  assertInputLimits(result.data, limits, source);
  return result.data;
}

export interface PlaybookStorageOptions {
  /** Explicit repository/import provenance always wins over local configuration. */
  untrusted?: boolean;
  /** Internal reflection snapshots inherit only their independently trusted destination. */
  limitsSourcePath?: string;
}

async function storageLimits(filePath: string, options: PlaybookStorageOptions): Promise<InputLimits> {
  if (expandPath(filePath).split(/[\\/]/).includes("..")) return PLAYBOOK_INPUT_LIMITS;
  const { resolvePlaybookInputLimits } = await import("./config.js");
  const source = options.limitsSourcePath ?? filePath;
  const limits = await resolvePlaybookInputLimits(source, options);
  if (!options.limitsSourcePath || limits === PLAYBOOK_INPUT_LIMITS
    || path.resolve(expandPath(filePath)) === path.resolve(expandPath(source))) return limits;
  // An internal destination hint is not a general-purpose import bypass. Only
  // private reflection snapshots for that global owner inherit its budget.
  const { reflectionCommitPendingPath } = await import("./reflection-commit.js");
  const pending = reflectionCommitPendingPath(source);
  const target = path.resolve(expandPath(filePath));
  const directory = path.dirname(target);
  const prefix = `${path.basename(pending, ".pending.json")}.`;
  const name = path.basename(directory);
  if (path.dirname(directory) !== path.dirname(pending) || !name.startsWith(prefix)
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.stage$/.test(name.slice(prefix.length))
    || !/^target-(0|[1-9]\d*)\.yaml$/.test(path.basename(target))) return PLAYBOOK_INPUT_LIMITS;
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Trusted reflection snapshots require a private regular directory");
  }
  return limits;
}

// Only a confirmed syntax/schema failure may offer an empty replacement.
// Filesystem errors mean the learned state is unavailable, not corrupt.
class PlaybookValidationError extends Error {}

export function createEmptyPlaybook(name = "playbook"): Playbook {
  return {
    schema_version: 2,
    name,
    description: "Auto-generated from cass-memory reflections",
    metadata: {
      createdAt: now(),
      totalReflections: 0,
      totalSessionsProcessed: 0,
    },
    deprecatedPatterns: [],
    bullets: [],
  };
}

export async function loadPlaybook(filePath: string, options: PlaybookStorageOptions = {}): Promise<Playbook> {
  const expanded = expandPath(filePath);
  const limits = await storageLimits(filePath, options);

  try {
    // Read directly: a forgiving existence probe can turn a transient EIO or
    // permission failure into an empty playbook and erase rules on the next save.
    const content = await readBoundedFile(expanded, limits.maxBytes, { privateFile: limits !== PLAYBOOK_INPUT_LIMITS });
    if (!content.trim()) return createEmptyPlaybook();

    const raw = parseYamlInput(content, limits, expanded);
    return validateStoredPlaybook(raw, limits, expanded);
  } catch (err: any) {
    // Read first; a failed existence probe must never turn a valid file into
    // an empty playbook. Confirm ENOENT is not a dangling or replaced entry.
    if (err.code === "ENOENT" && !(await fileExists(expanded))) {
      return createEmptyPlaybook();
    }
    throw err;
  }
}

export async function savePlaybook(
  playbook: Playbook,
  filePath: string,
  options: PlaybookStorageOptions & { updateLastReflection?: boolean } = {},
): Promise<void> {
  const limits = await storageLimits(filePath, options);
  // Semantic search hydrates vectors in memory from the external cache. They
  // are derived data, not learned state, and must never inflate the YAML again.
  if (playbook.bullets.length > limits.maxArrayLength) {
    throw new InputLimitError(filePath, `maximum array length is ${limits.maxArrayLength}`);
  }
  const persisted = {
    ...playbook,
    metadata: options.updateLastReflection
      ? { ...playbook.metadata, lastReflection: now() } : playbook.metadata,
    bullets: playbook.bullets.map(({ embedding: _embedding, ...bullet }) => bullet),
  };
  validateStoredPlaybook(persisted, limits, filePath);
  // The expanded structure was bounded above. Do not introduce aliases that
  // could make our own saved file exceed the reader's alias-expansion limit.
  const yamlStr = yaml.stringify(persisted, { aliasDuplicateObjects: false });
  assertTextSize(yamlStr, limits.maxBytes, filePath);
  // The validated structure and alias-free encoder preserve the reader's
  // schema/expansion bounds; also preflight its lexical allocation budget.
  assertYamlTokenLimits(yamlStr, limits, filePath);
  const { assertPlaybookWriteAllowed } = await import("./reflection-commit.js");
  await assertPlaybookWriteAllowed(filePath, persisted);
  await atomicWrite(filePath, yamlStr);
  if (options.updateLastReflection) playbook.metadata.lastReflection = persisted.metadata.lastReflection;
}

/**
 * Record one completed reflection run on the playbook's metadata counters.
 *
 * `totalReflections` counts reflection runs that committed at least one
 * session to the processed log; `totalSessionsProcessed` counts the sessions
 * those runs committed. Callers must invoke this once per run, only for
 * sessions that were not already in the processed log, so re-running an
 * already-processed session never inflates either counter (#72).
 */
export function recordReflectionRun(playbook: Playbook, sessionsProcessed: number): void {
  if (!Number.isInteger(sessionsProcessed) || sessionsProcessed <= 0) return;
  playbook.metadata.totalReflections = (playbook.metadata.totalReflections || 0) + 1;
  playbook.metadata.totalSessionsProcessed =
    (playbook.metadata.totalSessionsProcessed || 0) + sessionsProcessed;
}

// --- Error Recovery ---

/** Only the explicit, trusted-local repair operation may use these ceilings. */
export const PLAYBOOK_REPAIR_INPUT_LIMITS = Object.freeze({
  ...PLAYBOOK_INPUT_LIMITS,
  maxBytes: 64 * 1024 * 1024,
  maxNodes: 2_000_000,
  maxArrayLength: 100_000,
});

export interface PlaybookEmbeddingRepairResult {
  path: string;
  dryRun: boolean;
  changed: boolean;
  wouldChange: boolean;
  originalBytes: number;
  repairedBytes: number;
  bytesSaved: number;
  bulletCount: number;
  embeddingsRemoved: number;
  backupPath: string | null;
  sha256Before: string;
  sha256After: string;
  preservationVerified: true;
}

function sameRepairFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size &&
    a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

/** Read a stable regular file without following a final symlink or a FIFO. */
async function readRepairFile(
  filePath: string,
  maxBytes = PLAYBOOK_REPAIR_INPUT_LIMITS.maxBytes,
): Promise<{ bytes: Buffer; stat: Stats }> {
  const before = await fs.lstat(filePath);
  if (!before.isFile() || before.nlink !== 1) {
    throw new Error(`Repair requires a regular local file with no symbolic or hard links: ${filePath}`);
  }
  const handle = await fs.open(
    filePath, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !sameRepairFile(before, stat)) {
      throw new Error("Playbook changed while opening it; stop other writers and retry repair");
    }
    if (stat.size > maxBytes) {
      throw new InputLimitError(filePath, `trusted repair maximum file size is ${maxBytes} bytes`);
    }
    // One sentinel byte detects growth; no read can exceed the fixed ceiling.
    const bytes = Buffer.allocUnsafe(stat.size + 1);
    let total = 0;
    while (total < bytes.length) {
      const read = await handle.read(bytes, total, Math.min(64 * 1024, bytes.length - total), null);
      if (read.bytesRead === 0) break;
      total += read.bytesRead;
    }
    if (total !== stat.size || !sameRepairFile(stat, await handle.stat()) ||
        !sameRepairFile(stat, await fs.lstat(filePath))) {
      throw new Error("Playbook changed while reading it; stop other writers and retry repair");
    }
    return { bytes: bytes.subarray(0, total), stat };
  } finally {
    await handle.close();
  }
}

function parseRepairPlaybook(content: string, source: string): Record<string, unknown> {
  assertTextSize(content, PLAYBOOK_REPAIR_INPUT_LIMITS.maxBytes, source);
  try {
    // Bound parser allocation before constructing the YAML document, including
    // legacy vectors that exceed the ordinary expanded-value ceiling.
    let tokens = 0;
    for (const token of new Lexer().lex(content)) {
      if (token === "\x02" || token === "\x1f" || /^[ \t\r\n]*$/.test(token)) continue;
      if (++tokens > PLAYBOOK_REPAIR_INPUT_LIMITS.maxNodes * 4) {
        throw new InputLimitError(source, "trusted repair YAML token count exceeded");
      }
    }
    const document = yaml.parseDocument(content, {
      resolveKnownTags: false,
      prettyErrors: false,
    });
    // Coerced/duplicate keys or unsupported tags can silently lose state before
    // a round-trip comparison. Fail closed instead of guessing their meaning.
    const problem = document.errors[0] ?? document.warnings[0];
    if (problem) throw new Error(`Cannot safely repair YAML: ${problem.message.slice(0, 500)}`);
    // Inspect the AST before conversion: coercing numeric/complex keys to JS
    // property names can collide or change their meaning before comparison.
    // Recurse only to the fixed depth bound, without following aliases here.
    let nodes = 0;
    const checkKeys = (node: unknown, depth: number): void => {
      if (++nodes > PLAYBOOK_REPAIR_INPUT_LIMITS.maxNodes ||
          depth > PLAYBOOK_REPAIR_INPUT_LIMITS.maxDepth) {
        throw new InputLimitError(source, "trusted repair YAML structure exceeds safe limits");
      }
      if (isMap(node)) {
        if (node.items.length > PLAYBOOK_REPAIR_INPUT_LIMITS.maxObjectKeys) {
          throw new InputLimitError(source, "trusted repair maximum object key count exceeded");
        }
        for (const pair of node.items) {
          if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
            throw new Error("Cannot safely repair YAML with non-string or complex mapping keys");
          }
          checkKeys(pair.value, depth + 1);
        }
      } else if (isSeq(node)) {
        if (node.items.length > PLAYBOOK_REPAIR_INPUT_LIMITS.maxArrayLength) {
          throw new InputLimitError(source, "trusted repair maximum array length exceeded");
        }
        for (const item of node.items) checkKeys(item, depth + 1);
      }
    };
    checkKeys(document.contents, 0);
    const raw: unknown = document.toJS({ maxAliasCount: 100 });
    assertInputLimits(raw, PLAYBOOK_REPAIR_INPUT_LIMITS, source);
    if (!raw || typeof raw !== "object" || Array.isArray(raw) ||
        !Array.isArray((raw as Record<string, unknown>).bullets)) {
      throw new Error("Repair requires a playbook object with an explicit bullets array");
    }
    return raw as Record<string, unknown>;
  } catch (err) {
    if (err instanceof RangeError ||
        (err instanceof Error && /Excessive alias count|resource exhaustion/i.test(err.message))) {
      throw new InputLimitError(source, "trusted repair YAML nesting or alias expansion exceeds safe limits");
    }
    throw err;
  }
}

/** Called only after structural bounds/cycle checks; recursion is at most 32. */
function assertRepairStateIsLossless(value: unknown): void {
  if (typeof value === "number" &&
      (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) {
    throw new Error("Cannot safely repair non-finite numbers or unsafe integers in learned state");
  }
  if (value === null || typeof value !== "object") return;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null) {
    throw new Error("Cannot safely repair non-plain YAML values in learned state");
  }
  for (const child of Object.values(value)) assertRepairStateIsLossless(child);
}

async function syncRepairDirectory(directory: string): Promise<void> {
  // Node cannot open directories for fsync on Windows. File flushes and a
  // single replacement rename still apply there; never move the source aside.
  if (process.platform === "win32") return;
  const handle = await fs.open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Keep a verified, durable original before replacing a playbook. Both explicit
 * vector repair and retired-rule archival use this publication protocol.
 * Callers hold the writer lock and validate the exact replacement beforehand.
 */
async function replacePlaybookWithSnapshot(
  target: string,
  original: { bytes: Buffer; stat: Stats },
  replacement: Buffer,
  options: {
    operation: "repair" | "archive";
    snapshotPath: string;
    temporaryPath: string;
    assertAuthority?: () => Promise<void>;
  },
): Promise<void> {
  const directory = path.dirname(target);
  const { snapshotPath, temporaryPath } = options;
  const archiving = options.operation === "archive";
  const assertUnchanged = async (): Promise<void> => {
    await options.assertAuthority?.();
    const current = await readRepairFile(target);
    if (!sameRepairFile(original.stat, current.stat) || !current.bytes.equals(original.bytes)) {
      throw new Error(`Playbook changed during ${archiving ? "archival" : "repair"}; stop other writers and retry`);
    }
  };
  let snapshotCreated = false;
  let temporaryCreated = false;
  let replaced = false;
  let snapshotVerified = false;
  try {
    await assertUnchanged();
    const snapshot = await fs.open(snapshotPath, "wx", 0o600);
    snapshotCreated = true;
    try {
      await snapshot.writeFile(original.bytes);
      await snapshot.sync();
    } finally {
      await snapshot.close();
    }
    const verified = await readRepairFile(snapshotPath);
    if (!verified.bytes.equals(original.bytes)) {
      throw new Error(archiving ? "Archive verification failed" : "Backup verification failed");
    }
    // The original's directory entry must be durable before any replacement.
    await syncRepairDirectory(directory);
    snapshotVerified = true;

    const temporary = await fs.open(temporaryPath, "wx", 0o600);
    temporaryCreated = true;
    try {
      await temporary.writeFile(replacement);
      await temporary.sync();
    } finally {
      await temporary.close();
    }
    const staged = await readRepairFile(temporaryPath);
    if (!staged.bytes.equals(replacement)) {
      throw new Error(archiving ? "Active playbook verification failed" : "Repaired file verification failed");
    }
    await assertUnchanged();
    await fs.rename(temporaryPath, target);
    replaced = true;
    temporaryCreated = false;
    await syncRepairDirectory(directory);
  } catch (err) {
    const state = replaced
      ? archiving ? "Archived playbook installed, but final directory flush failed" : "Repaired file installed, but final directory flush failed"
      : archiving ? "Archive aborted" : "Repair aborted";
    const noun = archiving ? "archive" : "backup";
    const snapshot = snapshotCreated
      ? `; ${snapshotVerified ? `verified original ${noun}` : `${noun} file (may be incomplete)`}: ${snapshotPath}` : "";
    throw new Error(`${state}${snapshot}: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    // Originals and partial originals are never automatically pruned.
    if (temporaryCreated) await fs.unlink(temporaryPath).catch(() => {});
  }
}

/**
 * Explicit recovery for a TRUSTED local legacy playbook. Ordinary readers and
 * imports never call this. Only bullets[*].embedding is removed; no schema
 * defaults, migrations, filtering or rescoring are applied to learned state.
 * The external cache is deliberately untouched: inline vectors lack reliable
 * model provenance, while existing cache entries remain usable by ID/content.
 */
export async function repairPlaybookEmbeddings(
  filePath: string,
  options: { dryRun?: boolean } = {},
): Promise<PlaybookEmbeddingRepairResult> {
  const expanded = path.resolve(expandPath(filePath));
  const directory = await fs.realpath(path.dirname(expanded));
  const target = path.join(directory, path.basename(expanded));
  const dryRun = options.dryRun === true;

  const repair = async (): Promise<PlaybookEmbeddingRepairResult> => {
    const { resolvePlaybookInputLimits } = await import("./config.js");
    // An explicit file repair historically works with unrelated broken config.
    // Failed authority resolution can only fall back to the strict defaults.
    // Keep the supplied provenance even after resolving the directory for the
    // locked replacement: a repository alias must not acquire global budgets.
    const limits = await resolvePlaybookInputLimits(filePath).catch(() => PLAYBOOK_INPUT_LIMITS);
    const original = await readRepairFile(target);
    // Re-encoding a lossy UTF-8 decode could silently alter learned text.
    const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(original.bytes);
    const raw = parseRepairPlaybook(content, target);
    let embeddingsRemoved = 0;
    const bullets = (raw.bullets as unknown[]).map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Cannot repair a playbook containing a non-object bullet");
      }
      const bullet = value as Record<string, unknown>;
      if (!Object.hasOwn(bullet, "embedding")) return { ...bullet };
      if (!Array.isArray(bullet.embedding) ||
          !bullet.embedding.every((n) => typeof n === "number" && Number.isFinite(n))) {
        throw new Error("Cannot strip an embedding that is not a derived numeric vector");
      }
      embeddingsRemoved++;
      // Clone rather than delete: an alias outside bullets may refer to the
      // same object, and its fields must remain completely untouched.
      const { embedding: _embedding, ...surviving } = bullet;
      return surviving;
    });
    const repaired = { ...raw, bullets };
    assertInputLimits(repaired, limits, target);
    assertRepairStateIsLossless(repaired);
    const candidate = embeddingsRemoved > 0
      ? yaml.stringify(repaired, { aliasDuplicateObjects: false })
      : content;
    const reparsed = parseYamlInput(candidate, limits, target);
    validateStoredPlaybook(reparsed, limits, target);
    if (!isDeepStrictEqual(repaired, reparsed)) {
      throw new Error("Repair preservation check failed; no playbook data was replaced");
    }
    const replacement = embeddingsRemoved > 0 ? Buffer.from(candidate, "utf8") : original.bytes;
    const sha256 = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");
    const result: PlaybookEmbeddingRepairResult = {
      path: target, dryRun, changed: false, wouldChange: embeddingsRemoved > 0,
      originalBytes: original.bytes.length, repairedBytes: replacement.length,
      bytesSaved: original.bytes.length - replacement.length,
      bulletCount: bullets.length, embeddingsRemoved, backupPath: null,
      sha256Before: sha256(original.bytes), sha256After: sha256(replacement),
      preservationVerified: true,
    };
    if (dryRun || embeddingsRemoved === 0) return result;
    const { assertPlaybookWriteAllowed } = await import("./reflection-commit.js");
    await assertPlaybookWriteAllowed(target, repaired);

    const suffix = `${new Date().toISOString().replace(/[:.]/g, "-")}.${crypto.randomUUID()}`;
    const backupPath = `${target}.backup.strip-embeddings.${suffix}`;
    const temporaryPath = `${target}.repair.${suffix}.tmp`;
    await replacePlaybookWithSnapshot(target, original, replacement, {
      operation: "repair", snapshotPath: backupPath, temporaryPath,
    });
    result.backupPath = backupPath;
    result.changed = true;
    return result;
  };
  // A preview must not create a lock, backup, temporary file or directory.
  return dryRun ? repair() : withLock(target, repair);
}

function isRetiredForArchive(bullet: Pick<PlaybookBullet, "state" | "maturity" | "deprecated">): boolean {
  return bullet.state === "retired" || bullet.maturity === "deprecated" || bullet.deprecated === true;
}

/** Counts only explicit retirement/deprecation; absent feedback is not evidence. */
export function getRetiredPlaybookArchiveCounts(playbook: {
  bullets: ReadonlyArray<Pick<PlaybookBullet, "state" | "maturity" | "deprecated" | "pinned">>;
}): {
  eligibleBulletCount: number;
  protectedBulletCount: number;
} {
  let eligibleBulletCount = 0;
  let protectedBulletCount = 0;
  for (const bullet of playbook.bullets) {
    if (!isRetiredForArchive(bullet)) continue;
    if (bullet.pinned) protectedBulletCount++;
    else eligibleBulletCount++;
  }
  return { eligibleBulletCount, protectedBulletCount };
}

export interface PlaybookRetiredArchiveResult {
  path: string;
  dryRun: boolean;
  changed: boolean;
  wouldChange: boolean;
  originalBytes: number;
  activeBytes: number;
  bytesSaved: number;
  bulletCount: number;
  archivedBulletCount: number;
  retainedBulletCount: number;
  protectedRetiredBulletCount: number;
  archivedBulletIds: string[];
  archivePath: string | null;
  sha256Before: string;
  sha256After: string;
  preservationVerified: true;
}

/**
 * Operator-authorized archival of already-retired, unpinned rules. The archive
 * is the complete original file, including all learned history and metadata.
 * Active state changes only by removing the selected bullets from its array.
 */
export async function archiveRetiredPlaybook(
  filePath: string,
  options: { dryRun?: boolean } = {},
): Promise<PlaybookRetiredArchiveResult> {
  const { resolveTrustedPlaybookPolicy } = await import("./config.js");
  if (expandPath(filePath).split(/[\\/]/).includes("..")) {
    throw new Error("Archival requires an unambiguous trusted global playbook path without '..' components");
  }
  const requested = path.resolve(expandPath(filePath));
  const selected = await resolveTrustedPlaybookPolicy();
  if (!selected.trusted || requested !== selected.path ||
      requested === path.resolve(selected.configFile.path)) {
    throw new Error("Retired-rule archival requires the independently configured trusted global playbook; repository, imported, linked, and arbitrary files are not eligible");
  }
  const dryRun = options.dryRun === true;
  const archive = async (): Promise<PlaybookRetiredArchiveResult> => {
    const policy = await resolveTrustedPlaybookPolicy();
    if (!policy.trusted || policy.path !== selected.path ||
        policy.configFile.path !== selected.configFile.path) {
      throw new Error("Trusted configuration changed while starting archival; retry with the current global playbook");
    }
    const original = await readRepairFile(requested);
    const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(original.bytes);
    const raw = parseRepairPlaybook(content, requested);
    assertRepairStateIsLossless(raw);
    const validated = validateStoredPlaybook(raw, PLAYBOOK_REPAIR_INPUT_LIMITS, requested);
    const counts = getRetiredPlaybookArchiveCounts(validated);
    const rawBullets = raw.bullets as PlaybookBullet[];
    const archived = rawBullets.filter(bullet => isRetiredForArchive(bullet) && !bullet.pinned);
    const surviving = rawBullets.filter(bullet => !isRetiredForArchive(bullet) || bullet.pinned);
    const active = { ...raw, bullets: surviving };
    const candidate = archived.length ? yaml.stringify(active, { aliasDuplicateObjects: false }) : content;
    try {
      const reparsed = parseYamlInput(candidate, policy.limits, requested);
      validateStoredPlaybook(reparsed, policy.limits, requested);
      if (!isDeepStrictEqual(active, reparsed)) {
        throw new Error("Archive preservation check failed; no learned state was replaced");
      }
    } catch (error) {
      if (error instanceof InputLimitError) {
        throw new InputLimitError(requested,
          `remaining playbook after archiving ${archived.length} retired rules still exceeds its selected limits; preview cm playbook repair --recover-limits --dry-run first (${error.message})`);
      }
      throw error;
    }
    const replacement = archived.length ? Buffer.from(candidate, "utf8") : original.bytes;
    const sha256 = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");
    const result: PlaybookRetiredArchiveResult = {
      path: requested, dryRun, changed: false, wouldChange: archived.length > 0,
      originalBytes: original.bytes.length, activeBytes: replacement.length,
      bytesSaved: original.bytes.length - replacement.length,
      bulletCount: rawBullets.length, archivedBulletCount: archived.length,
      retainedBulletCount: surviving.length, protectedRetiredBulletCount: counts.protectedBulletCount,
      archivedBulletIds: archived.map(bullet => bullet.id), archivePath: null,
      sha256Before: sha256(original.bytes), sha256After: sha256(replacement), preservationVerified: true,
    };
    const { assertPlaybookArchiveAllowed } = await import("./reflection-commit.js");
    const assertAuthority = async (): Promise<void> => {
      const currentPolicy = await resolveTrustedPlaybookPolicy();
      if (!currentPolicy.trusted || currentPolicy.path !== policy.path ||
          currentPolicy.configFile.path !== policy.configFile.path ||
          !isDeepStrictEqual(currentPolicy.limits, policy.limits)) {
        throw new Error("Trusted playbook authority or limits changed during archival; no active state was replaced");
      }
      // Removing an ID before queued feedback drains would make that feedback
      // undeliverable. A retained commit receipt alone cannot protect it.
      await assertPlaybookArchiveAllowed(requested);
    };
    await assertAuthority();
    if (dryRun || !archived.length) {
      const current = await readRepairFile(requested);
      if (!sameRepairFile(original.stat, current.stat) || !current.bytes.equals(original.bytes)) {
        throw new Error("Playbook changed during archival preview; stop other writers and retry");
      }
      return result;
    }
    const suffix = `${new Date().toISOString().replace(/[:.]/g, "-")}.${crypto.randomUUID()}`;
    const archivePath = `${requested}.archive.retired.${suffix}.yaml`;
    await replacePlaybookWithSnapshot(requested, original, replacement, {
      operation: "archive", snapshotPath: archivePath,
      temporaryPath: `${requested}.archive.${suffix}.tmp`, assertAuthority,
    });
    result.archivePath = archivePath;
    result.changed = true;
    return result;
  };
  // Inspection creates neither locks nor files. Application locks the owner
  // and its policy in the same order as trusted-limit recovery.
  if (dryRun) return archive();
  const locks = [selected.configFile.path, requested].sort();
  return withLock(locks[0], () => withLock(locks[1], archive));
}

type RecoverablePlaybookLimits = {
  -readonly [K in "maxBytes" | "maxNodes" | "maxArrayLength"]: import("./input-limits.js").InputLimits[K];
};

export interface PlaybookLimitRecoveryResult {
  path: string;
  configPath: string;
  dryRun: boolean;
  changed: boolean;
  wouldChange: boolean;
  bulletCount: number;
  originalBytes: number;
  usage: {
    expandedValues: number;
    expandedTextBytes: number;
    maxArrayLength: number;
    normalizedValues: number;
    normalizedBytes: number;
  };
  proposedLimits: RecoverablePlaybookLimits;
  effectiveLimits: import("./input-limits.js").InputLimits;
  backupPath: string | null;
  sha256Before: string;
  sha256After: string;
  preservationVerified: true;
}

/**
 * Explicitly recover the trusted global owner by configuring sufficient bounded
 * limits. The playbook is never rewritten: even formatting and legacy vectors
 * remain byte-for-byte identical. Repository files cannot authorize this path.
 */
export async function recoverTrustedPlaybookLimits(
  filePath: string,
  options: { dryRun?: boolean } = {},
): Promise<PlaybookLimitRecoveryResult> {
  const { resolveTrustedPlaybookPolicy, readGlobalConfigRaw } = await import("./config.js");
  const { CONFIG_INPUT_LIMITS, measureInputUsage, parseJsonInput } = await import("./input-limits.js");
  if (expandPath(filePath).split(/[\\/]/).includes("..")) {
    throw new Error("Limit recovery requires an unambiguous trusted global playbook path without '..' components");
  }
  const requested = path.resolve(expandPath(filePath));
  const selected = await resolveTrustedPlaybookPolicy();
  if (!selected.trusted || requested !== path.resolve(selected.path)) {
    throw new Error("Limit recovery requires the independently configured trusted global playbook; repository, imported, linked, and arbitrary files cannot raise their limits");
  }
  if (requested === path.resolve(selected.configFile.path)) {
    throw new Error("The playbook and its trusted configuration must be different files");
  }
  const dryRun = options.dryRun === true;

  const recover = async (): Promise<PlaybookLimitRecoveryResult> => {
    const policy = await resolveTrustedPlaybookPolicy();
    if (!policy.trusted || policy.path !== selected.path ||
        policy.configFile.path !== selected.configFile.path) {
      throw new Error("Trusted configuration changed while starting recovery; retry with the current global playbook");
    }
    const original = await readRepairFile(requested);
    const configSnapshot = policy.configFile.exists
      ? await readRepairFile(policy.configFile.path, CONFIG_INPUT_LIMITS.maxBytes)
      : null;
    if (configSnapshot) {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(configSnapshot.bytes);
      if (policy.configFile.format === "json") {
        const parsed = parseJsonInput(text, CONFIG_INPUT_LIMITS, policy.configFile.path);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("Trusted configuration must be an object; recovery will not replace scalar or array configuration");
        }
      } else {
        parseYamlInput(text, CONFIG_INPUT_LIMITS, policy.configFile.path);
        const document = yaml.parseDocument(text);
        if (document.contents !== null && !isMap(document.contents)) {
          throw new Error("Trusted configuration must be a mapping; recovery will not replace scalar or array configuration");
        }
      }
    }
    const { file: configFile, data: configData } = await readGlobalConfigRaw();
    if (configData === null || configFile.path !== policy.configFile.path ||
        configFile.exists !== policy.configFile.exists) {
      throw new Error("Trusted configuration is invalid or changed; no recovery settings were written");
    }
    if (configSnapshot && configFile.format === "json") {
      // JSON.parse can round unsafe integers, accept overflow as Infinity, or
      // discard duplicate keys. A recovery must not rewrite unrelated operator
      // metadata after those losses. Validate before even offering a preview.
      const configText = new TextDecoder("utf-8", { fatal: true }).decode(configSnapshot.bytes);
      assertYamlTokenLimits(configText, CONFIG_INPUT_LIMITS, configFile.path);
      const document = yaml.parseDocument(configText, { resolveKnownTags: false, prettyErrors: false });
      const problem = document.errors[0] ?? document.warnings[0];
      if (problem) throw new Error(`Cannot safely update trusted configuration: ${problem.message.slice(0, 500)}`);
      assertRepairStateIsLossless(configData);
      const roundTrip = parseJsonInput(JSON.stringify(configData), CONFIG_INPUT_LIMITS, configFile.path);
      if (!isDeepStrictEqual(configData, roundTrip)) {
        throw new Error("Cannot safely update trusted configuration without changing unrelated values");
      }
    }

    const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(original.bytes);
    const raw = parseRepairPlaybook(content, requested);
    assertRepairStateIsLossless(raw);
    const validated = validateStoredPlaybook(raw, PLAYBOOK_REPAIR_INPUT_LIMITS, requested);
    const rawUsage = measureInputUsage(raw, PLAYBOOK_REPAIR_INPUT_LIMITS, requested);
    const normalizedUsage = measureInputUsage(validated, PLAYBOOK_REPAIR_INPUT_LIMITS, requested);
    // Defaults introduced by schema validation must also fit the next write.
    const normalizedYaml = yaml.stringify(validated, { aliasDuplicateObjects: false });
    assertTextSize(normalizedYaml, PLAYBOOK_REPAIR_INPUT_LIMITS.maxBytes, requested);
    let tokens = 0;
    for (const token of new Lexer().lex(content)) {
      if (token !== "\x02" && token !== "\x1f" && !/^[ \t\r\n]*$/.test(token)) tokens++;
    }
    const required: RecoverablePlaybookLimits = {
      maxNodes: Math.max(rawUsage.nodes, normalizedUsage.nodes, Math.ceil(tokens / 4)),
      maxBytes: Math.max(original.bytes.length, Buffer.byteLength(normalizedYaml, "utf8"),
        rawUsage.expandedTextBytes, normalizedUsage.expandedTextBytes),
      maxArrayLength: Math.max(rawUsage.maxArrayLength, normalizedUsage.maxArrayLength),
    };
    const keys = ["maxBytes", "maxNodes", "maxArrayLength"] as const;
    const proposedLimits: RecoverablePlaybookLimits = {
      maxBytes: policy.limits.maxBytes,
      maxNodes: policy.limits.maxNodes,
      maxArrayLength: policy.limits.maxArrayLength,
    };
    const envNames = {
      maxBytes: "CM_PLAYBOOK_MAX_BYTES",
      maxNodes: "CM_PLAYBOOK_MAX_NODES",
      maxArrayLength: "CM_PLAYBOOK_MAX_ARRAY_LENGTH",
    } as const;
    let wouldChange = false;
    for (const key of keys) {
      if (required[key] <= policy.limits[key]) continue;
      const envName = envNames[key];
      if (process.env[envName] !== undefined) {
        throw new Error(`${envName} overrides trusted configuration and is too small for this playbook (${required[key]} required); unset it or explicitly increase it before recovery`);
      }
      if (required[key] > PLAYBOOK_REPAIR_INPUT_LIMITS[key]) {
        throw new InputLimitError(requested, `trusted recovery ${key} ceiling is ${PLAYBOOK_REPAIR_INPUT_LIMITS[key]}`);
      }
      // Leave modest room for subsequent feedback/reflection, bounded by the
      // immutable ceiling. No existing choice is lowered or set to infinity.
      proposedLimits[key] = Math.min(PLAYBOOK_REPAIR_INPUT_LIMITS[key], Math.ceil(required[key] * 1.25));
      wouldChange = true;
    }
    const effectiveLimits = { ...policy.limits, ...proposedLimits };
    parseYamlInput(content, effectiveLimits, requested);
    validateStoredPlaybook(raw, effectiveLimits, requested);
    assertTextSize(normalizedYaml, effectiveLimits.maxBytes, requested);
    assertYamlTokenLimits(normalizedYaml, effectiveLimits, requested);

    const digest = crypto.createHash("sha256").update(original.bytes).digest("hex");
    const result: PlaybookLimitRecoveryResult = {
      path: requested, configPath: policy.configFile.path, dryRun,
      changed: false, wouldChange, bulletCount: (raw.bullets as unknown[]).length,
      originalBytes: original.bytes.length,
      usage: { expandedValues: rawUsage.nodes, expandedTextBytes: rawUsage.expandedTextBytes,
        maxArrayLength: rawUsage.maxArrayLength, normalizedValues: normalizedUsage.nodes,
        normalizedBytes: Buffer.byteLength(normalizedYaml, "utf8") },
      proposedLimits, effectiveLimits, backupPath: null,
      sha256Before: digest, sha256After: digest, preservationVerified: true,
    };

    const assertUnchanged = async (): Promise<void> => {
      const currentPolicy = await resolveTrustedPlaybookPolicy();
      if (!currentPolicy.trusted || currentPolicy.path !== policy.path ||
          currentPolicy.configFile.path !== policy.configFile.path ||
          currentPolicy.configFile.exists !== policy.configFile.exists ||
          !isDeepStrictEqual(currentPolicy.limits, policy.limits)) {
        throw new Error("Trusted configuration changed during recovery; no settings were replaced");
      }
      const current = await readRepairFile(requested);
      if (!sameRepairFile(original.stat, current.stat) || !current.bytes.equals(original.bytes)) {
        throw new Error("Playbook changed during recovery; stop other writers and retry");
      }
      if (configSnapshot) {
        const currentConfig = await readRepairFile(policy.configFile.path, CONFIG_INPUT_LIMITS.maxBytes);
        if (!sameRepairFile(configSnapshot.stat, currentConfig.stat) ||
            !currentConfig.bytes.equals(configSnapshot.bytes)) {
          throw new Error("Configuration changed during recovery; no settings were replaced");
        }
      } else if (await fileExists(policy.configFile.path)) {
        throw new Error("Configuration was created during recovery; retry without replacing it");
      }
    };
    await assertUnchanged();
    if (!wouldChange) return result;

    const previousLimits = configData.playbookLimits;
    const patch = {
      ...(previousLimits && typeof previousLimits === "object" && !Array.isArray(previousLimits)
        ? previousLimits as Record<string, unknown> : {}),
      ...proposedLimits,
    };
    let replacement: string;
    if (policy.configFile.format === "json") {
      replacement = JSON.stringify({ ...configData, playbookLimits: patch }, null, 2);
      parseJsonInput(replacement, CONFIG_INPUT_LIMITS, policy.configFile.path);
    } else {
      const originalConfig = configSnapshot
        ? new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(configSnapshot.bytes) : "";
      const doc = yaml.parseDocument(originalConfig);
      const problem = doc.errors[0] ?? doc.warnings[0];
      if (problem) throw new Error(`Cannot safely update trusted configuration: ${problem.message}`);
      if (doc.has("playbook_limits")) doc.delete("playbook_limits");
      doc.set("playbookLimits", patch);
      replacement = doc.toString();
      parseYamlInput(replacement, CONFIG_INPUT_LIMITS, policy.configFile.path);
    }
    if (dryRun) return result;

    const directory = path.dirname(policy.configFile.path);
    const suffix = `${new Date().toISOString().replace(/[:.]/g, "-")}.${crypto.randomUUID()}`;
    const temporaryPath = `${policy.configFile.path}.recover-limits.${suffix}.tmp`;
    let temporaryCreated = false;
    let replaced = false;
    let backupVerified = false;
    try {
      if (configSnapshot) {
        const backupPath = `${policy.configFile.path}.backup.recover-limits.${suffix}`;
        const backup = await fs.open(backupPath, "wx", 0o600);
        result.backupPath = backupPath;
        try {
          await backup.writeFile(configSnapshot.bytes);
          await backup.sync();
        } finally {
          await backup.close();
        }
        const verified = await readRepairFile(backupPath, CONFIG_INPUT_LIMITS.maxBytes);
        if (!verified.bytes.equals(configSnapshot.bytes)) throw new Error("Configuration backup verification failed");
        await syncRepairDirectory(directory);
        backupVerified = true;
      }
      const temporary = await fs.open(temporaryPath, "wx", 0o600);
      temporaryCreated = true;
      try {
        await temporary.writeFile(replacement, "utf8");
        await temporary.sync();
      } finally {
        await temporary.close();
      }
      const staged = await readRepairFile(temporaryPath, CONFIG_INPUT_LIMITS.maxBytes);
      if (!staged.bytes.equals(Buffer.from(replacement, "utf8"))) throw new Error("Recovery settings verification failed");
      await assertUnchanged();
      await fs.rename(temporaryPath, policy.configFile.path);
      replaced = true;
      temporaryCreated = false;
      await syncRepairDirectory(directory);
      result.changed = true;
      return result;
    } catch (err) {
      const state = replaced ? "Recovery settings installed, but final directory flush failed" : "Limit recovery aborted";
      const backup = result.backupPath
        ? `; ${backupVerified ? "verified configuration backup" : "configuration backup (may be incomplete)"}: ${result.backupPath}` : "";
      throw new Error(`${state}; playbook was not modified${backup}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (temporaryCreated) await fs.unlink(temporaryPath).catch(() => {});
    }
  };
  if (dryRun) return recover();
  const locks = [selected.configFile.path, requested].sort();
  return withLock(locks[0], () => withLock(locks[1], recover));
}

export interface PlaybookRecoveryResult {
  playbook: Playbook;
  backupPath: string | null;
  errorType: "parse_error" | "validation_error" | "truncation" | "unknown";
  originalError: Error;
}

/**
 * Recover from a corrupt or malformed playbook file.
 *
 * Prioritizes data safety:
 * 1. Backs up the corrupt file to {path}.backup.{timestamp}
 * 2. Logs the corruption details
 * 3. Creates a fresh empty playbook
 * 4. Returns recovery result with backup location
 *
 * @param playbookPath - Path to the corrupt playbook file
 * @param error - The error that was thrown during loading
 * @returns Recovery result with new playbook and backup info
 */
export async function recoverCorruptPlaybook(
  playbookPath: string,
  error: Error,
): Promise<PlaybookRecoveryResult> {
  // Resource limits, I/O failures and unexpected implementation errors are
  // not evidence of corruption. Never offer an empty replacement for them.
  if (!(error instanceof YAMLParseError) && !(error instanceof PlaybookValidationError)) throw error;
  const expanded = expandPath(playbookPath);
  const newPlaybook = createEmptyPlaybook(path.basename(expanded, path.extname(expanded)));
  const { assertPlaybookWriteAllowed } = await import("./reflection-commit.js");
  await assertPlaybookWriteAllowed(expanded, newPlaybook);
  let backupPath: string | null = null;

  // Determine error type for better diagnostics
  let errorType: PlaybookRecoveryResult["errorType"] = "unknown";
  if (
    error.message.includes("YAML") ||
    error.message.includes("parse") ||
    error.message.includes("Unexpected")
  ) {
    errorType = "parse_error";
  } else if (
    error.message.includes("validation") ||
    error.message.includes("invalid") ||
    error.name === "ZodError"
  ) {
    errorType = "validation_error";
  } else if (error.message.includes("truncat") || error.message.includes("incomplete")) {
    errorType = "truncation";
  }

  // Step 1: A replacement is safe to offer only after the original is backed
  // up. Use a unique, exclusive destination so concurrent attempts cannot
  // overwrite an earlier recovery copy.
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const candidateBackup = `${expanded}.backup.${timestamp}.${crypto.randomUUID()}`;
  try {
    await fs.copyFile(expanded, candidateBackup, constants.COPYFILE_EXCL);
    backupPath = candidateBackup;
    log(`Backed up corrupt playbook to: ${backupPath}`, true);
  } catch (backupErr: any) {
    throw new Error(
      `Playbook recovery aborted: could not create backup at ${candidateBackup}: ${backupErr.message}`,
      { cause: backupErr },
    );
  }

  // Step 2: Log the corruption details
  logError(`Playbook recovery triggered for ${expanded}`);
  logError(`Error type: ${errorType}`);
  logError(`Original error: ${error.message}`);

  if (backupPath) {
    log(`Your original data was saved to: ${backupPath}`, true);
    log(`You can attempt manual recovery by examining the backup file.`, true);
  }

  // Step 3: Log recovery instructions for the replacement prepared above.
  log(`Created new empty playbook. Previous rules need manual recovery from backup.`, true);
  log(`To recover manually:`, true);
  log(`  1. Open ${backupPath || "the backup file"}`, true);
  log(`  2. Fix any syntax errors`, true);
  log(`  3. Copy valid bullets to the new playbook`, true);

  return {
    playbook: newPlaybook,
    backupPath,
    errorType,
    originalError: error,
  };
}

/**
 * Load playbook with automatic recovery on corruption.
 *
 * Use this when you want graceful degradation instead of hard failure.
 * Returns both the playbook and recovery info if recovery was needed.
 */
export async function loadPlaybookWithRecovery(
  filePath: string,
): Promise<{ playbook: Playbook; recovered: boolean; recovery?: PlaybookRecoveryResult }> {
  try {
    const playbook = await loadPlaybook(filePath);
    return { playbook, recovered: false };
  } catch (err: any) {
    // Filesystem failures are not evidence that learned state is corrupt.
    if (!(err instanceof YAMLParseError) && !(err instanceof PlaybookValidationError)) {
      throw err;
    }

    const recovery = await recoverCorruptPlaybook(filePath, err);
    return {
      playbook: recovery.playbook,
      recovered: true,
      recovery,
    };
  }
}

// --- Cascading & Merging ---

export async function loadBlockedLog(logPath: string): Promise<ToxicEntry[]> {
  const expanded = expandPath(logPath);

  try {
    const content = await readBoundedFile(expanded, PLAYBOOK_INPUT_LIMITS.maxBytes);
    const entries: ToxicEntry[] = [];

    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const entry = JSON.parse(trimmed);
        // Validate required fields
        if (entry.id && entry.content) {
          entries.push(entry);
        }
      } catch {
        // Skip malformed lines - don't let one bad line corrupt the whole log
        warn(`Skipping malformed line in blocked log: ${trimmed.slice(0, 50)}...`);
      }
    }
    return entries;
  } catch (err: any) {
    if (err?.code === "ENOENT" && !(await fileExists(expanded))) return [];
    // Ignoring an unreadable or oversized block list would silently re-enable
    // rules the user explicitly blocked.
    throw err;
  }
}

export async function appendBlockedLog(entry: BlockedEntry, logPath: string): Promise<void> {
  const expanded = expandPath(logPath);
  await withLock(expanded, async () => {
    await ensureDir(path.dirname(expanded));
    await fs.appendFile(expanded, JSON.stringify(entry) + "\n", "utf-8");
  });
}

/**
 * Remove an entry from the blocked log by bullet ID.
 * This is needed when un-deprecating a bullet that was forgotten.
 */
export async function removeFromBlockedLog(bulletId: string, logPath: string): Promise<boolean> {
  const expanded = expandPath(logPath);
  return await withLock(expanded, async () => {
    try {
      const content = await readBoundedFile(expanded, PLAYBOOK_INPUT_LIMITS.maxBytes);
      const lines = content.split("\n");
      const filteredLines: string[] = [];
      let found = false;

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const entry = JSON.parse(trimmed);
          if (entry.id === bulletId) {
            found = true;
            continue; // Skip this entry
          }
          filteredLines.push(trimmed);
        } catch {
          // Keep malformed lines to not lose data
          filteredLines.push(trimmed);
        }
      }

      if (found) {
        // Write back the filtered entries
        const newContent = filteredLines.length > 0 ? filteredLines.join("\n") + "\n" : "";
        await atomicWrite(expanded, newContent);
      }

      return found;
    } catch (err: any) {
      if (err?.code === "ENOENT" && !(await fileExists(expanded))) return false;
      throw err;
    }
  });
}

export function mergePlaybooks(global: Playbook, repo: Playbook | null): Playbook {
  if (!repo) return global;

  const merged = createEmptyPlaybook("merged-playbook");
  merged.metadata = { ...global.metadata };

  const bulletMap = new Map<string, PlaybookBullet>();

  for (const b of global.bullets) {
    bulletMap.set(b.id, b);
  }

  for (const b of repo.bullets) {
    bulletMap.set(b.id, b);
  }

  merged.bullets = Array.from(bulletMap.values());

  // Deduplicate deprecated patterns
  const seenPatterns = new Set<string>();
  const uniqueDeprecatedPatterns: Array<
    z.infer<typeof import("./types.js").DeprecatedPatternSchema>
  > = [];

  for (const p of [...global.deprecatedPatterns, ...repo.deprecatedPatterns]) {
    if (!seenPatterns.has(p.pattern)) {
      seenPatterns.add(p.pattern);
      uniqueDeprecatedPatterns.push(p);
    }
  }

  merged.deprecatedPatterns = uniqueDeprecatedPatterns;

  return merged;
}

export interface MergedPlaybookWithSources {
  playbook: Playbook;
  /** Git root whose `.cass/playbook.yaml` was merged in, or null when none was. */
  repoRoot: string | null;
  /**
   * Ids of bullets that came from the repo playbook. A repo playbook is
   * implicitly scoped to its repository, so its `scope: workspace` bullets may
   * omit `workspace` (portable across clones) and still apply there (#81).
   */
  repoBulletIds: Set<string>;
}

export async function loadMergedPlaybook(
  config: Config,
  options: { cwd?: string } = {},
): Promise<Playbook> {
  return (await loadMergedPlaybookWithSources(config, options)).playbook;
}

/**
 * Resolve the repository playbook used for both retrieval and feedback.
 * A linked worktree prefers its own playbook, then the main worktree's file.
 * Returning the expected local path when neither exists preserves the
 * repository's block-log location without creating a playbook during lookup.
 */
export async function resolveRepoPlaybookPath(
  options: { cwd?: string } = {},
): Promise<string | null> {
  const repoDir = await resolveRepoDir(options.cwd);
  if (!repoDir) return null;
  const repoPath = path.join(repoDir, "playbook.yaml");
  if (await fileExists(repoPath)) return repoPath;

  const gitRoot = path.dirname(repoDir);
  const mainRoot = resolveProjectRoot(gitRoot);
  if (mainRoot !== normalizeWorkspacePath(gitRoot)) {
    const mainRepoPath = path.join(mainRoot, ".cass", "playbook.yaml");
    if (await fileExists(mainRepoPath)) return mainRepoPath;
  }
  return repoPath;
}

/**
 * Load the global playbook merged with the repo playbook of the git checkout
 * containing `options.cwd` (default: the process cwd), and report which
 * bullets came from the repo playbook.
 */
export async function loadMergedPlaybookWithSources(
  config: Config,
  options: { cwd?: string } = {},
): Promise<MergedPlaybookWithSources> {
  const globalPlaybook = await loadPlaybook(config.playbookPath);

  let repoPlaybook: Playbook | null = null;
  const repoPath = await resolveRepoPlaybookPath(options);
  const repoDir = repoPath ? path.dirname(repoPath) : null;

  if (repoPath && (await fileExists(repoPath))) {
    repoPlaybook = await loadPlaybook(repoPath, { untrusted: true });
  }

  const repoRoot = repoPlaybook && repoDir ? path.dirname(repoDir) : null;
  const repoBulletIds = new Set(repoPlaybook ? repoPlaybook.bullets.map((b) => b.id) : []);

  const merged = mergePlaybooks(globalPlaybook, repoPlaybook);

  const globalBlocked = await loadBlockedLog(path.join(resolveGlobalDir(), "blocked.log"));
  const globalToxic = await loadBlockedLog(path.join(resolveGlobalDir(), "toxic_bullets.log"));

  const repoBlockedPath = repoDir ? path.join(repoDir, "blocked.log") : null;
  const repoBlocked = repoBlockedPath ? await loadBlockedLog(repoBlockedPath) : [];

  const repoToxicPath = repoDir ? path.join(repoDir, "toxic.log") : null;
  const repoToxic = repoToxicPath ? await loadBlockedLog(repoToxicPath) : [];

  const allBlocked = [...globalBlocked, ...globalToxic, ...repoBlocked, ...repoToxic];

  if (allBlocked.length > 0) {
    // Optimization: Deduplicate blocked entries by content hash
    const uniqueBlocked = new Map<string, BlockedEntry>();
    for (const entry of allBlocked) {
      uniqueBlocked.set(hashContent(entry.content), entry);
    }
    const deduplicatedBlocked = Array.from(uniqueBlocked.values());

    // Optimization: Pre-compute hashes and tokens for blocked entries
    const blockedMeta = deduplicatedBlocked.map((entry) => ({
      entry,
      hash: hashContent(entry.content),
      tokens: new Set(tokenize(entry.content)),
    }));

    for (const b of merged.bullets) {
      if (b.deprecated) continue;

      const bHash = hashContent(b.content);
      const bTokens = tokenize(b.content);
      const bTokenSet = new Set(bTokens);

      let isBlocked = false;

      for (const meta of blockedMeta) {
        // 1. Exact Match
        if (meta.hash === bHash) {
          isBlocked = true;
          break;
        }

        // 2. Semantic Match (Jaccard)
        if (bTokens.length === 0 || meta.tokens.size === 0) continue;

        const maxPossibleIntersection = Math.min(bTokenSet.size, meta.tokens.size);
        const minPossibleUnion = Math.max(bTokenSet.size, meta.tokens.size);

        // Fast skip
        if (maxPossibleIntersection / minPossibleUnion <= 0.85) continue;

        const intersectionSize = [...bTokenSet].filter((x) => meta.tokens.has(x)).length;
        const unionSize = new Set([...bTokenSet, ...meta.tokens]).size;

        if (unionSize > 0 && intersectionSize / unionSize > 0.85) {
          log(
            `Blocked content: "${b.content.slice(0, 50)}"... matches blocked "${meta.entry.content.slice(0, 50)}"...`,
            true,
          );
          isBlocked = true;
          break;
        }
      }

      if (isBlocked) {
        // Keep state fields consistent with other deprecations
        deprecateBullet(merged, b.id, "BLOCKED_CONTENT");
      }
    }
  }

  return { playbook: merged, repoRoot, repoBulletIds };
}

// --- Bullet Management ---

export function findBullet(playbook: Playbook, id: string): PlaybookBullet | undefined {
  return playbook.bullets.find((b) => b.id === id);
}

type PartialBulletData = Partial<z.infer<typeof PlaybookBulletSchema>> & {
  content: string;
  category: string;
};

export function addBullet(
  playbook: Playbook,
  data: PartialBulletData,
  sourceSession: string,
  defaultDecayHalfLifeDays: number = 90,
): PlaybookBullet {
  const agent = extractAgentFromPath(sourceSession);
  const requestedId =
    typeof data.id === "string" && data.id.trim() !== "" ? data.id.trim() : undefined;
  if (requestedId && playbook.bullets.some((b) => b.id === requestedId)) {
    throw new Error(`Bullet id already exists: ${requestedId}`);
  }

  const newBullet: PlaybookBullet = {
    id: requestedId ?? generateBulletId(),
    content: data.content,
    category: data.category,
    kind: data.kind || "workflow_rule",
    type: data.type || "rule",
    isNegative: data.isNegative || false,
    scope: data.scope || "global",
    scopeKey: data.scopeKey,
    workspace: data.workspace,
    source: data.source || "learned",
    tags: data.tags || [],
    searchPointer: data.searchPointer,
    state: "draft",
    maturity: "candidate",
    createdAt: now(),
    updatedAt: now(),
    sourceSessions: [sourceSession],
    sourceAgents: [agent],
    helpfulCount: 0,
    harmfulCount: 0,
    feedbackEvents: [],
    deprecated: false,
    pinned: false,
    deprecatedAt: undefined,
    confidenceDecayHalfLifeDays: defaultDecayHalfLifeDays,
  };

  playbook.bullets.push(newBullet);
  return newBullet;
}

export function deprecateBullet(
  playbook: Playbook,
  id: string,
  reason: string,
  replacedBy?: string,
): boolean {
  const bullet = findBullet(playbook, id);
  if (!bullet) return false;

  bullet.deprecated = true;
  bullet.deprecatedAt = now();
  bullet.deprecationReason = reason;
  bullet.replacedBy = replacedBy;
  bullet.state = "retired";
  bullet.maturity = "deprecated";
  bullet.updatedAt = now();

  return true;
}

// --- Playbook Import Merge ---

/**
 * Fold an incoming copy of a rule (a teammate's export, another machine's
 * playbook) into the existing one: feedback events are unioned (an event
 * already present, by type + timestamp + session, is not counted twice),
 * sources, agents and tags are combined, counts are recounted from the
 * events, and maturity is re-derived. The existing rule keeps its id and text.
 * Returns how many feedback events were new.
 */
export function mergeImportedBullet(
  existing: PlaybookBullet,
  incoming: PlaybookBullet,
  config: Config,
): number {
  const key = (e: { type: string; timestamp: string; sessionPath?: string }) =>
    `${e.type}|${e.timestamp}|${e.sessionPath ?? ""}`;
  const seen = new Set((existing.feedbackEvents || []).map(key));
  const fresh = (incoming.feedbackEvents || []).filter((e) => !seen.has(key(e)));
  existing.feedbackEvents = [...(existing.feedbackEvents || []), ...fresh];
  const union = (a: string[] = [], b: string[] = []) => Array.from(new Set([...a, ...b]));
  existing.sourceSessions = union(existing.sourceSessions, incoming.sourceSessions);
  existing.sourceAgents = union(existing.sourceAgents, incoming.sourceAgents);
  existing.tags = union(existing.tags, incoming.tags);
  if (!existing.reasoning && incoming.reasoning) existing.reasoning = incoming.reasoning;
  if (!existing.searchPointer && incoming.searchPointer) existing.searchPointer = incoming.searchPointer;
  if (fresh.length > 0) {
    existing.helpfulCount = existing.feedbackEvents.filter((e) => e.type === "helpful").length;
    existing.harmfulCount = existing.feedbackEvents.filter((e) => e.type === "harmful").length;
    existing.maturity = calculateMaturityState(existing, config);
  }
  existing.updatedAt = now();
  return fresh.length;
}

// --- Feedback Scrubbing (#77) ---

/**
 * Build a session-path matcher from a user pattern. A pattern with `*` is a
 * glob over the whole path (`*` matches any run of characters, including
 * `/`); anything else matches as a plain substring. Windows separators are
 * normalised to `/` on both sides, so one pattern covers both shapes.
 */
export function sessionPathMatcher(pattern: string): (sessionPath: string) => boolean {
  const normalizedPattern = pattern.replace(/\\/g, "/");
  if (!normalizedPattern.includes("*")) {
    return (p) => p.replace(/\\/g, "/").includes(normalizedPattern);
  }
  const escaped = normalizedPattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  const re = new RegExp(`^${escaped}$`);
  return (p) => re.test(p.replace(/\\/g, "/"));
}

const MATURITY_RANK: Record<BulletMaturity, number> = {
  deprecated: 0,
  candidate: 1,
  established: 2,
  proven: 3,
};

export interface ScrubbedBulletReport {
  id: string;
  preview: string;
  removedEvents: number;
  removedSources: number;
  remainingEvents: number;
  helpfulCount: { before: number; after: number };
  harmfulCount: { before: number; after: number };
  maturity: { before: BulletMaturity; after: BulletMaturity };
  effectiveScore: { before: number; after: number };
  /** Every feedback event this bullet had came from matching sessions. */
  noRemainingFeedback: boolean;
  /** The bullet was learned only from matching sessions (all its sources were scrubbed). */
  noRemainingSources: boolean;
}

export interface ScrubResult {
  bulletsTouched: number;
  eventsRemoved: number;
  sourcesRemoved: number;
  bullets: ScrubbedBulletReport[];
}

/**
 * Remove feedback events and source-session references whose session path
 * matches, then re-derive what those events determined: helpful/harmful
 * counts and maturity (#77). Mutates `playbook` in place.
 *
 * Bullets left with no feedback, or learned only from matching sessions, are
 * reported (`noRemainingFeedback` / `noRemainingSources`) but never removed
 * here; deprecating them is the caller's explicit choice. Maturity is
 * recomputed but never raised, and pinned and deprecated bullets keep theirs
 * (calculateMaturityState respects both).
 */
export function scrubFeedbackFromSessions(
  playbook: Playbook,
  matches: (sessionPath: string) => boolean,
  config: Config,
): ScrubResult {
  const result: ScrubResult = { bulletsTouched: 0, eventsRemoved: 0, sourcesRemoved: 0, bullets: [] };

  for (const bullet of playbook.bullets) {
    const events = bullet.feedbackEvents || [];
    const sources = bullet.sourceSessions || [];
    const keptEvents = events.filter((e) => !(e.sessionPath && matches(e.sessionPath)));
    const keptSources = sources.filter((s) => !matches(s));
    const removedEvents = events.length - keptEvents.length;
    const removedSources = sources.length - keptSources.length;
    if (removedEvents === 0 && removedSources === 0) continue;

    const before = {
      helpful: bullet.helpfulCount || 0,
      harmful: bullet.harmfulCount || 0,
      maturity: bullet.maturity,
      score: getEffectiveScore(bullet, config),
    };

    bullet.feedbackEvents = keptEvents;
    bullet.sourceSessions = keptSources;
    if (removedEvents > 0) {
      bullet.helpfulCount = keptEvents.filter((e) => e.type === "helpful").length;
      bullet.harmfulCount = keptEvents.filter((e) => e.type === "harmful").length;
      // Re-derive from what is left, but never promote: removing evidence
      // can only keep or lower a bullet's standing.
      const recomputed = calculateMaturityState(bullet, config);
      bullet.maturity =
        MATURITY_RANK[recomputed] < MATURITY_RANK[before.maturity] ? recomputed : before.maturity;
    }
    bullet.updatedAt = now();

    result.bulletsTouched++;
    result.eventsRemoved += removedEvents;
    result.sourcesRemoved += removedSources;
    result.bullets.push({
      id: bullet.id,
      preview: truncate(bullet.content.trim().replace(/\s+/g, " "), 100),
      removedEvents,
      removedSources,
      remainingEvents: keptEvents.length,
      helpfulCount: { before: before.helpful, after: bullet.helpfulCount || 0 },
      harmfulCount: { before: before.harmful, after: bullet.harmfulCount || 0 },
      maturity: { before: before.maturity, after: bullet.maturity },
      effectiveScore: { before: before.score, after: getEffectiveScore(bullet, config) },
      noRemainingFeedback: removedEvents > 0 && keptEvents.length === 0,
      noRemainingSources: removedSources > 0 && keptSources.length === 0,
    });
  }

  return result;
}

export function getActiveBullets(playbook: Playbook): PlaybookBullet[] {
  return playbook.bullets.filter(
    (b) => b.state !== "retired" && b.maturity !== "deprecated" && !b.deprecated,
  );
}

export function getBulletsByCategory(playbook: Playbook, category: string): PlaybookBullet[] {
  const active = getActiveBullets(playbook);
  return active.filter((b) => b.category.toLowerCase() === category.toLowerCase());
}

export function exportToMarkdown(
  playbook: Playbook,
  options: { topN?: number; showCounts?: boolean; includeAntiPatterns?: boolean } = {},
): string {
  const active = getActiveBullets(playbook);
  const rules = active.filter((b) => b.type !== "anti-pattern" && b.kind !== "anti_pattern");
  const antiPatterns = active.filter((b) => b.type === "anti-pattern" || b.kind === "anti_pattern");

  const categories: Record<string, PlaybookBullet[]> = {};
  for (const b of rules) {
    if (!categories[b.category]) categories[b.category] = [];
    categories[b.category].push(b);
  }

  let md = `## Agent Playbook (auto-generated)\n\n`;

  for (const [cat, bullets] of Object.entries(categories)) {
    md += `### ${cat}\n`;
    const slice = options.topN ? bullets.slice(0, options.topN) : bullets;
    for (const b of slice) {
      const count = options.showCounts
        ? ` (${b.helpfulCount ?? 0}+ / ${b.harmfulCount ?? 0}-)`
        : "";
      md += `- ${b.content}${count}\n`;
    }
    md += "\n";
  }

  if (options.includeAntiPatterns && antiPatterns.length > 0) {
    md += `### PITFALLS (Anti-Patterns)\n`;
    const slice = options.topN ? antiPatterns.slice(0, Math.ceil(options.topN / 2)) : antiPatterns;
    for (const b of slice) {
      const count = options.showCounts
        ? ` (${b.helpfulCount ?? 0}+ / ${b.harmfulCount ?? 0}-)`
        : "";
      md += `- ${b.content}${count}\n`;
    }
    md += "\n";
  }

  return md;
}

/**
 * Export playbook in AGENTS.md format.
 * Structured format with maturity badges and effectiveness metrics.
 */
export function exportToAgentsMd(
  playbook: Playbook,
  config: Config,
  options: { topN?: number; showCounts?: boolean } = {},
): string {
  const active = getActiveBullets(playbook);
  const rules = active.filter((b) => b.type !== "anti-pattern" && b.kind !== "anti_pattern");
  const antiPatterns = active.filter((b) => b.type === "anti-pattern" || b.kind === "anti_pattern");

  // Sort by effective score (highest first)
  const sortedRules = [...rules].sort(
    (a, b) => getEffectiveScore(b, config) - getEffectiveScore(a, config),
  );
  const sortedAntiPatterns = [...antiPatterns].sort(
    (a, b) => getEffectiveScore(b, config) - getEffectiveScore(a, config),
  );

  // Group by category
  const categories: Record<string, PlaybookBullet[]> = {};
  for (const b of sortedRules) {
    if (!categories[b.category]) categories[b.category] = [];
    categories[b.category].push(b);
  }

  let md = `# AGENTS.md\n\n`;
  md += `> Auto-generated playbook for AI coding assistants.\n`;
  md += `> Last updated: ${new Date().toISOString().split("T")[0]}\n\n`;

  // Stats summary
  const stats = computeFullStats(playbook, config);
  md += `## Summary\n\n`;
  md += `- **Total rules**: ${stats.total}\n`;
  md += `- **Proven**: ${stats.byMaturity.proven} | **Established**: ${stats.byMaturity.established} | **Candidate**: ${stats.byMaturity.candidate}\n`;
  md += `- **Score distribution**: ${stats.scoreDistribution.excellent} excellent, ${stats.scoreDistribution.good} good, ${stats.scoreDistribution.neutral} neutral, ${stats.scoreDistribution.atRisk} at-risk\n\n`;

  md += `## Rules\n\n`;

  for (const [cat, bullets] of Object.entries(categories)) {
    md += `### ${cat}\n\n`;
    const slice = options.topN ? bullets.slice(0, options.topN) : bullets;
    for (const b of slice) {
      const icon = formatMaturityIcon(b.maturity);
      const iconPrefix = icon ? `${icon} ` : "";
      const score = getEffectiveScore(b, config).toFixed(1);
      const counts = options.showCounts ? ` [${b.helpfulCount ?? 0}+/${b.harmfulCount ?? 0}-]` : "";
      md += `- ${iconPrefix}${b.content}${counts} _(score: ${score})_\n`;
    }
    md += "\n";
  }

  if (sortedAntiPatterns.length > 0) {
    md += `## Anti-Patterns (AVOID)\n\n`;
    const slice = options.topN ? sortedAntiPatterns.slice(0, options.topN) : sortedAntiPatterns;
    for (const b of slice) {
      const counts = options.showCounts ? ` [${b.helpfulCount ?? 0}+/${b.harmfulCount ?? 0}-]` : "";
      const avoidPrefix = iconPrefix("warning") || "AVOID: ";
      md += `- ${avoidPrefix}${b.content}${counts}\n`;
    }
    md += "\n";
  }

  return md;
}

/**
 * Export playbook in Claude-specific format.
 * Includes context sections and Claude-optimized instructions.
 */
export function exportToClaudeMd(
  playbook: Playbook,
  config: Config,
  options: { topN?: number; showCounts?: boolean } = {},
): string {
  const active = getActiveBullets(playbook);
  const rules = active.filter((b) => b.type !== "anti-pattern" && b.kind !== "anti_pattern");
  const antiPatterns = active.filter((b) => b.type === "anti-pattern" || b.kind === "anti_pattern");

  // Sort by effective score (highest first)
  const sortedRules = [...rules].sort(
    (a, b) => getEffectiveScore(b, config) - getEffectiveScore(a, config),
  );

  // Group by category
  const categories: Record<string, PlaybookBullet[]> = {};
  for (const b of sortedRules) {
    if (!categories[b.category]) categories[b.category] = [];
    categories[b.category].push(b);
  }

  let md = `<project_rules>\n`;
  md += `<!-- Auto-generated rules from cass-memory playbook -->\n\n`;

  for (const [cat, bullets] of Object.entries(categories)) {
    md += `## ${cat}\n\n`;
    const slice = options.topN ? bullets.slice(0, options.topN) : bullets;
    for (const b of slice) {
      md += `- ${b.content}\n`;
    }
    md += "\n";
  }

  if (antiPatterns.length > 0) {
    md += `## IMPORTANT: Avoid These Patterns\n\n`;
    const slice = options.topN ? antiPatterns.slice(0, options.topN) : antiPatterns;
    for (const b of slice) {
      md += `- DO NOT: ${b.content}\n`;
    }
    md += "\n";
  }

  md += `</project_rules>\n`;

  return md;
}

export function computeFullStats(playbook: Playbook, config: Config): PlaybookStats {
  const active = getActiveBullets(playbook);

  const stats: PlaybookStats = {
    total: active.length,
    byScope: { global: 0, workspace: 0 },
    byMaturity: { candidate: 0, established: 0, proven: 0, deprecated: 0 },
    byType: { rule: 0, antiPattern: 0 },
    scoreDistribution: { excellent: 0, good: 0, neutral: 0, atRisk: 0 },
  };

  for (const b of active) {
    if (b.scope === "workspace") stats.byScope.workspace++;
    else stats.byScope.global++;

    stats.byMaturity[b.maturity]++;
    if (b.type === "anti-pattern") stats.byType.antiPattern++;
    else stats.byType.rule++;

    const score = getEffectiveScore(b, config);
    // Thresholds aligned with scoring.ts analyzeScoreDistribution
    if (score >= 10) stats.scoreDistribution.excellent++;
    else if (score >= 5) stats.scoreDistribution.good++;
    else if (score >= 0) stats.scoreDistribution.neutral++;
    else stats.scoreDistribution.atRisk++;
  }

  return stats;
}
