// Builds Sätteri's markdown parser as a WebAssembly module from its source with our fix: downloads
// the archive of the fork commit that carries the fix, refuses it unless it matches the pinned hash,
// unpacks it into `satteri/`, and compiles the parser as the release does, with the Rust its
// `rust-toolchain.toml` pins. `dist/` then holds the module and the notices of everything compiled
// into it, and `satteri/` stays for the package's tests, which Cargo runs there.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { writeWasmDist } from "../../tools/wasm-dist.ts";

/**
 * The source: the archive of the fork commit holding Sätteri's `satteri-v0.10.5` release with our
 * indented-code-block fix, the same commit the Cargo workspace reads, and its SHA-256.
 */
const SOURCE_ARCHIVE_URL =
  "https://github.com/Sawmonabo/satteri/archive/e16b7bcd04445ce2435fa3f0efbd21835821294d.tar.gz";
const SOURCE_ARCHIVE_SHA256 = "c74cdf22af0759b1f30e640fe3b6107f62ade12c097cee9e37add7c25adf00bf";

const PACKAGE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_DIRECTORY = path.join(PACKAGE_DIRECTORY, "satteri");
/** Sätteri's npm package, where its release runs the parser's build. */
const NPM_PACKAGE_DIRECTORY = path.join(SOURCE_DIRECTORY, "packages", "satteri");
const WASM_TARGET = "wasm32-wasip1-threads";

const require = createRequire(import.meta.url);

const response = await fetch(SOURCE_ARCHIVE_URL);
if (!response.ok) {
  throw new Error(`Downloading ${SOURCE_ARCHIVE_URL} answered ${String(response.status)}`);
}
const archive = Buffer.from(await response.arrayBuffer());
const archiveSha256 = createHash("sha256").update(archive).digest("hex");
if (archiveSha256 !== SOURCE_ARCHIVE_SHA256) {
  throw new Error(
    `${SOURCE_ARCHIVE_URL} hashes to ${archiveSha256}, not the pinned ${SOURCE_ARCHIVE_SHA256}`,
  );
}

rmSync(SOURCE_DIRECTORY, { recursive: true, force: true });
mkdirSync(SOURCE_DIRECTORY);
execFileSync("tar", ["-xzf", "-", "--strip-components=1", "-C", SOURCE_DIRECTORY], {
  input: archive,
  stdio: ["pipe", "inherit", "inherit"],
});

// The Rust the source's `rust-toolchain.toml` pins, and its WebAssembly target, unless installed.
execFileSync("rustup", ["toolchain", "install"], { cwd: SOURCE_DIRECTORY, stdio: "inherit" });
execFileSync("rustup", ["target", "add", WASM_TARGET], { cwd: SOURCE_DIRECTORY, stdio: "inherit" });

// The release's own build command, plus Cargo's JSON messages on standard output, which name the
// crates compiled in, and `--locked`, which holds Cargo to the source's lockfile. Cargo builds into
// this package's `target/`, so a rebuild after the source is unpacked again recompiles only what
// changed.
const napiManifest = require("@napi-rs/cli/package.json") as { readonly bin: { napi: string } };
const buildMessages = execFileSync(
  process.execPath,
  [
    path.join(path.dirname(require.resolve("@napi-rs/cli/package.json")), napiManifest.bin.napi),
    "build",
    "--manifest-path",
    "../../crates/satteri-napi-binding/Cargo.toml",
    "--output-dir",
    ".",
    "--platform",
    "--release",
    "--esm",
    "--strip",
    "--target",
    WASM_TARGET,
    "--",
    "--locked",
    "--message-format=json-render-diagnostics",
  ],
  {
    cwd: NPM_PACKAGE_DIRECTORY,
    env: { ...process.env, CARGO_TARGET_DIR: path.join(PACKAGE_DIRECTORY, "target") },
    encoding: "utf8",
    maxBuffer: Infinity,
    stdio: ["ignore", "pipe", "inherit"],
  },
);

writeWasmDist({
  packageDirectory: PACKAGE_DIRECTORY,
  workspaceDirectory: SOURCE_DIRECTORY,
  buildMessages,
  crateLibraryName: "satteri_napi",
  isCrateThirdParty: true,
  moduleFile: "satteri.wasm",
  builtModulePath: path.join(NPM_PACKAGE_DIRECTORY, "satteri_napi.wasm32-wasi.wasm"),
  // napi's build links emnapi's compiled Node-API layer into the module.
  linkedPackageDirectories: [path.dirname(require.resolve("emnapi/package.json"))],
});
