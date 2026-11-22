import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { withLock } from "./lock.js";
import { getOutputStyle } from "./output.js";
import {
  type EmbeddingCache,
  EmbeddingCacheSchema,
  type Playbook,
  type PlaybookBullet,
} from "./types.js";
import {
  atomicWrite,
  expandPath,
  getCliName,
  hashContent,
  resolveGlobalDir,
  warn,
} from "./utils.js";
import { ensureOnnxWasmRuntime, getTransformersCacheDir } from "./wasm-runtime.js";

export const DEFAULT_EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
// Transformers 4 uses a newer quantized runtime; old batch vectors must be recomputed.
export const EMBEDDING_CACHE_VERSION = "3.0";
const OLLAMA_EMBEDDING_CACHE_VERSION = "2.0";
const OLLAMA_EMBED_TIMEOUT_MS = 30_000;

let embedderCache: { model: string; promise: Promise<any>; ready: boolean } | null = null;
const modelCacheProbes = new Map<string, Promise<boolean>>();

// ============================================================================
// OLLAMA EMBEDDING BACKEND
// ============================================================================

export type EmbeddingBackend = "xenova" | "ollama";

let embeddingBackend: EmbeddingBackend = "xenova";

interface OllamaConfig {
  baseUrl: string;
  model: string;
}

export interface EmbeddingOptions {
  model?: string;
  config?: SemanticConfigInput;
}

interface EmbeddingRuntime {
  readonly backend: EmbeddingBackend;
  readonly model: string;
  readonly baseUrl: string;
  readonly cacheIdentity: string;
}

const ollamaConfig: OllamaConfig = {
  baseUrl: "http://localhost:11434",
  model: "all-minilm",
};

/**
 * Set the active embedding backend ("xenova" or "ollama").
 */
export function setEmbeddingBackend(backend: EmbeddingBackend): void {
  embeddingBackend = backend;
}

/**
 * Get the active embedding backend.
 */
export function getEmbeddingBackend(): EmbeddingBackend {
  return embeddingBackend;
}

/**
 * Configure the Ollama embedding endpoint.
 *
 * @param baseUrl - The Ollama API base URL (e.g. "http://localhost:11434")
 * @param model - The Ollama model to use for embeddings (e.g. "all-minilm", "nomic-embed-text")
 */
export function configureOllamaEmbedding(baseUrl: string, model: string): void {
  ollamaConfig.baseUrl = baseUrl.replace(/\/+$/, ""); // strip trailing slashes
  ollamaConfig.model = model;
}

/**
 * Apply loaded configuration to the process-wide embedding runtime.
 *
 * Commands pass their configuration directly to semantic operations. This
 * default is also available for callers without an explicit configuration;
 * every operation snapshots it before any asynchronous work.
 */
export function configureEmbeddingBackend(config: {
  embeddingBackend?: EmbeddingBackend;
  embeddingModel?: string;
  ollamaBaseUrl?: string;
}): void {
  const backend = config.embeddingBackend ?? "xenova";
  setEmbeddingBackend(backend);

  if (backend !== "ollama") return;

  const { baseUrl, model } = resolveOllamaSettings(config);
  configureOllamaEmbedding(baseUrl, model);
}

/**
 * Translate the generic embedding config into the Ollama daemon address and
 * model tag that the Ollama backend will actually call. Shared by
 * {@link configureEmbeddingBackend} and the readiness probe so both agree.
 */
export function resolveOllamaSettings(config: {
  embeddingModel?: string;
  ollamaBaseUrl?: string;
}): { baseUrl: string; model: string } {
  const rawModel =
    typeof config.embeddingModel === "string" && config.embeddingModel.trim() !== ""
      ? config.embeddingModel.trim()
      : "all-minilm";
  const model =
    rawModel === DEFAULT_EMBEDDING_MODEL
      ? "all-minilm"
      : rawModel.startsWith("Xenova/")
        ? rawModel.slice("Xenova/".length).toLowerCase()
        : rawModel;
  const baseUrl = (
    typeof config.ollamaBaseUrl === "string" && config.ollamaBaseUrl.trim() !== ""
      ? config.ollamaBaseUrl.trim()
      : "http://localhost:11434"
  ).replace(/\/+$/, "");

  return { baseUrl, model };
}

/** Resolve one operation's runtime before an await can change global defaults. */
function resolveEmbeddingRuntime(options: EmbeddingOptions = {}): EmbeddingRuntime {
  const backend = options.config ? options.config.embeddingBackend ?? "xenova" : embeddingBackend;
  const requestedModel = options.model ?? options.config?.embeddingModel;
  let model = requestedModel?.trim() || DEFAULT_EMBEDDING_MODEL;
  let baseUrl = "";
  if (backend === "ollama") {
    const settings = resolveOllamaSettings({
      embeddingModel: requestedModel ?? (options.config ? undefined : ollamaConfig.model),
      ollamaBaseUrl: options.config ? options.config.ollamaBaseUrl : ollamaConfig.baseUrl,
    });
    model = settings.model;
    baseUrl = settings.baseUrl;
  }
  // Endpoint credentials and query tokens must never be copied into cache
  // filenames or metadata. Hash the exact, case-sensitive runtime identity.
  const cacheIdentity = createHash("sha256")
    .update(JSON.stringify([backend, model, baseUrl]))
    .digest("hex");
  return { backend, model, baseUrl, cacheIdentity };
}

/** A usable embedding has finite coordinates, a nonzero norm and known size. */
export function isValidEmbedding(value: unknown, expectedDimensions?: number): value is number[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  if (expectedDimensions !== undefined && value.length !== expectedDimensions) return false;
  let nonzero = false;
  for (const coordinate of value) {
    if (typeof coordinate !== "number" || !Number.isFinite(coordinate)) return false;
    if (coordinate !== 0) nonzero = true;
  }
  return nonzero;
}

function requireValidEmbedding(
  value: unknown,
  expectedDimensions?: number,
  source = "Embedding provider",
): number[] {
  if (!isValidEmbedding(value, expectedDimensions)) {
    const dimensions = expectedDimensions === undefined ? "" : ` with ${expectedDimensions} dimensions`;
    throw new Error(`${source} returned an invalid embedding; expected a finite, nonzero vector${dimensions}`);
  }
  return value;
}

