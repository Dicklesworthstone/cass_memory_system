#!/usr/bin/env bun
/**
 * Pin the installed Transformers source to CM's text-only WASM runtime.
 * Its stock Node bundle excludes WASM, while its browser bundle excludes
 * filesystem caching. Use the source entry with the Node-capable web runtime.
 * Unknown versions, changed source, and incomplete patches fail installation.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const transformersDir = join(root, "node_modules", "@huggingface", "transformers");
const transformerVersion = "4.3.2";
// This prerelease is the maintained upstream package's deliberate runtime pin.
const ortVersion = "1.31.0-dev.20260914-8d85527a0";
const hash = (text) => createHash("sha256").update(text).digest("hex");

function replaceOnce(source, before, after) {
  const index = source.indexOf(before);
  if (index < 0 || source.indexOf(before, index + before.length) !== -1) {
    throw new Error("Expected exactly one upstream patch target; refusing an incomplete patch");
  }
  return source.slice(0, index) + after + source.slice(index + before.length);
}

function prepareSource(relativePath, originalHash, patchedHash, transform) {
  const file = join(transformersDir, relativePath);
  const original = readFileSync(file, "utf8");
  const currentHash = hash(original);
  if (currentHash === patchedHash) return { file, original, updated: original };
  if (currentHash !== originalHash) {
    throw new Error(`${relativePath}: unrecognized source for Transformers ${transformerVersion}; reinstall the locked dependencies`);
  }
  const updated = transform(original);
  if (hash(updated) !== patchedHash) throw new Error(`${relativePath}: patch verification failed`);
  return { file, original, updated };
}

const packagePath = join(transformersDir, "package.json");
const originalPackage = readFileSync(packagePath, "utf8");
const manifest = JSON.parse(originalPackage);
const ortManifest = JSON.parse(readFileSync(join(root, "node_modules", "onnxruntime-web", "package.json"), "utf8"));
if (manifest.version !== transformerVersion || ortManifest.version !== ortVersion) {
  throw new Error(`Unsupported embedding dependency versions; expected Transformers ${transformerVersion} and ONNX Web ${ortVersion}`);
}
const nodeImport = manifest.exports?.node?.import;
if (!nodeImport || !["./dist/transformers.node.mjs", "./src/transformers.js"].includes(nodeImport.default)) {
  throw new Error("Unrecognized Transformers Node ESM export; refusing to select an unpatched runtime");
}
nodeImport.default = "./src/transformers.js";

// Validate every input and output before mutating any dependency file.
const changes = [
  prepareSource(
    "src/backends/onnx.js",
    "b3956d30ca190ca25379c5a1a3e878427571c66a20c8ca4de120448ec207f7e4",
    "665ea2e5ed1d88241aacd7addbc7be24e17e2f2e81975b07e248a9c0d723e6c4",
    (source) => {
      source = replaceOnce(source,
        "// NOTE: Import order matters here. We need to import `onnxruntime-node` before `onnxruntime-web`.\nimport ONNX_NODE from './onnx-node.js';\nimport * as ONNX_WEB from 'onnxruntime-web/webgpu';",
        "// cass-memory uses text-only WASM with Node filesystem support in source and compiled builds.\nimport * as ONNX_WEB from 'onnxruntime-web';");
      const selectionStart = source.indexOf("const supportedDevices = [];");
      const selectionEnd = source.indexOf("/**\n * Get the list of devices supported", selectionStart);
      if (selectionStart < 0 || selectionEnd < 0) throw new Error("Missing upstream runtime selection block");
      source = source.slice(0, selectionStart)
        + "const supportedDevices = ['wasm'];\n\n/** @type {ONNXExecutionProviders[]} */\nconst defaultDevices = ['wasm'];\nconst ONNX = ONNX_WEB;\n\n"
        + source.slice(selectionEnd);
      source = replaceOnce(source,
        "    const session = await (apis.IS_WEB_ENV ? (webInitChain = webInitChain.then(load)) : load());",
        "    const pending = webInitChain.then(load);\n    webInitChain = pending.catch(() => {});\n    const session = await pending;");
      return replaceOnce(source,
        "    return apis.IS_WEB_ENV ? (webInferenceChain = webInferenceChain.then(run)) : run();",
        "    const pending = webInferenceChain.then(run);\n    webInferenceChain = pending.catch(() => {});\n    return pending;");
    },
  ),
  prepareSource(
    "src/utils/image.js",
    "ad67ad4c0dcd2761679ca083a725e961a163e9146b2d3da03d97b1667b12d959",
    "8e5e62a96b9bf0b366a610e1e38770349a69b6ddeb5ca087e45c45bde2a4d98f",
    (source) => replaceOnce(source, "import sharp from 'sharp';",
      "const sharp = () => {\n    throw new Error('Image processing is unavailable: cass-memory includes only text embedding pipelines.');\n};"),
  ),
  { file: packagePath, original: originalPackage, updated: JSON.stringify(manifest, null, 2) + "\n" },
];

let changed = 0;
for (const { file, original, updated } of changes) {
  if (original === updated) continue;
  // Atomic replacement also prevents modifying Bun's hard-linked package cache.
  const temporary = `${file}.cm-${process.pid}.tmp`;
  writeFileSync(temporary, updated, { flag: "wx" });
  renameSync(temporary, file);
  changed++;
}
console.log(`[patch-standalone-deps] Verified Transformers ${transformerVersion} text-only WASM runtime (${changed} files updated)`);
