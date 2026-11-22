import { describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { EMBEDDED_ORT_ASSET_PATHS } from "../src/wasm-runtime.js";
import { withTempDir } from "./helpers/temp.js";

/**
 * Guards for issue #42: Bun-compiled standalone binary crashed on
 * semantic search because `onnxruntime-web` couldn't locate its WASM
 * runtime files under the virtual `/$bunfs` filesystem.
 *
 * These tests verify:
 *   1. The matching WASM binary and JavaScript factory use `type: "file"`
 *      imports (so Bun bundles them into standalone binaries).
 *   2. Both assets are readable, and WASM has a valid `\0asm` magic header.
 *   3. `ensureOnnxWasmRuntime()` can run without throwing.
 *
 * When this breaks in the future (e.g. because Transformers
 * upgrades to a newer onnxruntime-web with different filenames), we
 * want a deterministic pre-merge signal instead of silent keyword-only
 * fallback in the released binary.
 */
describe("wasm-runtime: embedded ORT WASM files (issue #42)", () => {
  const expected = ["wasm", "mjs"] as const;

  test("exposes the matching binary and factory", () => {
    expect(Object.keys(EMBEDDED_ORT_ASSET_PATHS).sort()).toEqual([...expected].sort());
  });

  for (const filename of expected) {
    test(`embeds a readable ${filename} asset`, () => {
      const p = EMBEDDED_ORT_ASSET_PATHS[filename];
      expect(typeof p).toBe("string");
      expect(p.length).toBeGreaterThan(0);
      expect(existsSync(p)).toBe(true);
      const size = statSync(p).size;
      expect(size).toBeGreaterThan(filename === "wasm" ? 1_000_000 : 1_000);
    });
  }

  // Fresh processes verify the actual postinstall-selected public entry point.
  test("concurrent initialization callers all see configured runtime paths", () => {
    const child = Bun.spawnSync([process.execPath, "--eval", `
      import { env } from "@huggingface/transformers";
      import { env as ortEnv } from "onnxruntime-web";
      const { ensureOnnxWasmRuntime, EMBEDDED_ORT_ASSET_PATHS } = await import("./src/wasm-runtime.ts");
      const first = ensureOnnxWasmRuntime();
      await ensureOnnxWasmRuntime();
      const observed = { paths: env.backends.onnx.wasm.wasmPaths, threads: env.backends.onnx.wasm.numThreads,
        proxy: env.backends.onnx.wasm.proxy, simd: env.backends.onnx.wasm.simd,
        bytes: env.backends.onnx.wasm.wasmBinary.byteLength, useWasmCache: env.useWasmCache,
        sameBackend: env.backends.onnx.wasm === ortEnv.wasm };
      await first;
      console.log(JSON.stringify({ observed, expectedPaths: { mjs: EMBEDDED_ORT_ASSET_PATHS.mjs } }));
    `], { cwd: `${import.meta.dir}/..`, stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    const result = JSON.parse(child.stdout.toString());
    expect(result.observed.paths).toEqual(result.expectedPaths);
    expect(result.observed.threads).toBe(1);
    expect(result.observed.proxy).toBe(false);
    expect(result.observed.simd).toBe(true);
    expect(result.observed.useWasmCache).toBe(false);
    expect(result.observed.sameBackend).toBe(true);
    expect(result.observed.bytes).toBeGreaterThan(1_000_000);
  });

  test("failed runtime configuration is observable and can be retried", () => {
    const child = Bun.spawnSync([process.execPath, "--eval", `
      import { env } from "@huggingface/transformers";
      const { ensureOnnxWasmRuntime, EMBEDDED_ORT_ASSET_PATHS } = await import("./src/wasm-runtime.ts");
      let cacheDir = env.cacheDir;
      let failures = 1;
      Object.defineProperty(env, "cacheDir", {
        configurable: true,
        get: () => cacheDir,
        set: value => {
          if (failures-- > 0) throw new Error("temporary runtime configuration failure");
          cacheDir = value;
        },
      });
      let error;
      try { await ensureOnnxWasmRuntime(); } catch (err) { error = err.message; }
      await ensureOnnxWasmRuntime();
      console.log(JSON.stringify({ error, paths: env.backends.onnx.wasm.wasmPaths, expectedPaths: { mjs: EMBEDDED_ORT_ASSET_PATHS.mjs } }));
    `], { cwd: `${import.meta.dir}/..`, stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    const result = JSON.parse(child.stdout.toString());
    expect(result.error).toBe("temporary runtime configuration failure");
    expect(result.paths).toEqual(result.expectedPaths);
  });

  test("embedded files start with WebAssembly magic bytes", async () => {
    const bytes = new Uint8Array(await Bun.file(EMBEDDED_ORT_ASSET_PATHS.wasm).slice(0, 8).arrayBuffer());
    expect([...bytes]).toEqual([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);
    expect(typeof (await import(EMBEDDED_ORT_ASSET_PATHS.mjs)).default).toBe("function");
  });

  test("the text-only runtime rejects image decoding explicitly", () => {
    const child = Bun.spawnSync([process.execPath, "--eval", `
      import { RawImage } from "@huggingface/transformers";
      try { await RawImage.fromBlob(new Blob([new Uint8Array([0])])); }
      catch (error) { console.log(error.message); }
    `], { cwd: `${import.meta.dir}/..`, stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    expect(child.stdout.toString()).toContain("cass-memory includes only text embedding pipelines");
  });

  test("Node WASM inference is serialized and recovers after a rejected run", () => {
    const child = Bun.spawnSync([process.execPath, "--eval", `
      const { runInferenceSession, getSupportedDevices } = await import("./node_modules/@huggingface/transformers/src/backends/onnx.js");
      let active = 0, maximum = 0;
      const session = { run: async ({ value }) => {
        active++; maximum = Math.max(maximum, active);
        await new Promise(resolve => setTimeout(resolve, 10));
        active--;
        if (value === 1) throw new Error("intentional failed run");
        return value;
      } };
      const outputs = await Promise.allSettled([1, 2, 3].map(value => runInferenceSession(session, { value })));
      console.log(JSON.stringify({ maximum, supported: getSupportedDevices(), outputs: outputs.map(x => x.status === "fulfilled" ? x.value : x.reason.message) }));
    `], { cwd: `${import.meta.dir}/..`, stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    expect(JSON.parse(child.stdout.toString())).toEqual({
      maximum: 1, supported: ["wasm"], outputs: ["intentional failed run", 2, 3],
    });
  });
});

describe("standalone dependency patch contract", () => {
  const root = path.resolve(import.meta.dir, "..");
  const fixtureFiles = [
    "scripts/patch-standalone-deps.mjs",
    "node_modules/@huggingface/transformers/package.json",
    "node_modules/@huggingface/transformers/src/backends/onnx.js",
    "node_modules/@huggingface/transformers/src/utils/image.js",
    "node_modules/onnxruntime-web/package.json",
  ];

  async function withInstalledFixture(fn: (dir: string) => Promise<void>) {
    await withTempDir("cm-standalone-patch", async dir => {
      for (const file of fixtureFiles) {
        const target = path.join(dir, file);
        await mkdir(path.dirname(target), { recursive: true });
        await copyFile(path.join(root, file), target);
      }
      await fn(dir);
    });
  }

  test("already-patched inputs are verified without modifying any bytes", async () => {
    await withInstalledFixture(async dir => {
      const before = await Promise.all(fixtureFiles.map(file => readFile(path.join(dir, file), "utf8")));
      const child = Bun.spawnSync([process.execPath, "scripts/patch-standalone-deps.mjs"], { cwd: dir });
      expect(child.exitCode, child.stderr.toString()).toBe(0);
      const after = await Promise.all(fixtureFiles.map(file => readFile(path.join(dir, file), "utf8")));
      expect(after).toEqual(before);
    });
  });

  for (const fault of ["version", "source"] as const) {
    test(`rejects unexpected ${fault} before changing the package entry`, async () => {
      await withInstalledFixture(async dir => {
        const manifestPath = path.join(dir, "node_modules/@huggingface/transformers/package.json");
        const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
        manifest.exports.node.import.default = "./dist/transformers.node.mjs";
        if (fault === "version") manifest.version = "999.0.0";
        const manifestBytes = JSON.stringify(manifest, null, 2) + "\n";
        await writeFile(manifestPath, manifestBytes);
        if (fault === "source") {
          const backend = path.join(dir, "node_modules/@huggingface/transformers/src/backends/onnx.js");
          await writeFile(backend, (await readFile(backend, "utf8")) + "\n// Unexpected dependency modification\n");
        }
        const child = Bun.spawnSync([process.execPath, "scripts/patch-standalone-deps.mjs"], { cwd: dir });
        expect(child.exitCode).not.toBe(0);
        expect(child.stderr.toString()).toContain(fault === "version" ? "Unsupported embedding dependency versions" : "unrecognized source");
        expect(await readFile(manifestPath, "utf8")).toBe(manifestBytes);
      });
    });
  }
});