/**
 * Embed a single text using Ollama's /api/embed endpoint.
 *
 * @param text - The text to embed (must be non-empty after trimming)
 * @returns The embedding vector as a number array
 * @throws Error with descriptive message on connection failure, model not found, etc.
 */
async function embedTextOllama(text: string, runtime: EmbeddingRuntime): Promise<number[]> {
  const url = `${runtime.baseUrl}/api/embed`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: runtime.model, input: text }),
      signal: AbortSignal.timeout(OLLAMA_EMBED_TIMEOUT_MS),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("ECONNREFUSED") || message.includes("fetch failed")) {
      throw new Error(
        `Ollama connection refused at ${runtime.baseUrl}. ` +
          `Is Ollama running? Start it with: ollama serve`,
      );
    }
    throw new Error(`Ollama embedding request failed: ${message}`);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "(no body)");
    if (response.status === 404 || body.includes("not found")) {
      throw new Error(
        `Ollama model "${runtime.model}" not found. ` +
          `Pull it with: ollama pull ${runtime.model}`,
      );
    }
    throw new Error(`Ollama embedding failed (HTTP ${response.status}): ${body}`);
  }

  const json = (await response.json()) as { embeddings?: unknown[] };
  if (
    !json.embeddings ||
    !Array.isArray(json.embeddings) ||
    json.embeddings.length !== 1
  ) {
    throw new Error("Unexpected Ollama response: missing or empty embeddings array");
  }

  return requireValidEmbedding(json.embeddings[0], undefined, "Ollama");
}

/**
 * Batch-embed multiple texts using Ollama's /api/embed endpoint.
 *
 * Ollama's /api/embed accepts an array of strings in the `input` field,
 * returning one embedding per input text.
 *
 * @param texts - Array of texts to embed
 * @param onProgress - Optional progress callback
 * @returns Array of embedding vectors, one per input text
 */
async function batchEmbedOllama(
  texts: string[],
  runtime: EmbeddingRuntime,
  onProgress?: (event: { processed: number; total: number }) => void,
): Promise<number[][]> {
  const url = `${runtime.baseUrl}/api/embed`;

  // Filter out empty strings but track indices
  const cleaned = texts.map((t) => (typeof t === "string" ? t.trim() : ""));
  const output: number[][] = new Array(cleaned.length);
  for (let i = 0; i < cleaned.length; i++) {
    if (!cleaned[i]) output[i] = [];
  }

  const nonEmpty: Array<{ index: number; text: string }> = [];
  for (let i = 0; i < cleaned.length; i++) {
    if (cleaned[i]) nonEmpty.push({ index: i, text: cleaned[i] });
  }

  if (nonEmpty.length === 0) return output;

  // Ollama supports batch embed via an array in the input field.
  // Send in chunks to avoid overwhelming the server with huge payloads.
  const BATCH_SIZE = 64;
  let dimensions: number | undefined;
  for (let start = 0; start < nonEmpty.length; start += BATCH_SIZE) {
    const batch = nonEmpty.slice(start, start + BATCH_SIZE);
    const batchTexts = batch.map((b) => b.text);

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: runtime.model, input: batchTexts }),
        signal: AbortSignal.timeout(OLLAMA_EMBED_TIMEOUT_MS),
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("ECONNREFUSED") || message.includes("fetch failed")) {
        throw new Error(
          `Ollama connection refused at ${runtime.baseUrl}. ` +
            `Is Ollama running? Start it with: ollama serve`,
        );
      }
      throw new Error(`Ollama batch embedding request failed: ${message}`);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "(no body)");
      if (response.status === 404 || body.includes("not found")) {
        throw new Error(
          `Ollama model "${runtime.model}" not found. ` +
            `Pull it with: ollama pull ${runtime.model}`,
        );
      }
      throw new Error(`Ollama batch embedding failed (HTTP ${response.status}): ${body}`);
    }

    const json = (await response.json()) as { embeddings?: unknown[] };
    if (
      !json.embeddings ||
      !Array.isArray(json.embeddings) ||
      json.embeddings.length !== batchTexts.length
    ) {
      throw new Error(
        `Unexpected Ollama batch response: expected ${batchTexts.length} embeddings, ` +
          `got ${json.embeddings?.length ?? 0}`,
      );
    }

    for (let i = 0; i < batch.length; i++) {
      const embedding = requireValidEmbedding(json.embeddings[i], dimensions, "Ollama");
      dimensions ??= embedding.length;
      output[batch[i].index] = embedding;
    }

    if (typeof onProgress === "function") {
      try {
        onProgress({
          processed: Math.min(start + batch.length, nonEmpty.length),
          total: nonEmpty.length,
        });
      } catch {
        // Progress is best-effort
      }
    }
  }

  // Fill any remaining unset entries with empty embeddings
  for (let i = 0; i < output.length; i++) {
    if (!Array.isArray(output[i])) output[i] = [];
  }

  return output;
}

export interface ModelLoadProgress {
  status: "initiate" | "download" | "progress" | "progress_total" | "done" | "ready";
  name?: string;
  file?: string;
  progress?: number;
  loaded?: number;
  total?: number;
}

export type ProgressCallback = (progress: ModelLoadProgress) => void;

/**
 * Check if we should show progress output to the user.
 * Progress is shown when stderr is a TTY and emojis are enabled.
 */
function shouldShowProgress(): boolean {
  return Boolean(process.stderr?.isTTY);
}

/**
 * Create a progress callback that writes to stderr.
 * This keeps stdout clean for JSON output while still informing the user.
 */
function createStderrProgressCallback(): ProgressCallback {
  let lastPercent = -1;
  const style = getOutputStyle();
  const downloadIcon = style.emoji ? "📥 " : "";
  const checkIcon = style.emoji ? "✓ " : "";

  return (progress: ModelLoadProgress) => {
    if (progress.status === "initiate") {
      process.stderr.write(`${downloadIcon}Downloading embedding model (one-time, ~23MB)...\n`);
    } else if ((progress.status === "progress" || progress.status === "progress_total") && typeof progress.progress === "number") {
      const percent = Math.round(progress.progress);
      // Only update every 5% to reduce visual noise
      if (percent >= lastPercent + 5 || percent === 100) {
        lastPercent = percent;
        process.stderr.write(`\r${downloadIcon}Downloading: ${percent}%`);
        if (percent === 100) {
          process.stderr.write("\n");
        }
      }
    } else if (progress.status === "ready") {
      process.stderr.write(`${checkIcon}Embedding model ready\n`);
    }
  };
}

