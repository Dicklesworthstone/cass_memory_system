/// <reference types="bun-types" />
/// <reference path="./node_modules/@types/node/index.d.ts" />
/// <reference path="./node_modules/@types/diff-match-patch/index.d.ts" />

// Bun supports `import path from "./file.ext" with { type: "file" }` for
// arbitrary asset files, yielding a string path that's valid both under
// `bun run` (on-disk) and `bun build --compile` (virtual FS). We use this
// to embed onnxruntime-web WASM runtimes so semantic search works inside
// the standalone binary (see src/wasm-runtime.ts).
declare module "*.wasm" {
  const path: string;
  export default path;
}
