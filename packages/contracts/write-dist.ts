// Lays out the package's WebAssembly half of `dist/` from a Cargo build of
// `crates/sidekicks-contracts`' workflow checks, whose JSON messages arrive on standard input:
// `wasm-bindgen` links the module and writes its JavaScript glue, and `dist/` takes the module as
// `workflow-check.wasm`, the glue as `workflow-check.js` and `workflow-check.d.ts`, and the
// notices of the crates compiled into it.
// The glue's format belongs to the `wasm-bindgen` crate the workspace locks, so the tool must be
// that crate's release; a lock bump without its matching tool stops here.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { builtModuleOf, writeWasmDist } from "../../tools/wasm-dist.ts";

const PACKAGE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_DIRECTORY = path.resolve(PACKAGE_DIRECTORY, "../..");
const STANDARD_INPUT = 0;
const CRATE_LIBRARY_NAME = "sidekicks_contracts";
/** The name `wasm-bindgen` gives what it writes, and the module's and glue's names in `dist/`. */
const OUTPUT_NAME = "workflow-check";

/** The `wasm-bindgen` crate's version in the workspace's lock. Throws unless it locks one. */
function lockedWasmBindgenVersion(): string {
  const lock = readFileSync(path.join(REPOSITORY_DIRECTORY, "Cargo.lock"), "utf8");
  const versions = [
    ...lock.matchAll(/^\[\[package\]\]\nname = "wasm-bindgen"\nversion = "([^"]+)"$/gm),
  ].map((match) => match[1]);
  const [version] = versions;
  if (version === undefined || versions.length !== 1) {
    throw new Error(
      `Cargo.lock should lock one wasm-bindgen release, and it locks ${versions.length}`,
    );
  }
  return version;
}

/** Throws unless the `wasm-bindgen` tool on the path is the locked release. */
function checkWasmBindgenTool(lockedVersion: string): void {
  const install = `cargo binstall wasm-bindgen-cli --version ${lockedVersion}`;
  let reported: string;
  try {
    reported = execFileSync("wasm-bindgen", ["--version"], { encoding: "utf8" }).trim();
  } catch (error: unknown) {
    throw new Error(
      `wasm-bindgen ${lockedVersion} is not on the path; install it with \`${install}\``,
      {
        cause: error,
      },
    );
  }
  if (reported !== `wasm-bindgen ${lockedVersion}`) {
    throw new Error(
      `Cargo.lock locks wasm-bindgen ${lockedVersion}, but the tool on the path is ` +
        `\`${reported}\`; install the locked release with \`${install}\``,
    );
  }
}

const buildMessages = readFileSync(STANDARD_INPUT, "utf8");
const cargoModulePath = builtModuleOf(buildMessages, CRATE_LIBRARY_NAME).modulePath;
checkWasmBindgenTool(lockedWasmBindgenVersion());

const linkDirectory = mkdtempSync(path.join(tmpdir(), "workflow-check-"));
try {
  // The page hands the glue a module the markdown worker compiled, so the glue never fetches one;
  // the reset function lets the page start a new instance after a trap without awaiting anything.
  execFileSync(
    "wasm-bindgen",
    [
      cargoModulePath,
      "--out-dir",
      linkDirectory,
      "--out-name",
      OUTPUT_NAME,
      "--target",
      "web",
      "--omit-default-module-path",
      "--experimental-reset-state-function",
      "--remove-name-section",
      "--remove-producers-section",
    ],
    { stdio: "inherit" },
  );
  writeWasmDist({
    packageDirectory: PACKAGE_DIRECTORY,
    workspaceDirectory: REPOSITORY_DIRECTORY,
    buildMessages,
    crateLibraryName: CRATE_LIBRARY_NAME,
    isCrateThirdParty: false,
    moduleFile: `${OUTPUT_NAME}.wasm`,
    builtModulePath: path.join(linkDirectory, `${OUTPUT_NAME}_bg.wasm`),
    glueFiles: [
      path.join(linkDirectory, `${OUTPUT_NAME}.js`),
      path.join(linkDirectory, `${OUTPUT_NAME}.d.ts`),
    ],
  });
} finally {
  rmSync(linkDirectory, { recursive: true, force: true });
}