async function loadEmbedder(
  model: string,
  options: { showProgress?: boolean; progressCallback?: ProgressCallback } = {},
): Promise<any> {
  // Configure after import: Transformers initializes its own runtime URLs.
  // Our pinned source entry keeps filesystem caching and uses embedded WASM.
  const { pipeline } = await import("@huggingface/transformers");
  await ensureOnnxWasmRuntime();

  const showProgress = options.showProgress ?? shouldShowProgress();
  const progressCallback =
    options.progressCallback ?? (showProgress ? createStderrProgressCallback() : undefined);

  // Lock to prevent concurrent model downloads from corrupting the cache
  const lockPath = path.join(resolveGlobalDir(), "embeddings", "model_loading");

  return withLock(
    lockPath,
    async () => {
      try {
        const result = await pipeline("feature-extraction", model, {
          device: "wasm",
          dtype: "q8",
          progress_callback: progressCallback,
        });

        // Signal that model is ready
        if (progressCallback) {
          progressCallback({ status: "ready" });
        }

        return result;
      } catch (error: any) {
        // Check if this is a network error and we might have a cached model
        const isNetworkError =
          error?.message?.includes("fetch") ||
          error?.message?.includes("network") ||
          error?.message?.includes("ENOTFOUND") ||
          error?.message?.includes("ECONNREFUSED");

        if (isNetworkError) {
          // Try loading from local cache only
          try {
            warn("[semantic] Network unavailable; attempting to use cached model...");
            const result = await pipeline("feature-extraction", model, {
              device: "wasm",
              dtype: "q8",
              local_files_only: true,
              progress_callback: progressCallback,
            });
            if (progressCallback) {
              progressCallback({ status: "ready" });
            }
            return result;
          } catch (cacheError: any) {
            throw new Error(
              `Embedding model not available offline. To enable offline use:\n` +
                `  1. Run any '${getCliName()}' command with semantic search while online to download the model\n` +
                `  2. The model will be cached in ${getTransformersCacheDir() ?? "the transformers.js cache"}\n` +
                `Original error: ${error.message}`,
            );
          }
        }

        throw error;
      }
    },
    { staleLockThresholdMs: 600_000 },
  ); // 10 minute timeout for downloads
}

export interface GetEmbedderOptions {
  showProgress?: boolean;
  progressCallback?: ProgressCallback;
}

export async function getEmbedder(
  model = DEFAULT_EMBEDDING_MODEL,
  options: GetEmbedderOptions = {},
): Promise<any> {
  if (embedderCache?.model === model) return embedderCache.promise;

  const entry = { model, promise: loadEmbedder(model, options), ready: false };
  embedderCache = entry;
  entry.promise.then(
    () => { entry.ready = true; },
    () => {
      // A failed older load must not evict a newer model's in-flight cache.
      if (embedderCache === entry) embedderCache = null;
    },
  );

  return entry.promise;
}

export async function embedText(text: string, options: EmbeddingOptions = {}): Promise<number[]> {
  return embedTextWithRuntime(text, resolveEmbeddingRuntime(options));
}

async function embedTextWithRuntime(
  text: string,
  runtime: EmbeddingRuntime,
  options: GetEmbedderOptions = {},
): Promise<number[]> {
  if (runtime.model === "none") return [];
  const cleaned = text?.trim();
  if (!cleaned) return [];

  if (runtime.backend === "ollama") {
    return embedTextOllama(cleaned, runtime);
  }

  const embedder = await getEmbedder(runtime.model, options);
  const result: any = await embedder(cleaned, { pooling: "mean", normalize: true });

  const data: any = result?.data;
  const dims: any = result?.dims;
  if (!data || !Array.isArray(dims) || dims.length !== 2 || dims[0] !== 1 ||
      !Number.isInteger(dims[1]) || dims[1] <= 0 || data.length !== dims[1]) {
    throw new Error("Unexpected embedder output (single-vector data/dimensions mismatch)");
  }

  return requireValidEmbedding(Array.from(data), dims[1], "Local embedder");
}

export async function batchEmbed(
  texts: string[],
  batchSize = 32,
  options: EmbeddingOptions & {
    onProgress?: (event: { processed: number; total: number }) => void;
  } = {},
): Promise<number[][]> {
  return batchEmbedWithRuntime(texts, batchSize, resolveEmbeddingRuntime(options), options.onProgress);
}

