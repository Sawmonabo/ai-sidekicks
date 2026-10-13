// The renderer unit tier's first setup file: compiles the app's markdown parser from the file the
// app's markdown worker compiles, and puts it on the global Sätteri's loaders read before any
// module the tier loads imports the parser. Sätteri's Node build reads it there once, as it loads,
// so every suite parses with the app's own parser.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

(globalThis as { satteriWasmModule?: WebAssembly.Module }).satteriWasmModule =
  new WebAssembly.Module(
    readFileSync(
      createRequire(import.meta.url).resolve("@ai-sidekicks/markdown-parser/satteri.wasm"),
    ),
  );
