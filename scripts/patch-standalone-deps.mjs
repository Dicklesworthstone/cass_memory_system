#!/usr/bin/env node
/**
 * Postinstall patch for @xenova/transformers standalone binary compatibility.
 *
 * Problem: @xenova/transformers uses static imports for `onnxruntime-node` and
 * `sharp` (native addons). In Bun standalone binaries, native .so/.node files
 * can't be bundled, so these imports crash at runtime.
 *
 * Fix: Replace static imports with dynamic imports wrapped in try/catch, so
 * missing native modules fall back to WASM (onnxruntime-web) or null (sharp).
 *
 * This script runs automatically via the `postinstall` hook in package.json.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const TRANSFORMERS = join(root, "node_modules", "@xenova", "transformers");

let patched = 0;

// --- Patch 1: onnx.js ---
// Replace static `import * as ONNX_NODE from 'onnxruntime-node'` with a
// dynamic import that falls back to null when the native addon is missing.
const onnxPath = join(TRANSFORMERS, "src", "backends", "onnx.js");
if (existsSync(onnxPath)) {
  let src = readFileSync(onnxPath, "utf8");

  // Only patch if not already patched
  if (src.includes("import * as ONNX_NODE from 'onnxruntime-node'")) {
    src = src.replace(
      "import * as ONNX_NODE from 'onnxruntime-node';",
      [
        "// [patched] Dynamic import with WASM fallback for standalone binary compatibility",
        "let ONNX_NODE = null;",
        "try { ONNX_NODE = await import('onnxruntime-node'); } catch {}",
      ].join("\n"),
    );

    // Fix the branch that uses ONNX_NODE — handle null case
    src = src.replace(
      /if\s*\(typeof process !== 'undefined' && process\?\.release\?\.name === 'node'\)\s*\{[\s\S]*?ONNX = ONNX_NODE\.default \?\? ONNX_NODE;/,
      `if (typeof process !== 'undefined' && process?.release?.name === 'node' && ONNX_NODE) {\n    // Native onnxruntime-node available\n    ONNX = ONNX_NODE.default ?? ONNX_NODE;`,
    );

    // After the if/else block, ensure ONNX falls back to web if node failed
    // Add a safety net after the existing if/else
    if (!src.includes("// [patched] WASM safety net")) {
      src = src.replace(
        /^(export let ONNX;\n)/m,
        "export let ONNX;\n",
      );

      // Add fallback after the if/else block
      const closingBrace = src.lastIndexOf(
        "ONNX = ONNX_WEB.default ?? ONNX_WEB;",
      );
      if (closingBrace !== -1) {
        const afterBlock = src.indexOf("}", closingBrace);
        if (afterBlock !== -1) {
          src =
            src.slice(0, afterBlock + 1) +
            "\n\n// [patched] WASM safety net — ensure ONNX is always defined\nif (!ONNX) { ONNX = ONNX_WEB.default ?? ONNX_WEB; }\n" +
            src.slice(afterBlock + 1);
        }
      }
    }

    writeFileSync(onnxPath, src);
    patched++;
    console.log("[patch-standalone-deps] Patched onnx.js: onnxruntime-node → dynamic import with WASM fallback");
  }
}

// --- Patch 2: image.js ---
// Replace static `import sharp from 'sharp'` with a dynamic import that
// returns null when sharp is unavailable (text embedding doesn't need it).
const imagePath = join(TRANSFORMERS, "src", "utils", "image.js");
if (existsSync(imagePath)) {
  let src = readFileSync(imagePath, "utf8");

  if (src.includes("import sharp from 'sharp'")) {
    src = src.replace(
      "import sharp from 'sharp';",
      [
        "// [patched] Dynamic import — sharp is only needed for image pipelines, not text embeddings",
        "let sharp = null;",
        "try { sharp = (await import('sharp')).default; } catch {}",
      ].join("\n"),
    );

    writeFileSync(imagePath, src);
    patched++;
    console.log("[patch-standalone-deps] Patched image.js: sharp → dynamic import with null fallback");
  }
}

if (patched > 0) {
  console.log(`[patch-standalone-deps] Done: ${patched} file(s) patched for standalone binary compatibility`);
} else {
  console.log("[patch-standalone-deps] No patches needed (already patched or files not found)");
}