async function batchEmbedWithRuntime(
  texts: string[],
  batchSize: number,
  runtime: EmbeddingRuntime,
  onProgress?: (event: { processed: number; total: number }) => void,
): Promise<number[][]> {
  if (runtime.model === "none") return texts.map(() => []);

  if (runtime.backend === "ollama") {
    return batchEmbedOllama(texts, runtime, onProgress);
  }

  const safeBatchSize = Number.isFinite(batchSize) && batchSize > 0 ? Math.floor(batchSize) : 32;

  const cleaned = texts.map((t) => (typeof t === "string" ? t.trim() : ""));
  const output: number[][] = new Array(cleaned.length);
  for (let i = 0; i < cleaned.length; i++) {
    if (!cleaned[i]) output[i] = [];
  }

  // Batch only the non-empty strings, but preserve indices in the output.
  const nonEmpty: Array<{ index: number; text: string }> = [];
  for (let i = 0; i < cleaned.length; i++) {
    const t = cleaned[i];
    if (t) nonEmpty.push({ index: i, text: t });
  }

  if (nonEmpty.length === 0) return output;
  const embedder = await getEmbedder(runtime.model);
  let dimensions: number | undefined;
  for (let start = 0; start < nonEmpty.length; start += safeBatchSize) {
    const batch = nonEmpty.slice(start, start + safeBatchSize);
    const batchTexts = batch.map((b) => b.text);

    const result: any = await embedder(batchTexts, { pooling: "mean", normalize: true });

    const data: any = result?.data;
    const dims: any = result?.dims;
    const batchCount = Array.isArray(dims) && typeof dims[0] === "number" ? dims[0] : null;
    const dim = Array.isArray(dims) && typeof dims[1] === "number" ? dims[1] : null;

    if (!data || typeof data.length !== "number" || !Array.isArray(dims) || dims.length !== 2 || !batchCount || !dim ||
        !Number.isInteger(batchCount) || !Number.isInteger(dim) || dim <= 0) {
      throw new Error("Unexpected embedder output (missing data/dims)");
    }
    if (batchCount !== batchTexts.length) {
      throw new Error(
        `Unexpected embedder output (batch mismatch: got ${batchCount}, expected ${batchTexts.length})`,
      );
    }
    if (data.length !== batchCount * dim) {
      throw new Error("Unexpected embedder output (data length does not match dimensions)");
    }

    for (let i = 0; i < batchCount; i++) {
      const startIdx = i * dim;
      const endIdx = startIdx + dim;
      const vec = Array.from(
        data.subarray ? data.subarray(startIdx, endIdx) : data.slice(startIdx, endIdx),
      ) as number[];
      output[batch[i].index] = requireValidEmbedding(vec, dimensions ?? dim, "Local embedder");
      dimensions ??= dim;
    }

    if (typeof onProgress === "function") {
      try {
        onProgress({
          processed: Math.min(start + batchCount, nonEmpty.length),
          total: nonEmpty.length,
        });
      } catch {
        // Progress is best-effort; never break embeddings
      }
    }
  }

  // Any remaining unset entries (should only happen if inputs changed unexpectedly) become empty embeddings.
  for (let i = 0; i < output.length; i++) {
    if (!Array.isArray(output[i])) output[i] = [];
  }

  return output;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (!isValidEmbedding(a) || !isValidEmbedding(b, a.length)) return 0;

  // Scale first so valid finite coordinates cannot overflow/underflow when
  // squared. Invalid or incompatible vectors retain the finite-zero contract.
  let scaleA = 0;
  let scaleB = 0;
  for (let i = 0; i < a.length; i++) {
    scaleA = Math.max(scaleA, Math.abs(a[i]));
    scaleB = Math.max(scaleB, Math.abs(b[i]));
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    const scaledA = a[i] / scaleA;
    const scaledB = b[i] / scaleB;
    dot += scaledA * scaledB;
    normA += scaledA * scaledA;
    normB += scaledB * scaledB;
  }

  if (normA === 0 || normB === 0) return 0;
  const similarity = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  return Number.isFinite(similarity) ? Math.max(-1, Math.min(1, similarity)) : 0;
}

function embeddingCachePathForIdentity(identity: string): string {
  return path.join(resolveGlobalDir(), "embeddings", `bullets-${identity}.json`);
}

export function getEmbeddingCachePath(options: EmbeddingOptions = {}): string {
  return embeddingCachePathForIdentity(resolveEmbeddingRuntime(options).cacheIdentity);
}

function emptyEmbeddingCacheForRuntime(runtime: EmbeddingRuntime): EmbeddingCache {
  return {
    version: embeddingCacheVersionForRuntime(runtime),
    model: runtime.model,
    runtimeId: runtime.cacheIdentity,
    bullets: {},
  };
}

export function createEmptyEmbeddingCache(
  model?: string,
  options: Pick<EmbeddingOptions, "config"> = {},
): EmbeddingCache {
  return emptyEmbeddingCacheForRuntime(resolveEmbeddingRuntime({ ...options, model }));
}

function embeddingCacheVersionForRuntime(runtime: EmbeddingRuntime): string {
  return runtime.backend === "ollama" ? OLLAMA_EMBEDDING_CACHE_VERSION : EMBEDDING_CACHE_VERSION;
}

export async function loadEmbeddingCache(
  options: EmbeddingOptions & { cachePath?: string } = {},
): Promise<EmbeddingCache> {
  const runtime = resolveEmbeddingRuntime(options);
  const cachePath = expandPath(options.cachePath || embeddingCachePathForIdentity(runtime.cacheIdentity));
  return loadEmbeddingCacheForRuntime(runtime, cachePath);
}

async function loadEmbeddingCacheForRuntime(
  runtime: EmbeddingRuntime,
  cachePath: string,
): Promise<EmbeddingCache> {
  try {
    const raw = await fs.readFile(cachePath, "utf-8");
    const parsed = JSON.parse(raw);

    const result = EmbeddingCacheSchema.safeParse(parsed);
    if (!result.success) {
      warn(`[semantic] Invalid embedding cache; ignoring (${cachePath})`);
      return emptyEmbeddingCacheForRuntime(runtime);
    }

    const cache = result.data;
    if (cache.model !== runtime.model || cache.runtimeId !== runtime.cacheIdentity ||
        cache.version !== embeddingCacheVersionForRuntime(runtime)) {
      return emptyEmbeddingCacheForRuntime(runtime);
    }

    return cache;
  } catch (err: any) {
    if (err?.code && err.code !== "ENOENT") {
      warn(`[semantic] Failed to load embedding cache (${cachePath}): ${err.message}`);
    }
    return emptyEmbeddingCacheForRuntime(runtime);
  }
}

export async function saveEmbeddingCache(
  cache: EmbeddingCache,
  options: { cachePath?: string } = {},
): Promise<void> {
  const cachePath = expandPath(options.cachePath || embeddingCachePathForIdentity(cache.runtimeId));
  try {
    await atomicWrite(cachePath, JSON.stringify(cache, null, 2));
  } catch (err: any) {
    warn(`[semantic] Failed to save embedding cache (${cachePath}): ${err.message}`);
  }
}

export interface EmbeddingStats {
  reused: number;
  computed: number;
  skipped: number;
}

interface BulletEmbeddingOptions extends EmbeddingOptions {
  cachePath?: string;
  expectedDimensions?: number;
  onProgress?: (event: {
    phase: "start" | "progress" | "done";
    current: number;
    total: number;
    reused: number;
    computed: number;
    skipped: number;
    message: string;
  }) => void;
}

export async function loadOrComputeEmbeddingsForBullets(
  bullets: PlaybookBullet[],
  options: BulletEmbeddingOptions = {},
): Promise<{ cache: EmbeddingCache; stats: EmbeddingStats }> {
  return loadOrComputeEmbeddingsWithRuntime(bullets, options, resolveEmbeddingRuntime(options));
}

