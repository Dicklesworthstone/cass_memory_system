import { describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { EMBEDDED_ORT_WASM_PATHS } from "../src/wasm-runtime.js";

/**
 * Guards for issue #42: Bun-compiled standalone binary crashed on
 * semantic search because `onnxruntime-web` couldn't locate its WASM
 * runtime files under the virtual `/$bunfs` filesystem.
 *
 * These tests verify:
 *   1. The four expected WASM filenames are embedded as `type: "file"`
 *      imports (so Bun bundles them into standalone binaries).
 *   2. Each embedded path is readable with a non-empty `\0asm` magic
 *      header (valid WebAssembly module).
 *   3. `ensureOnnxWasmRuntime()` can run without throwing.
 *
 * When this breaks in the future (e.g. because @xenova/transformers
 * upgrades to a newer onnxruntime-web with different filenames), we
 * want a deterministic pre-merge signal instead of silent keyword-only
 * fallback in the released binary.
 */
describe("wasm-runtime: embedded ORT WASM files (issue #42)", () => {
  const expected = [
    "ort-wasm.wasm",
    "ort-wasm-simd.wasm",
    "ort-wasm-threaded.wasm",
    "ort-wasm-simd-threaded.wasm",
  ] as const;

  test("exposes exactly the four expected file keys", () => {
    expect(Object.keys(EMBEDDED_ORT_WASM_PATHS).sort()).toEqual([...expected].sort());
  });

  for (const filename of expected) {
    test(`embeds ${filename} as a readable WebAssembly module`, () => {
      const p = EMBEDDED_ORT_WASM_PATHS[filename];
      expect(typeof p).toBe("string");
      expect(p.length).toBeGreaterThan(0);
      expect(existsSync(p)).toBe(true);
      const size = statSync(p).size;
      // onnxruntime-web WASM runtimes are ~9-10 MB each. Guard against a
      // stub / empty file sneaking in through packaging.
      expect(size).toBeGreaterThan(1_000_000);
      // Check the WebAssembly magic header: `\0asm\x01\x00\x00\x00`.
      const fd = Bun.file(p);
      // Bun.file().slice is sync-safe for tiny reads; use an async read
      // for portability with bun test runtimes.
    });
  }

  // Keep native dependency initialization in a fresh process: loading Sharp
  // inside bun test has crashed some Bun/kernel combinations (issue #92).
  test("concurrent initialization callers all see configured runtime paths", () => {
    const child = Bun.spawnSync([process.execPath, "--eval", `
      import { env } from "@xenova/transformers";
      const { ensureOnnxWasmRuntime, EMBEDDED_ORT_WASM_PATHS } = await import("./src/wasm-runtime.ts");
      const first = ensureOnnxWasmRuntime();
      await ensureOnnxWasmRuntime();
      const observed = { paths: env.backends.onnx.wasm.wasmPaths, threads: env.backends.onnx.wasm.numThreads };
      await first;
      console.log(JSON.stringify({ observed, expectedPaths: EMBEDDED_ORT_WASM_PATHS }));
    `], { cwd: `${import.meta.dir}/..`, stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    const result = JSON.parse(child.stdout.toString());
    expect(result.observed.paths).toEqual(result.expectedPaths);
    expect(result.observed.threads).toBe(1);
  });

  test("failed runtime configuration is observable and can be retried", () => {
    const child = Bun.spawnSync([process.execPath, "--eval", `
      import { env } from "@xenova/transformers";
      const { ensureOnnxWasmRuntime, EMBEDDED_ORT_WASM_PATHS } = await import("./src/wasm-runtime.ts");
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
      console.log(JSON.stringify({ error, paths: env.backends.onnx.wasm.wasmPaths, expectedPaths: EMBEDDED_ORT_WASM_PATHS }));
    `], { cwd: `${import.meta.dir}/..`, stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    const result = JSON.parse(child.stdout.toString());
    expect(result.error).toBe("temporary runtime configuration failure");
    expect(result.paths).toEqual(result.expectedPaths);
  });

  test("embedded files start with WebAssembly magic bytes", async () => {
    for (const filename of expected) {
      const p = EMBEDDED_ORT_WASM_PATHS[filename];
      const bytes = new Uint8Array(await Bun.file(p).arrayBuffer());
      // `\0` `a` `s` `m`
      expect(bytes[0]).toBe(0x00);
      expect(bytes[1]).toBe(0x61);
      expect(bytes[2]).toBe(0x73);
      expect(bytes[3]).toBe(0x6d);
    }
  });
});
