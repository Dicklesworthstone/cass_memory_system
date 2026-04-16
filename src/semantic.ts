import fs from "node:fs/promises";
import path from "node:path";
import {
  EmbeddingCache,
  EmbeddingCacheSchema,
  Playbook,
  PlaybookBullet,
} from "./types.js";
import { atomicWrite, expandPath, hashContent, resolveGlobalDir, warn } from "./utils.js";
import { withLock } from "./lock.js";
import { getOutputStyle } from "./output.js";
import { ensureOnnxWasmRuntime } from "./wasm-runtime.js";

export const DEFAULT_EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
export const EMBEDDING_CACHE_VERSION = "1.0";

let embedderPromise: Promise<any> | null = null;
let embedderModel: string | null = null;

// ============================================================================
// OLLAMA EMBEDDING BACKEND
// ============================================================================

export type EmbeddingBackend = "xenova" | "ollama";

let embeddingBackend: EmbeddingBackend = "xenova";

interface OllamaConfig {
  baseUrl: string;
  model: string;
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
 * Embed a single text using Ollama's /api/embed endpoint.
 *
 * @param text - The text to embed (must be non-empty after trimming)
 * @returns The embedding vector as a number array
 * @throws Error with descriptive message on connection failure, model not found, etc.
 */
async function embedTextOllama(text: string): Promise<number[]> {
  const url = `${ollamaConfig.baseUrl}/api/embed`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: ollamaConfig.model, input: text }),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("ECONNREFUSED") || message.includes("fetch failed")) {
      throw new Error(
        `Ollama connection refused at ${ollamaConfig.baseUrl}. ` +
        `Is Ollama running? Start it with: ollama serve`
      );
    }
    throw new Error(`Ollama embedding request failed: ${message}`);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "(no body)");
    if (response.status === 404 || body.includes("not found")) {
      throw new Error(
        `Ollama model "${ollamaConfig.model}" not found. ` +
        `Pull it with: ollama pull ${ollamaConfig.model}`
      );
    }
    throw new Error(
      `Ollama embedding failed (HTTP ${response.status}): ${body}`
    );
  }

  const json = await response.json() as { embeddings?: number[][] };
  if (
    !json.embeddings ||
    !Array.isArray(json.embeddings) ||
    json.embeddings.length === 0 ||
    !Array.isArray(json.embeddings[0])
  ) {
    throw new Error("Unexpected Ollama response: missing or empty embeddings array");
  }

  return json.embeddings[0];
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
  onProgress?: (event: { processed: number; total: number }) => void
): Promise<number[][]> {
  const url = `${ollamaConfig.baseUrl}/api/embed`;

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
  for (let start = 0; start < nonEmpty.length; start += BATCH_SIZE) {
    const batch = nonEmpty.slice(start, start + BATCH_SIZE);
    const batchTexts = batch.map((b) => b.text);

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: ollamaConfig.model, input: batchTexts }),
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("ECONNREFUSED") || message.includes("fetch failed")) {
        throw new Error(
          `Ollama connection refused at ${ollamaConfig.baseUrl}. ` +
          `Is Ollama running? Start it with: ollama serve`
        );
      }
      throw new Error(`Ollama batch embedding request failed: ${message}`);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "(no body)");
      if (response.status === 404 || body.includes("not found")) {
        throw new Error(
          `Ollama model "${ollamaConfig.model}" not found. ` +
          `Pull it with: ollama pull ${ollamaConfig.model}`
        );
      }
      throw new Error(
        `Ollama batch embedding failed (HTTP ${response.status}): ${body}`
      );
    }

    const json = await response.json() as { embeddings?: number[][] };
    if (
      !json.embeddings ||
      !Array.isArray(json.embeddings) ||
      json.embeddings.length !== batchTexts.length
    ) {
      throw new Error(
        `Unexpected Ollama batch response: expected ${batchTexts.length} embeddings, ` +
        `got ${json.embeddings?.length ?? 0}`
      );
    }

    for (let i = 0; i < batch.length; i++) {
      output[batch[i].index] = json.embeddings[i];
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
  status: "initiate" | "download" | "progress" | "done" | "ready";
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
    } else if (progress.status === "progress" && typeof progress.progress === "number") {
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
  options: { showProgress?: boolean; progressCallback?: ProgressCallback } = {}
): Promise<any> {
  // IMPORT ORDER IS LOAD-BEARING. @xenova/transformers/src/env.js
  // unconditionally sets `onnx_env.wasm.wasmPaths = path.join(__dirname, "/dist/")`
  // at module-evaluation time. In a Bun standalone binary, __dirname is
  // `/$bunfs`, so wasmPaths becomes `/$bunfs/dist/` — a path that does
  // not exist, causing semantic search to abort with
  //   "Aborted(Error: ENOENT: ... open '/$bunfs/dist/ort-wasm-*.wasm')".
  //
  // We MUST therefore import @xenova/transformers FIRST (let env.js run
  // and clobber wasmPaths with its bad default), then immediately call
  // ensureOnnxWasmRuntime() to overwrite wasmPaths with the correct
  // embedded-file map. See src/wasm-runtime.ts for the fix rationale.
  const { pipeline } = await import("@xenova/transformers");
  await ensureOnnxWasmRuntime();

  const showProgress = options.showProgress ?? shouldShowProgress();
  const progressCallback = options.progressCallback ?? (showProgress ? createStderrProgressCallback() : undefined);
  
  // Lock to prevent concurrent model downloads from corrupting the cache
  const lockPath = path.join(resolveGlobalDir(), "embeddings", "model_loading");

  return withLock(lockPath, async () => {
    try {
      const result = await pipeline("feature-extraction", model, {
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
            `  1. Run any 'cm' command with semantic search while online to download the model\n` +
            `  2. The model will be cached in ~/.cache/huggingface/\n` +
            `Original error: ${error.message}`
          );
        }
      }

      throw error;
    }
  }, { staleLockThresholdMs: 600_000 }); // 10 minute timeout for downloads
}