async function loadOrComputeEmbeddingsWithRuntime(
  bullets: PlaybookBullet[],
  options: BulletEmbeddingOptions,
  runtime: EmbeddingRuntime,
): Promise<{ cache: EmbeddingCache; stats: EmbeddingStats }> {
  const cachePath = expandPath(options.cachePath || embeddingCachePathForIdentity(runtime.cacheIdentity));

  // Use lock to prevent concurrent cache corruption
  return withLock(cachePath, async () => {
    const emitProgress = (event: {
      phase: "start" | "progress" | "done";
      current: number;
      total: number;
      reused: number;
      computed: number;
      skipped: number;
      message: string;
    }) => {
      if (typeof options.onProgress !== "function") return;
      try {
        options.onProgress(event);
      } catch {
        // Best-effort only
      }
    };

    const cache = await loadEmbeddingCacheForRuntime(runtime, cachePath);
    let dimensions = options.expectedDimensions ?? cache.dimensions;
    let cacheChanged = false;

    let reused = 0;
    let computed = 0;
    let skipped = 0;

    const toCompute: Array<{ bullet: PlaybookBullet; contentHash: string }> = [];

    for (const bullet of bullets) {
      // Inline vectors carry no content or runtime provenance. Only the cache
      // validated for this operation may rehydrate them; failed recomputation
      // must never leave an old vector attached to changed content.
      if (bullet) bullet.embedding = undefined;
      if (!bullet?.id || !bullet?.content) {
        skipped++;
        continue;
      }

      const contentHash = hashContent(bullet.content);
      const cached = cache.bullets[bullet.id];

      if (
        cached?.contentHash === contentHash &&
        isValidEmbedding(cached.embedding, dimensions)
      ) {
        dimensions ??= cached.embedding.length;
        bullet.embedding = cached.embedding;
        reused++;
        continue;
      }

      if (cached) {
        delete cache.bullets[bullet.id];
        cacheChanged = true;
      }
      toCompute.push({ bullet, contentHash });
    }

    // A header alone is not evidence for the current provider's dimensions.
    // Once none of this corpus can be reused, fresh output must be able to
    // establish a new size (including after a failed recomputation).
    if (reused === 0 && options.expectedDimensions === undefined) {
      dimensions = undefined;
    }

    const totalToCompute = toCompute.length;
    emitProgress({
      phase: "start",
      current: 0,
      total: totalToCompute,
      reused,
      computed,
      skipped,
      message:
        totalToCompute > 0 ? "Computing semantic embeddings..." : "Semantic embeddings up to date",
    });

    if (runtime.model !== "none" && toCompute.length > 0) {
      try {
        const embeddings = await batchEmbedWithRuntime(
          toCompute.map((x) => x.bullet.content),
          32,
          runtime,
          (event) => {
            emitProgress({
              phase: "progress",
              current: event.processed,
              total: event.total,
              reused,
              computed,
              skipped,
              message: "Computing semantic embeddings...",
            });
          },
        );

        // Validate the whole batch before mutating bullets or counting it.
        // Otherwise a later invalid vector would double-count an earlier one
        // when the per-text fallback runs.
        for (const embedding of embeddings) {
          requireValidEmbedding(embedding, dimensions);
          dimensions ??= embedding.length;
        }

        for (let i = 0; i < toCompute.length; i++) {
          const { bullet, contentHash } = toCompute[i];
          const embedding = embeddings[i] || [];

          bullet.embedding = embedding;
          cache.bullets[bullet.id] = {
            contentHash,
            embedding,
            computedAt: new Date().toISOString(),
          };
          computed++;
        }
      } catch (err: any) {
        warn(
          `[semantic] batchEmbed failed; falling back to per-text embedding. ${err?.message || ""}`.trim(),
        );

        let processed = 0;
        for (const { bullet, contentHash } of toCompute) {
          try {
            const embedding = requireValidEmbedding(
              await embedTextWithRuntime(bullet.content, runtime),
              dimensions,
            );
            dimensions ??= embedding.length;

            bullet.embedding = embedding;
            cache.bullets[bullet.id] = {
              contentHash,
              embedding,
              computedAt: new Date().toISOString(),
            };
            computed++;
            processed++;
            emitProgress({
              phase: "progress",
              current: processed,
              total: totalToCompute,
              reused,
              computed,
              skipped,
              message: "Computing semantic embeddings...",
            });
          } catch (innerErr: any) {
            warn(
              `[semantic] embedText failed for bullet ${bullet.id}: ${innerErr?.message || innerErr}`,
            );
            skipped++;
            processed++;
            emitProgress({
              phase: "progress",
              current: processed,
              total: totalToCompute,
              reused,
              computed,
              skipped,
              message: "Computing semantic embeddings...",
            });
          }
        }
      }
    } else {
      skipped += toCompute.length;
    }

    cache.dimensions = dimensions;

    // Persist computed vectors or invalidated entries; leave a clean cache untouched.
    if (
      computed > 0 || cacheChanged ||
      !(await fs
        .access(cachePath)
        .then(() => true)
        .catch(() => false))
    ) {
      await saveEmbeddingCache(cache, { cachePath });
    }

    emitProgress({
      phase: "done",
      current: totalToCompute,
      total: totalToCompute,
      reused,
      computed,
      skipped,
      message: skipped > 0
        ? `Semantic embeddings available for ${reused + computed} of ${bullets.length} rules`
        : computed > 0 ? "Semantic embeddings computed" : "Semantic embeddings ready",
    });

    return { cache, stats: { reused, computed, skipped } };
  });
}

export async function loadOrComputeEmbeddings(
  playbook: Playbook,
  options: BulletEmbeddingOptions = {},
): Promise<{ cache: EmbeddingCache; stats: EmbeddingStats }> {
  return loadOrComputeEmbeddingsForBullets(playbook.bullets, options);
}

export interface SimilarBulletMatch {
  bullet: PlaybookBullet;
  similarity: number;
}

