/**
 * Standalone-binary WASM runtime setup for @xenova/transformers.
 *
 * Problem (v0.2.5 and earlier):
 * -----------------------------
 * In the Bun-compiled standalone binary (`cm`), semantic search fails
 * silently and falls back to keyword mode. The underlying cause:
 *
 *   1. `scripts/patch-standalone-deps.mjs` rewrites the static
 *      `onnxruntime-node` import to a dynamic import with a WASM fallback
 *      (`onnxruntime-web`), because native `.node` addons cannot be
 *      embedded in a Bun single-file executable.
 *
 *   2. `onnxruntime-web` ships Emscripten JS factories that locate their
 *      `.wasm` files relative to `__dirname`. In a Bun compile, `__dirname`
 *      resolves to paths inside the virtual Bun file system (e.g.
 *      `/$bunfs/root/.../node_modules/onnxruntime-web/dist/`). The `.wasm`
 *      files themselves are NOT embedded (Bun only bundles string-
 *      addressable `import`s), so the Emscripten `locateFile` hook asks
 *      for `/$bunfs/dist/ort-wasm-simd-threaded.wasm` and crashes with:
 *
 *        Aborted(Error: ENOENT: no such file or directory,
 *                open '/$bunfs/dist/ort-wasm-simd-threaded.wasm')
 *
 * Fix:
 * ----
 * Explicitly embed the four candidate WASM runtime files via Bun's
 * `import ... with { type: "file" }` mechanism (Bun replaces the import
 * with a runtime path pointing into the virtual file system — which is
 * readable by `fs.readFileSync`, exactly what the Emscripten factory
 * uses in Node mode).
 *
 * Then before loading the embedder, import `onnxruntime-web` once and
 * populate `env.wasm.wasmPaths` as a filename → path map, so the
 * `locateFile` hook returns our embedded paths instead of the broken
 * default.
 *
 * In `bun run`/dev mode the import paths are normal on-disk node_modules
 * files and this still works; no behavior change for non-standalone runs.
 *
 * Also forces single-threaded, non-SIMD when running in the standalone
 * binary: the threaded variant of the Emscripten factory tries to spawn
 * workers via `URL.createObjectURL(new Blob([...]))` which does not work
 * under Bun single-file executables. Single-threaded, non-SIMD is
 * universally supported and adequate for a 23MB MiniLM model.
 */

// NOTE: these imports must come from onnxruntime-web's real on-disk
// location. When bundled with `bun build --compile`, Bun copies the
// referenced files into the virtual FS and rewrites these identifiers
// to point at the extracted locations. When running under plain `bun
// run`, they resolve to the literal on-disk node_modules paths.
import ortWasmPath from "../node_modules/onnxruntime-web/dist/ort-wasm.wasm" with { type: "file" };
import ortWasmSimdPath from "../node_modules/onnxruntime-web/dist/ort-wasm-simd.wasm" with { type: "file" };
import ortWasmThreadedPath from "../node_modules/onnxruntime-web/dist/ort-wasm-threaded.wasm" with { type: "file" };
import ortWasmSimdThreadedPath from "../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm" with { type: "file" };

let configured = false;

/**
 * Ensure `onnxruntime-web`'s WASM runtime files resolve to real,
 * readable paths even when running as a Bun-compiled single-file binary.
 *
 * Also redirects `@xenova/transformers` model cache + `localModelPath` to
 * a user-writable location (`~/.cache/cass-memory/transformers/`), because
 * its defaults resolve to `/$bunfs/.cache/` inside a Bun standalone binary
 * and emit noisy "EACCES: permission denied, mkdir '/$bunfs'" lines on
 * every command invocation.
 *
 * Safe to call repeatedly (first-call guard).
 *
 * IMPORTANT: must be awaited AFTER `await import("@xenova/transformers")`,
 * because transformers' `env.js` clobbers `onnx_env.wasm.wasmPaths` at
 * module-evaluation time.
 */
export async function ensureOnnxWasmRuntime(): Promise<void> {
  if (configured) return;
  configured = true;

  // Redirect the @xenova/transformers cache to a writable directory.
  // In a Bun standalone binary the default cacheDir and localModelPath
  // both resolve inside /$bunfs (read-only virtual FS), which makes the
  // library emit misleading "permission denied" warnings on every call.
  try {
    const transformers: any = await import("@xenova/transformers");
    const tEnv = transformers?.env ?? transformers?.default?.env;
    if (tEnv) {
      const home = process.env.HOME || process.env.USERPROFILE;
      if (home) {
        const path = await import("node:path");
        const cacheDir = path.join(home, ".cache", "cass-memory", "transformers");
        tEnv.cacheDir = cacheDir;
        tEnv.localModelPath = cacheDir;
      }
    }
  } catch {
    // non-fatal — cache redirection is a polish, not a correctness fix
  }

  try {
    // onnxruntime-web may have been loaded already via @xenova/transformers;
    // either way, importing it a second time returns the cached module, so
    // the `env.wasm.wasmPaths` we set here applies to future session
    // creations.
    const ortWeb: any = await import("onnxruntime-web");
    const env = ortWeb?.env ?? ortWeb?.default?.env;
    if (!env?.wasm) {
      // Nothing to configure — not fatal, let embedding proceed and report
      // the real error at embed time if it still fails.
      return;
    }

    // Disable multi-threading. The threaded Emscripten factory requires
    // `URL.createObjectURL(new Blob(...))`, which is not available in a
    // Bun standalone binary.
    env.wasm.numThreads = 1;

    // Disable SIMD path. We embed both simd and non-simd variants, but
    // picking the plain `ort-wasm.wasm` is the most conservative default
    // and matches the file we always expect to be available on every
    // supported CPU.
    env.wasm.simd = false;

    // Map each expected WASM filename to its extracted on-disk path.
    // `onnxruntime-web` supports `wasmPaths` as either a string prefix or
    // an object map; we use the object form because Bun rewrites the
    // embedded filenames (e.g. `ort-wasm-abc123.wasm`) so a directory
    // prefix would not match.
    env.wasm.wasmPaths = {
      "ort-wasm.wasm": ortWasmPath,
      "ort-wasm-simd.wasm": ortWasmSimdPath,
      "ort-wasm-threaded.wasm": ortWasmThreadedPath,
      "ort-wasm-simd-threaded.wasm": ortWasmSimdThreadedPath,
    };
  } catch (err) {
    // Swallow configuration errors — if this fails, the caller will see
    // the original ENOENT / fetch error and surface it to the user.
    // We intentionally do not log here because in non-standalone runs the
    // import above may fail on systems where onnxruntime-web is not
    // installed (e.g. the @xenova/transformers node-only path is chosen).
  }
}

/**
 * Paths to the embedded WASM files. Exposed primarily for tests and
 * diagnostics (`cm doctor`).
 */
export const EMBEDDED_ORT_WASM_PATHS = {
  "ort-wasm.wasm": ortWasmPath,
  "ort-wasm-simd.wasm": ortWasmSimdPath,
  "ort-wasm-threaded.wasm": ortWasmThreadedPath,
  "ort-wasm-simd-threaded.wasm": ortWasmSimdThreadedPath,
} as const;