export interface GetEmbedderOptions {
  showProgress?: boolean;
  progressCallback?: ProgressCallback;
}

export async function getEmbedder(
  model = DEFAULT_EMBEDDING_MODEL,
  options: GetEmbedderOptions = {}
): Promise<any> {
  if (embedderPromise && embedderModel === model) return embedderPromise;

  embedderModel = model;
  embedderPromise = loadEmbedder(model, options);

  // If the model load fails, allow retry on the next call.
  embedderPromise.catch(() => {
    embedderPromise = null;
    embedderModel = null;
  });

  return embedderPromise;
}

export async function embedText(
  text: string,
  options: { model?: string } = {}
): Promise<number[]> {
  const model = options.model || DEFAULT_EMBEDDING_MODEL;
  if (model === "none") return [];
  const cleaned = text?.trim();
  if (!cleaned) return [];

  // Route to Ollama backend when configured
  if (embeddingBackend === "ollama") {
    return embedTextOllama(cleaned);
  }

  const embedder = await getEmbedder(model);
  const result: any = await embedder(cleaned, { pooling: "mean", normalize: true });

  const data: any = result?.data;
  if (!data || typeof data.length !== "number") {
    throw new Error("Unexpected embedder output (missing data)");
  }

  return Array.from(data) as number[];
}

