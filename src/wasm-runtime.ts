/**
 * Embedded ONNX WASM runtime for the pinned Transformers source entry.
 *
 * Modern ONNX Runtime needs a matching JavaScript factory and WASM binary.
 * Bun file imports include both in the executable's virtual filesystem.
 * Supplying wasmBinary avoids network lookup; the Node-capable web entry
 * retains local model paths and disk caching. Threads/proxy workers remain
 * disabled, while this runtime uses WebAssembly SIMD on the current thread.
 */

import path from "node:path";
import ortWasmPath from "onnxruntime-web/ort-wasm-simd-threaded.wasm" with {
  type: "file",
};
// @ts-expect-error Upstream has no factory asset declaration; Bun's file import returns its embedded path.
import ortFactoryPath from "onnxruntime-web/ort-wasm-simd-threaded.mjs" with {
  type: "file",
};

let configurationPromise: Promise<void> | null = null;

/**
 * Directory where Transformers caches downloaded model files for
 * cass-memory (`~/.cache/cass-memory/transformers/`).
 *
 * The library's default cache is inside its package, which is read-only
 * in a compiled executable. Keep CM's existing user-writable location.
 * Returns null when no home directory can be determined (library default
 * applies).
 */
export function getTransformersCacheDir(): string | null {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) return null;
  return path.join(home, ".cache", "cass-memory", "transformers");
}

/**
 * Ensure `onnxruntime-web`'s WASM runtime files resolve to real,
 * readable paths even when running as a Bun-compiled single-file binary.
 *
 * Also redirects the Transformers model cache + `localModelPath` to
 * a user-writable location (`~/.cache/cass-memory/transformers/`), because
 * its defaults resolve to `/$bunfs/.cache/` inside a Bun standalone binary
 * and emit noisy "EACCES: permission denied, mkdir '/$bunfs'" lines on
 * every command invocation.
 *
 * Concurrent callers share initialization and all wait for it to finish.
 * Failed initialization can be retried on the next call.
 *
 * Call after importing Transformers, which initializes its own runtime URLs.
 */
export function ensureOnnxWasmRuntime(): Promise<void> {
  if (configurationPromise) return configurationPromise;
  const pending = configureOnnxWasmRuntime();
  configurationPromise = pending;
  pending.catch(() => {
    if (configurationPromise === pending) configurationPromise = null;
  });
  return pending;
}

async function configureOnnxWasmRuntime(): Promise<void> {
  const { env: tEnv } = await import("@huggingface/transformers");
  const cacheDir = getTransformersCacheDir();
  if (cacheDir) {
    tEnv.cacheDir = cacheDir;
    tEnv.localModelPath = cacheDir;
  }

  // The postinstall patch and this module must share the same backend instance.
  const wasm = tEnv.backends.onnx.wasm;
  if (!wasm) throw new Error("ONNX Web runtime is missing its WASM environment");
  tEnv.useWasmCache = false;
  wasm.numThreads = 1;
  wasm.proxy = false;
  wasm.simd = true;
  wasm.wasmBinary = await Bun.file(ortWasmPath).arrayBuffer();
  wasm.wasmPaths = { mjs: ortFactoryPath };
}

/**
 * Paths to the paired embedded runtime assets. Exposed for tests and
 * diagnostics (`cm doctor`).
 */
export const EMBEDDED_ORT_ASSET_PATHS = {
  wasm: ortWasmPath,
  mjs: ortFactoryPath,
} as const;
