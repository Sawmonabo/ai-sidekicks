// Lays out the package's `dist/` from a Cargo build of the crate, whose JSON messages arrive on
// standard input: the WebAssembly module, and the license files and notices of every crate
// compiled into it, copied from the folders Cargo unpacked them to. The module's path comes from
// Cargo's own message, so the build's target and profile are named only in the build command.

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIRECTORY = path.join(PACKAGE_DIRECTORY, "dist");
const LICENSES_FOLDER = "THIRD_PARTY_LICENSES";
const MODULE_FILE = "lz4.wasm";
const CRATE_LIBRARY_NAME = "compression";
const STANDARD_INPUT = 0;

/** A crate's legal files, by the names crates ship them under (`LICENSE-MIT`, `COPYING`, …). */
const LEGAL_FILE_NAME = /^(licen[cs]e|copying|notice)/i;

/** The fields read from one of Cargo's JSON build messages. */
interface BuildMessage {
  readonly reason: string;
  readonly package_id?: string;
  readonly target?: { readonly name: string; readonly kind: readonly string[] };
  readonly filenames?: readonly string[];
  readonly success?: boolean;
}

/** The fields read from `cargo metadata`. */
interface CargoMetadata {
  readonly packages: readonly CratePackage[];
  readonly resolve: { readonly nodes: readonly ResolvedCrate[] };
}

interface CratePackage {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly license: string | null;
  readonly repository: string | null;
  readonly manifest_path: string;
}

interface ResolvedCrate {
  readonly id: string;
  readonly deps: readonly {
    readonly pkg: string;
    /** `kind` is null for a normal dependency, else `build` or `dev`. */
    readonly dep_kinds: readonly { readonly kind: string | null }[];
  }[];
}

const messages = readFileSync(STANDARD_INPUT, "utf8")
  .split("\n")
  .filter((line) => line.startsWith("{"))
  .map((line) => JSON.parse(line) as BuildMessage);
if (!messages.some((message) => message.reason === "build-finished" && message.success === true)) {
  throw new Error("Cargo did not finish building the crate; its errors are printed above");
}
const artifacts = messages.filter((message) => message.reason === "compiler-artifact");
const moduleArtifact = artifacts.find(
  (artifact) =>
    artifact.target?.name === CRATE_LIBRARY_NAME && artifact.target.kind.includes("cdylib"),
);
const modulePath = moduleArtifact?.filenames?.find((filename) => filename.endsWith(".wasm"));
if (moduleArtifact?.package_id === undefined || modulePath === undefined) {
  throw new Error("Cargo's build wrote no WebAssembly module for the crate");
}

const metadata = JSON.parse(
  // Cargo describes every crate the workspace resolves, which passes Node's 1 MiB default.
  execFileSync("cargo", ["metadata", "--format-version", "1"], {
    cwd: PACKAGE_DIRECTORY,
    encoding: "utf8",
    maxBuffer: Infinity,
  }),
) as CargoMetadata;
const crates = compiledDependenciesOf(moduleArtifact.package_id);

rmSync(DIST_DIRECTORY, { recursive: true, force: true });
mkdirSync(DIST_DIRECTORY);
copyFileSync(modulePath, path.join(DIST_DIRECTORY, MODULE_FILE));
writeFileSync(
  path.join(DIST_DIRECTORY, "THIRD_PARTY_NOTICES.md"),
  [
    "# Third-Party Notices",
    `\`${MODULE_FILE}\` carries the compiled code of these Rust crates, each under the license ` +
      `named here; their license files are in \`${LICENSES_FOLDER}/\`.`,
    ...crates.map(copyNoticeOf),
  ].join("\n\n") + "\n",
);

/**
 * The crates the module links, found from the crate by its normal dependencies (never a build or
 * test one) and kept only when this build compiled them, which drops a dependency for another
 * platform. Sorted by name and version.
 */
function compiledDependenciesOf(crateId: string): CratePackage[] {
  const compiledIds = new Set(artifacts.map((artifact) => artifact.package_id));
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const linkedIds = new Set<string>();
  const pending = [crateId];
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    const node = nodes.get(id);
    if (node === undefined) {
      throw new Error(`cargo metadata resolved no crate ${id}`);
    }
    for (const dependency of node.deps) {
      const isLinked =
        dependency.dep_kinds.some((kind) => kind.kind === null) && compiledIds.has(dependency.pkg);
      if (isLinked && !linkedIds.has(dependency.pkg)) {
        linkedIds.add(dependency.pkg);
        pending.push(dependency.pkg);
      }
    }
  }
  return metadata.packages
    .filter((crate) => linkedIds.has(crate.id))
    .sort((left, right) =>
      `${left.name} ${left.version}`.localeCompare(`${right.name} ${right.version}`),
    );
}

/** Copies a crate's legal files into the licenses folder and returns its section of the notices. */
function copyNoticeOf(crate: CratePackage): string {
  const crateDirectory = path.dirname(crate.manifest_path);
  const legalFiles = readdirSync(crateDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && LEGAL_FILE_NAME.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (legalFiles.length === 0) {
    throw new Error(`${crate.name} ${crate.version} ships no license file in ${crateDirectory}`);
  }
  const copiedFolder = `${LICENSES_FOLDER}/${crate.name}-${crate.version}`;
  mkdirSync(path.join(DIST_DIRECTORY, copiedFolder), { recursive: true });
  for (const file of legalFiles) {
    copyFileSync(path.join(crateDirectory, file), path.join(DIST_DIRECTORY, copiedFolder, file));
  }
  return [
    `## ${crate.name} ${crate.version}`,
    [
      `- License: ${crate.license ?? "not declared"}`,
      `- Source: ${crate.repository ?? "not declared"}`,
      "- License files:",
      ...legalFiles.map((file) => `  - [\`${copiedFolder}/${file}\`](${copiedFolder}/${file})`),
    ].join("\n"),
  ].join("\n\n");
}