export async function findSimilarBulletsSemantic(
  query: string,
  bullets: PlaybookBullet[],
  topK = 5,
  options: EmbeddingOptions & {
    threshold?: number;
    cachePath?: string;
    queryEmbedding?: number[];
    ensureEmbeddings?: boolean;
  } = {},
): Promise<SimilarBulletMatch[]> {
  const cleaned = query?.trim();
  if (!cleaned) return [];

  if (!Number.isFinite(topK) || topK <= 0) return [];
  const candidates = bullets.filter((bullet) => Boolean(bullet?.id) && Boolean(bullet?.content));
  if (candidates.length === 0) return [];

  const threshold =
    typeof options.threshold === "number" && Number.isFinite(options.threshold)
      ? options.threshold
      : undefined;

  const runtime = resolveEmbeddingRuntime(options);
  const queryEmbedding = requireValidEmbedding(
    options.queryEmbedding !== undefined
      ? options.queryEmbedding
      : await embedTextWithRuntime(cleaned, runtime),
    undefined,
    "Query embedder",
  );
  if (options.ensureEmbeddings !== false) {
    await loadOrComputeEmbeddingsWithRuntime(candidates, {
      cachePath: options.cachePath,
      expectedDimensions: queryEmbedding.length,
    }, runtime);
  }

  const matches: SimilarBulletMatch[] = [];
  let usable = 0;

  for (const bullet of candidates) {
    if (!isValidEmbedding(bullet.embedding, queryEmbedding.length)) continue;
    usable++;

    const similarity = cosineSimilarity(queryEmbedding, bullet.embedding);
    if (threshold !== undefined && similarity < threshold) continue;

    matches.push({ bullet, similarity });
  }

  if (usable === 0) {
    throw new Error("Semantic search unavailable: no rule embeddings match the query dimensions");
  }

  matches.sort((a, b) => b.similarity - a.similarity);
  return matches.slice(0, topK);
}

export interface SemanticDuplicatePair {
  pair: [string, string];
  similarity: number;
}

export async function findSemanticDuplicates(
  bullets: PlaybookBullet[],
  threshold = 0.85,
  options: EmbeddingOptions & { cachePath?: string; ensureEmbeddings?: boolean } = {},
): Promise<SemanticDuplicatePair[]> {
  const cleanedThreshold =
    typeof threshold === "number" && Number.isFinite(threshold) ? threshold : 0.85;
  const minSimilarity = Math.min(1, Math.max(0, cleanedThreshold));

  const candidates = bullets.filter((b) => Boolean(b?.id) && Boolean(b?.content));
  if (candidates.length < 2) return [];

  const runtime = resolveEmbeddingRuntime(options);

  const ensureEmbeddings = options.ensureEmbeddings !== false;
  if (ensureEmbeddings) {
    await loadOrComputeEmbeddingsWithRuntime(candidates, {
      cachePath: options.cachePath,
    }, runtime);
  }

  const pairs: SemanticDuplicatePair[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const a = candidates[i];
    if (!isValidEmbedding(a.embedding)) continue;

    for (let j = i + 1; j < candidates.length; j++) {
      const b = candidates[j];
      if (!isValidEmbedding(b.embedding, a.embedding.length)) continue;

      const similarity = cosineSimilarity(a.embedding, b.embedding);
      if (similarity >= minSimilarity) {
        pairs.push({ pair: [a.id, b.id], similarity });
      }
    }
  }

  pairs.sort((x, y) => {
    const diff = y.similarity - x.similarity;
    if (diff !== 0) return diff;
    const a = `${x.pair[0]}|${x.pair[1]}`;
    const b = `${y.pair[0]}|${y.pair[1]}`;
    return a.localeCompare(b);
  });

  return pairs;
}

export interface WarmupResult {
  success: boolean;
  durationMs: number;
  error?: string;
}

export interface SemanticStatus {
  /** Whether semantic search is enabled in config */
  enabled: boolean;
  /** Whether the model is available (cached/online) */
  available: boolean;
  /** Human-readable reason for the current state */
  reason: string;
  /** Short hint for enabling semantic search (if disabled) */
  enableHint?: string;
  /** The embedding model being used */
  model: string;
  /**
   * How `enabled` was decided (#75):
   * - `explicit-on` / `explicit-off`: `semanticSearchEnabled` is set in config.
   * - `model-none`: `embeddingModel: "none"` opts out regardless of the flag.
   * - `auto-on`: flag unset and the backend is ready without any network
   *   download (local model cached, or the Ollama daemon is reachable).
   * - `auto-off`: flag unset and the backend is not ready yet.
   */
  posture: SemanticPosture;
}

export type SemanticPosture =
  | "explicit-on"
  | "explicit-off"
  | "model-none"
  | "auto-on"
  | "auto-off";

/** The subset of `Config` that decides whether semantic search runs. */
export interface SemanticConfigInput {
  semanticSearchEnabled?: boolean;
  embeddingModel?: string;
  embeddingBackend?: EmbeddingBackend;
  ollamaBaseUrl?: string;
}

const OLLAMA_PROBE_TIMEOUT_MS = 1_500;

/**
 * Cheap, network-local check that an Ollama daemon is up and (when the tag
 * list is available) has the configured model pulled. Never throws.
 */
