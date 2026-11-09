// Lays out the package's `dist/` from a Cargo build of `crates/sidekicks-search`'s matcher, whose
// JSON messages arrive on standard input: the module as `matcher.wasm`, and the notices of the
// crates compiled into it.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { writeWasmDist } from "../../tools/wasm-dist.ts";

const PACKAGE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_DIRECTORY = path.resolve(PACKAGE_DIRECTORY, "../..");
const STANDARD_INPUT = 0;

writeWasmDist({
  packageDirectory: PACKAGE_DIRECTORY,
  workspaceDirectory: REPOSITORY_DIRECTORY,
  buildMessages: readFileSync(STANDARD_INPUT, "utf8"),
  crateLibraryName: "sidekicks_search",
  isCrateThirdParty: false,
  moduleFile: "matcher.wasm",
});
