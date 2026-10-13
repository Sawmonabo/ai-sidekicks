// Lays out the package's `dist/` from a Cargo build of the crate, whose JSON messages arrive on
// standard input: the module as `lz4.wasm`, and the notices of the crates compiled into it.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { writeWasmDist } from "../../tools/wasm-dist.ts";

const PACKAGE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const STANDARD_INPUT = 0;

writeWasmDist({
  packageDirectory: PACKAGE_DIRECTORY,
  workspaceDirectory: PACKAGE_DIRECTORY,
  buildMessages: readFileSync(STANDARD_INPUT, "utf8"),
  crateLibraryName: "compression",
  isCrateThirdParty: false,
  moduleFile: "lz4.wasm",
});