async function probeOllamaReady(config: SemanticConfigInput): Promise<boolean> {
  const { baseUrl, model } = resolveOllamaSettings(config);
  try {
    const response = await fetch(`${baseUrl}/api/tags`, {
      method: "GET",
      signal: AbortSignal.timeout(OLLAMA_PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return false;
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      // Reachable but not a tag list we understand (proxy, older daemon):
      // reachability is enough; the embed call reports a missing model itself.
      return true;
    }
    const models = (json as { models?: unknown })?.models;
    if (!Array.isArray(models)) return true;
    const wanted = model.includes(":") ? model : `${model}:latest`;
    return models.some((entry) => {
      const name =
        typeof (entry as { name?: unknown })?.name === "string"
          ? (entry as { name: string }).name
          : typeof (entry as { model?: unknown })?.model === "string"
            ? (entry as { model: string }).model
            : "";
      return name === wanted || name === model;
    });
  } catch {
    return false;
  }
}

/**
 * Readiness probes per backend, answering "can this backend embed right now
 * without downloading anything?". Exposed as a mutable table so tests can
 * substitute deterministic probes; production code never reassigns it.
 */
export const semanticReadinessProbes: {
  xenova: (model: string) => Promise<boolean>;
  ollama: (config: SemanticConfigInput) => Promise<boolean>;
} = {
  xenova: (model) => isModelCached(model),
  ollama: probeOllamaReady,
};

/**
 * How long a probe answer is trusted.
 *
 * A one-shot `cm` invocation only ever probes once either way. These matter
 * for long-lived processes (`cm serve`, the MCP server): a "not ready" answer
 * must not pin a whole server session to keyword-only just because the user
 * had not yet run `ollama serve` or finished downloading the model, so it
 * expires quickly. A "ready" answer is re-checked lazily — if the backend
 * disappears mid-process the embed call fails loudly on its own.
 */
const SEMANTIC_READY_TTL_MS = 5 * 60_000;
const SEMANTIC_NOT_READY_TTL_MS = 60_000;

/**
 * Single-slot memo of the readiness probe. Holds the in-flight promise rather
 * than the settled value so concurrent resolvers share one probe instead of
 * racing to run (and pay for) the same check. `expiresAt` is `Infinity` while
 * the probe is in flight and is set from the TTLs above once it settles.
 */
let semanticResolutionCache: { key: string; ready: Promise<boolean>; expiresAt: number } | null =
  null;

/** Forget the memoized readiness probe result (tests, or after `doctor --fix`). */
export function resetSemanticResolutionCache(): void {
  semanticResolutionCache = null;
}

function normalizeEmbeddingModel(config: SemanticConfigInput): string {
  return typeof config.embeddingModel === "string" && config.embeddingModel.trim() !== ""
    ? config.embeddingModel.trim()
    : DEFAULT_EMBEDDING_MODEL;
}

/**
 * Decide whether semantic search runs for this process (#75).
 *
 * `semanticSearchEnabled: true|false` always wins. When it is left unset,
 * semantic search is on exactly when the configured backend is already ready
 * offline — the local model is cached, or the Ollama daemon is reachable — so
 * a fresh install never triggers a surprise download from a session-start
 * hook, yet stops being keyword-only the moment the model exists. The probe
 * is memoized on the config fields it depends on, so a one-shot command runs
 * it at most once; a long-lived process re-checks on the TTLs above.
 *
 * This is the single source of truth: every command (context, similar,
 * stats, onboard, doctor) must go through here instead of reading the flag.
 */
export async function resolveSemanticEnabled(config: SemanticConfigInput): Promise<SemanticStatus> {
  if (config.semanticSearchEnabled !== undefined || normalizeEmbeddingModel(config) === "none") {
    return getSemanticStatus(config);
  }
  const backend = config.embeddingBackend ?? "xenova";
  const model = normalizeEmbeddingModel(config);
  const key = JSON.stringify(
    backend === "ollama"
      ? ["ollama", resolveOllamaSettings(config)]
      : ["xenova", model, getTransformersCacheDir()],
  );
  // Capture the entry locally: another resolver with a different key may
  // replace the single cache slot while we are awaiting this probe.
  let entry = semanticResolutionCache;
  if (!entry || entry.key !== key || Date.now() >= entry.expiresAt) {
    const probe = Promise.resolve().then(() =>
      backend === "ollama"
        ? semanticReadinessProbes.ollama(config)
        : semanticReadinessProbes.xenova(model),
    );
    const created: { key: string; ready: Promise<boolean>; expiresAt: number } = {
      key,
      // A probe must never take down the caller: any throw means "not ready".
      ready: probe.then(
        (ready) => ready === true,
        () => false,
      ),
      expiresAt: Number.POSITIVE_INFINITY,
    };
    created.ready = created.ready.then((ready) => {
      created.expiresAt = Date.now() + (ready ? SEMANTIC_READY_TTL_MS : SEMANTIC_NOT_READY_TTL_MS);
      return ready;
    });
    entry = created;
    semanticResolutionCache = entry;
  }
  return getSemanticStatus(config, { autoReady: await entry.ready });
}

/**
 * Get the current semantic search status for messaging and diagnostics.
 *
 * This helper consolidates semantic state checks for consistent messaging
 * across commands (context, similar, stats, doctor). It is synchronous, so
 * when `semanticSearchEnabled` is unset the caller must supply the backend
 * readiness via `options.autoReady` (see {@link resolveSemanticEnabled},
 * which performs the probe); without it, an unset flag reports `auto-off`.
 *
 * @param config - The loaded Config object (or just the relevant fields)
 * @returns SemanticStatus with enabled, available, reason, posture and enableHint
 */
export function getSemanticStatus(
  config: SemanticConfigInput,
  options: { autoReady?: boolean } = {},
): SemanticStatus {
  const model = normalizeEmbeddingModel(config);
  const cli = getCliName();
  // Name the file the global loader actually reads (#75): config.json is
  // what `cm init` creates; config.yaml/.yml are accepted too.
  const enableHint =
    `Set semanticSearchEnabled: true in ~/.cass-memory/config.json (or config.yaml), ` +
    `or run \`${cli} doctor --fix\``;

  // `embeddingModel: "none"` is the strongest opt-out — it says there is no
  // embedding model at all — so it is checked first and wins over both
  // `semanticSearchEnabled: true` and `false`, exactly as SemanticPosture
  // documents. (Checking it first also lets callers switch on `posture`
  // alone instead of re-testing the model name.)
  if (model === "none") {
    return {
      enabled: false,
      available: false,
      reason: "Embedding model is set to 'none'",
      enableHint: "Remove embeddingModel: none from config or set a valid model",
      model,
      posture: "model-none",
    };
  }

  const backend = config.embeddingBackend ?? "xenova";
  const modelLabel = backend === "ollama" ? `ollama:${resolveOllamaSettings(config).model}` : model;

  // Check if explicitly disabled via config
  if (config.semanticSearchEnabled === false) {
    return {
      enabled: false,
      available: false,
      reason: "Semantic search is disabled in config",
      enableHint,
      model: modelLabel,
      posture: "explicit-off",
    };
  }

  // Flag unset: automatic, but only when the backend is ready without network.
  if (config.semanticSearchEnabled === undefined) {
    if (options.autoReady === true) {
      return {
        enabled: true,
        available: true,
        reason:
          backend === "ollama"
            ? "Semantic search enabled automatically (Ollama daemon reachable)"
            : "Semantic search enabled automatically (embedding model cached locally)",
        model: modelLabel,
        posture: "auto-on",
      };
    }
    return {
      enabled: false,
      available: false,
      reason:
        backend === "ollama"
          ? `Semantic search is off until the Ollama daemon at ${resolveOllamaSettings(config).baseUrl} is reachable`
          : "Semantic search is off until the embedding model is cached locally",
      enableHint:
        backend === "ollama"
          ? `Start Ollama (ollama serve) and pull the model (ollama pull ${resolveOllamaSettings(config).model}); ` +
            `it turns on automatically, or force it with semanticSearchEnabled: true in ` +
            `~/.cass-memory/config.json (or config.yaml)`
          : `Run \`${cli} doctor --fix\` to download the model once (~23 MB); it turns on automatically ` +
            `afterwards, or set semanticSearchEnabled: true in ~/.cass-memory/config.json (or config.yaml)`,
      model: modelLabel,
      posture: "auto-off",
    };
  }

  // Semantic is enabled in config - model availability is determined at runtime
  return {
    enabled: true,
    available: true, // Assume available; actual check happens during embedding
    reason: `Semantic search enabled (${backend} backend)`,
    model: modelLabel,
    posture: "explicit-on",
  };
}

/**
 * Format a one-line semantic mode indicator for human output.
 *
 * @param mode - The mode being used ("semantic" or "keyword")
 * @param status - The semantic status from getSemanticStatus
 * @returns A concise, actionable message for the user
 */
export function formatSemanticModeMessage(
  mode: "semantic" | "keyword",
  status: SemanticStatus,
): string {
  if (mode === "semantic") {
    return `Using semantic search (${status.model})`;
  }

  // Keyword mode - explain why and how to enable semantic
  if (!status.enabled && status.enableHint) {
    return `Using keyword search. ${status.enableHint}`;
  }

  if (status.enabled && !status.available) {
    return `Using keyword search (model unavailable offline). Run any semantic command online to cache the model.`;
  }

  return "Using keyword search";
}

/**
 * Pre-load the embedding model for faster subsequent queries.
 *
 * Why warm up:
 * - First embedding is slow (~500ms model load)
 * - Subsequent embeddings are fast (~3ms)
 * - Better UX to load during init than during first query
 *
 * When to warm up:
 * - During cass-memory init (if semantic search enabled)
 * - Background async (non-blocking)
 * - Before first context/stats command
 *
 * @param options.model - The embedding model to warm up (default: all-MiniLM-L6-v2)
 * @param options.showProgress - Whether to show progress to stderr (auto-detected)
 * @returns Promise resolving to warmup result with success/failure and duration
 */
export async function warmupEmbeddings(
  options: EmbeddingOptions & { showProgress?: boolean } = {},
): Promise<WarmupResult> {
  const runtime = resolveEmbeddingRuntime(options);
  const startTime = Date.now();

  try {
    // Availability means an actual usable vector, not just a successful HTTP
    // response or pipeline allocation. Disabled/empty outputs fail this probe.
    requireValidEmbedding(await embedTextWithRuntime("warmup test", runtime, {
      showProgress: options.showProgress,
    }));

    const durationMs = Date.now() - startTime;
    return { success: true, durationMs };
  } catch (error: any) {
    const durationMs = Date.now() - startTime;
    return {
      success: false,
      durationMs,
      error: error?.message || String(error),
    };
  }
}

/**
 * Check if the embedding model is cached and ready for offline use.
 * Useful for doctor checks and status reporting.
 */
export async function isModelCached(model = DEFAULT_EMBEDDING_MODEL): Promise<boolean> {
  if (model === "none") return false;
  // A loaded model is already ready offline. Do not allocate another ONNX
  // session every time a server's automatic-readiness memo expires.
  if (embedderCache?.model === model && embedderCache.ready) return true;

  let pending = modelCacheProbes.get(model);
  if (!pending) {
    const probe = async (): Promise<boolean> => {
      try {
        // Import first: transformers' env.js otherwise clobbers wasmPaths.
        const { pipeline } = await import("@huggingface/transformers");
        await ensureOnnxWasmRuntime();
        // This temporary pipeline belongs to the probe, not the inference
        // cache, and its ONNX sessions must be disposed after the probe.
        const candidate = await pipeline("feature-extraction", model, {
          device: "wasm",
          dtype: "q8",
          local_files_only: true,
        });
        await candidate.dispose();
        return true;
      } catch {
        return false;
      }
    };
    pending = probe().finally(() => {
      if (modelCacheProbes.get(model) === pending) modelCacheProbes.delete(model);
    });
    modelCacheProbes.set(model, pending);
  }
  return pending;
}

// ---------------------------------------------------------------------------
// Curator dedup index
// ---------------------------------------------------------------------------

/** Embeddings by content hash, for the curator's semantic duplicate check. */
export interface SemanticDedupIndex {
  embeddings: Map<string, number[]>;
  /** Cosine similarity at or above which two rules are the same rule reworded. */
  threshold: number;
}

/**
 * Embed existing bullets (through the on-disk cache) and incoming rule texts
 * so `curatePlaybook` can catch reworded duplicates that word overlap misses.
 *
 * Returns undefined when semantic search is not enabled (explicitly, or in
 * automatic mode because the backend is not ready offline) or embedding
 * fails; curation then falls back to word overlap alone. Never mutates the
 * given bullets, so embeddings are not written into playbook YAML.
 */
export async function buildSemanticDedupIndex(
  existing: PlaybookBullet[],
  newContents: string[],
  config: SemanticConfigInput & { embeddingModel?: string; semanticDedupThreshold?: number },
): Promise<SemanticDedupIndex | undefined> {
  if (newContents.length === 0) return undefined;
  const runtime = resolveEmbeddingRuntime({ config });
  const status = await resolveSemanticEnabled(config);
  if (!status.enabled) return undefined;
  const threshold =
    typeof config.semanticDedupThreshold === "number" ? config.semanticDedupThreshold : 0.75;

  try {
    const incoming = Array.from(new Set(newContents.filter((content) => content?.trim())));
    if (incoming.length === 0) return undefined;
    // Like a retrieval query, fresh incoming text establishes the current
    // runtime's dimensions before old cached rules are hydrated. Otherwise a
    // model with a changed output size could pin dedup to lexical fallback.
    const vectors = await batchEmbedWithRuntime(incoming, 32, runtime);
    const dimensions = requireValidEmbedding(vectors[0]).length;
    const clones = existing
      .filter((b) => b?.id && b?.content)
      .map((b) => ({ ...b, embedding: undefined }) as PlaybookBullet);
    await loadOrComputeEmbeddingsWithRuntime(clones, { expectedDimensions: dimensions }, runtime);
    const embeddings = new Map<string, number[]>();
    for (const b of clones) {
      if (isValidEmbedding(b.embedding, dimensions)) {
        embeddings.set(hashContent(b.content), b.embedding);
      }
    }
    incoming.forEach((content, i) => {
      embeddings.set(hashContent(content), requireValidEmbedding(vectors[i], dimensions));
    });
    return embeddings.size > 0 ? { embeddings, threshold } : undefined;
  } catch (err: any) {
    warn(
      `[curate] Semantic dedup unavailable; using word overlap only. ${err?.message ?? String(err)}`,
    );
    return undefined;
  }
}