export async function batchEmbed(
  texts: string[],
  batchSize = 32,
  options: { model?: string; onProgress?: (event: { processed: number; total: number }) => void } = {}
): Promise<number[][]> {
  const model = options.model || DEFAULT_EMBEDDING_MODEL;
  if (model === "none") return texts.map(() => []);

  // Route to Ollama backend when configured
  if (embeddingBackend === "ollama") {
    return batchEmbedOllama(texts, options.onProgress);
  }

  const safeBatchSize =
    Number.isFinite(batchSize) && batchSize > 0 ? Math.floor(batchSize) : 32;

  const cleaned = texts.map((t) => (typeof t === "string" ? t.trim() : ""));
  const output: number[][] = new Array(cleaned.length);
  for (let i = 0; i < cleaned.length; i++) {
    if (!cleaned[i]) output[i] = [];
  }

  const embedder = await getEmbedder(model);

  // Batch only the non-empty strings, but preserve indices in the output.
  const nonEmpty: Array<{ index: number; text: string }> = [];
  for (let i = 0; i < cleaned.length; i++) {
    const t = cleaned[i];
    if (t) nonEmpty.push({ index: i, text: t });
  }

  for (let start = 0; start < nonEmpty.length; start += safeBatchSize) {
    const batch = nonEmpty.slice(start, start + safeBatchSize);
    const batchTexts = batch.map((b) => b.text);

    const result: any = await embedder(batchTexts, { pooling: "mean", normalize: true });

    const data: any = result?.data;
    const dims: any = result?.dims;
    const batchCount = Array.isArray(dims) && typeof dims[0] === "number" ? dims[0] : null;
    const dim = Array.isArray(dims) && typeof dims[1] === "number" ? dims[1] : null;

    if (!data || typeof data.length !== "number" || !batchCount || !dim) {
      throw new Error("Unexpected embedder output (missing data/dims)");
    }
    if (batchCount !== batchTexts.length) {
      throw new Error(`Unexpected embedder output (batch mismatch: got ${batchCount}, expected ${batchTexts.length})`);
    }

    for (let i = 0; i < batchCount; i++) {
      const startIdx = i * dim;
      const endIdx = startIdx + dim;
      const vec = Array.from(data.subarray ? data.subarray(startIdx, endIdx) : data.slice(startIdx, endIdx)) as number[];
      output[batch[i].index] = vec;
    }

    if (typeof options.onProgress === "function") {
      try {
        options.onProgress({ processed: Math.min(start + batchCount, nonEmpty.length), total: nonEmpty.length });
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
  if (!a?.length || !b?.length) return 0;
  if (a.length !== b.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function getEmbeddingCachePath(): string {
  return path.join(resolveGlobalDir(), "embeddings", "bullets.json");
}

export function createEmptyEmbeddingCache(model = DEFAULT_EMBEDDING_MODEL): EmbeddingCache {
  return { version: EMBEDDING_CACHE_VERSION, model, bullets: {} };
}

export async function loadEmbeddingCache(
  options: { cachePath?: string; model?: string } = {}
): Promise<EmbeddingCache> {
  const model = options.model || DEFAULT_EMBEDDING_MODEL;
  const cachePath = expandPath(options.cachePath || getEmbeddingCachePath());

  try {
    const raw = await fs.readFile(cachePath, "utf-8");
    const parsed = JSON.parse(raw);

    const result = EmbeddingCacheSchema.safeParse(parsed);
    if (!result.success) {
      warn(`[semantic] Invalid embedding cache; ignoring (${cachePath})`);
      return createEmptyEmbeddingCache(model);
    }

    const cache = result.data;
    if (cache.model !== model || cache.version !== EMBEDDING_CACHE_VERSION) {
      return createEmptyEmbeddingCache(model);
    }

    return cache;
  } catch (err: any) {
    if (err?.code && err.code !== "ENOENT") {
      warn(`[semantic] Failed to load embedding cache (${cachePath}): ${err.message}`);
    }
    return createEmptyEmbeddingCache(model);
  }
}

export async function saveEmbeddingCache(
  cache: EmbeddingCache,
  options: { cachePath?: string } = {}
): Promise<void> {
  const cachePath = expandPath(options.cachePath || getEmbeddingCachePath());
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

export async function loadOrComputeEmbeddingsForBullets(
  bullets: PlaybookBullet[],
  options: {
    model?: string;
    cachePath?: string;
    onProgress?: (event: {
      phase: "start" | "progress" | "done";
      current: number;
      total: number;
      reused: number;
      computed: number;
      skipped: number;
      message: string;
    }) => void;
  } = {}
): Promise<{ cache: EmbeddingCache; stats: EmbeddingStats }> {
  const model = options.model || DEFAULT_EMBEDDING_MODEL;
  const cachePath = expandPath(options.cachePath || getEmbeddingCachePath());

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

    const cache = await loadEmbeddingCache({ cachePath, model });

    let reused = 0;
    let computed = 0;
    let skipped = 0;

    const toCompute: Array<{ bullet: PlaybookBullet; contentHash: string }> = [];

    for (const bullet of bullets) {
      if (!bullet?.id || !bullet?.content) {
        skipped++;
        continue;
      }

      const contentHash = hashContent(bullet.content);
      const cached = cache.bullets[bullet.id];

      if (
        cached?.contentHash === contentHash &&
        Array.isArray(cached.embedding) &&
        cached.embedding.length > 0
      ) {
        bullet.embedding = cached.embedding;
        reused++;
        continue;
      }

      toCompute.push({ bullet, contentHash });
    }

    const totalToCompute = toCompute.length;
    emitProgress({
      phase: "start",
      current: 0,
      total: totalToCompute,
      reused,
      computed,
      skipped,
      message: totalToCompute > 0 ? "Computing semantic embeddings..." : "Semantic embeddings up to date",
    });

    if (model !== "none" && toCompute.length > 0) {
      try {
        const embeddings = await batchEmbed(
          toCompute.map((x) => x.bullet.content),
          32,
          {
            model,
            onProgress: (event) => {
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
          }
        );

        for (let i = 0; i < toCompute.length; i++) {
          const { bullet, contentHash } = toCompute[i];
          const embedding = embeddings[i] || [];

          if (!Array.isArray(embedding) || embedding.length === 0) {
            skipped++;
            continue;
          }

          bullet.embedding = embedding;
          cache.bullets[bullet.id] = {
            contentHash,
            embedding,
            computedAt: new Date().toISOString(),
          };
          computed++;
        }
      } catch (err: any) {
        warn(`[semantic] batchEmbed failed; falling back to per-text embedding. ${err?.message || ""}`.trim());

        let processed = 0;
        for (const { bullet, contentHash } of toCompute) {
          try {
            const embedding = await embedText(bullet.content, { model });
            if (embedding.length === 0) {
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
              continue;
            }

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
            warn(`[semantic] embedText failed for bullet ${bullet.id}: ${innerErr?.message || innerErr}`);
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
    }

    // Only save if we computed something or if we want to ensure the cache file exists
    if (computed > 0 || !await fs.access(cachePath).then(() => true).catch(() => false)) {
      await saveEmbeddingCache(cache, { cachePath });
    }

    emitProgress({
      phase: "done",
      current: totalToCompute,
      total: totalToCompute,
      reused,
      computed,
      skipped,
      message: computed > 0 ? "Semantic embeddings computed" : "Semantic embeddings ready",
    });

    return { cache, stats: { reused, computed, skipped } };
  });
}

export async function loadOrComputeEmbeddings(
  playbook: Playbook,
  options: { model?: string; cachePath?: string } = {}
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
  options: { threshold?: number; model?: string; cachePath?: string; queryEmbedding?: number[] } = {}
): Promise<SimilarBulletMatch[]> {
  const cleaned = query?.trim();
  if (!cleaned) return [];

  if (!Number.isFinite(topK) || topK <= 0) return [];

  const threshold =
    typeof options.threshold === "number" && Number.isFinite(options.threshold)
      ? options.threshold
      : undefined;

  const model = options.model || DEFAULT_EMBEDDING_MODEL;

  const queryEmbedding =
    options.queryEmbedding && Array.isArray(options.queryEmbedding) && options.queryEmbedding.length > 0
      ? options.queryEmbedding
      : await embedText(cleaned, { model });

  if (!queryEmbedding.length) return [];

  const allHaveEmbeddings = bullets.every(
    (b) => Array.isArray(b.embedding) && b.embedding.length > 0
  );
  if (!allHaveEmbeddings) {
    await loadOrComputeEmbeddingsForBullets(bullets, { model, cachePath: options.cachePath });
  }

  const matches: SimilarBulletMatch[] = [];

  for (const bullet of bullets) {
    if (!bullet?.content) continue;
    if (!Array.isArray(bullet.embedding) || bullet.embedding.length === 0) continue;

    const similarity = cosineSimilarity(queryEmbedding, bullet.embedding);
    if (threshold !== undefined && similarity < threshold) continue;

    matches.push({ bullet, similarity });
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
  options: { model?: string; cachePath?: string; ensureEmbeddings?: boolean } = {}
): Promise<SemanticDuplicatePair[]> {
  const cleanedThreshold =
    typeof threshold === "number" && Number.isFinite(threshold) ? threshold : 0.85;
  const minSimilarity = Math.min(1, Math.max(0, cleanedThreshold));

  const candidates = bullets.filter(
    (b) => Boolean(b?.id) && Boolean(b?.content)
  );
  if (candidates.length < 2) return [];

  const model = options.model || DEFAULT_EMBEDDING_MODEL;

  const ensureEmbeddings = options.ensureEmbeddings !== false;
  if (ensureEmbeddings) {
    const allHaveEmbeddings = candidates.every(
      (b) => Array.isArray(b.embedding) && b.embedding.length > 0
    );

    if (!allHaveEmbeddings && model !== "none") {
      await loadOrComputeEmbeddingsForBullets(candidates, {
        model,
        cachePath: options.cachePath,
      });
    }
  }

  const pairs: SemanticDuplicatePair[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const a = candidates[i];
    if (!Array.isArray(a.embedding) || a.embedding.length === 0) continue;

    for (let j = i + 1; j < candidates.length; j++) {
      const b = candidates[j];
      if (!Array.isArray(b.embedding) || b.embedding.length === 0) continue;

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
}

/**
 * Get the current semantic search status for messaging and diagnostics.
 *
 * This helper consolidates semantic state checks for consistent messaging
 * across commands (context, similar, stats, doctor).
 *
 * @param config - The loaded Config object (or just the relevant fields)
 * @returns SemanticStatus with enabled, available, reason, and enableHint
 */
export function getSemanticStatus(config: {
  semanticSearchEnabled?: boolean;
  embeddingModel?: string;
  embeddingBackend?: EmbeddingBackend;
}): SemanticStatus {
  const model = typeof config.embeddingModel === "string" && config.embeddingModel.trim() !== ""
    ? config.embeddingModel.trim()
    : DEFAULT_EMBEDDING_MODEL;

  // Check if explicitly disabled via config
  if (config.semanticSearchEnabled === false) {
    return {
      enabled: false,
      available: false,
      reason: "Semantic search is disabled in config",
      enableHint: "Set semanticSearchEnabled: true in ~/.cass-memory/config.yaml",
      model,
    };
  }

  // Check if disabled via model="none"
  if (model === "none") {
    return {
      enabled: false,
      available: false,
      reason: "Embedding model is set to 'none'",
      enableHint: "Remove embeddingModel: none from config or set a valid model",
      model,
    };
  }

  // Semantic is enabled in config - model availability is determined at runtime
  const backend = config.embeddingBackend ?? "xenova";
  const modelLabel = backend === "ollama" ? `ollama:${ollamaConfig.model}` : model;
  return {
    enabled: true,
    available: true, // Assume available; actual check happens during embedding
    reason: `Semantic search enabled (${backend} backend)`,
    model: modelLabel,
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
  status: SemanticStatus
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
  options: { model?: string; showProgress?: boolean } = {}
): Promise<WarmupResult> {
  const model = options.model || DEFAULT_EMBEDDING_MODEL;
  const startTime = Date.now();

  // For Ollama backend, warm up by running a test embed through Ollama
  if (embeddingBackend === "ollama") {
    try {
      await embedTextOllama("warmup test");
      const durationMs = Date.now() - startTime;
      return { success: true, durationMs };
    } catch (error: unknown) {
      const durationMs = Date.now() - startTime;
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, durationMs, error: message };
    }
  }

  try {
    // Load the embedder (triggers download if needed, shows progress)
    const embedder = await getEmbedder(model, {
      showProgress: options.showProgress,
    });

    // Run a test embedding to fully initialize the model
    await embedder("warmup test", { pooling: "mean", normalize: true });

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
  try {
    // See loadEmbedder for why WASM runtime setup must happen AFTER
    // @xenova/transformers import (env.js clobbers wasmPaths at import).
    const { pipeline } = await import("@xenova/transformers");
    await ensureOnnxWasmRuntime();
    // Try to load with local_files_only - will fail if not cached
    await pipeline("feature-extraction", model, {
      local_files_only: true,
    });
    return true;
  } catch {
    return false;
  }
}
