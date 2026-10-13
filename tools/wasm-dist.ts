// Lays out a package's `dist/` from a Cargo build of a WebAssembly module: the module, and the
// license files and notices of every crate compiled into it, copied from the folders Cargo unpacked
// them to, plus those of any npm package whose compiled code the build linked in. The crates come
// from Cargo's own JSON build messages, so a package's build target and profile are named only in
// its build command.

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const LICENSES_FOLDER = "THIRD_PARTY_LICENSES";

/** A project's legal files, by the names projects ship them under (`LICENSE-MIT`, `COPYING`, …). */
const LEGAL_FILE_NAME = /^(licen[cs]e|copying|notice)/i;

/** What one package's `dist/` is laid out from. */
export interface WasmDist {
  /** The package whose `dist/` is written. */
  readonly packageDirectory: string;
  /** The Cargo workspace the module was built in, where `cargo metadata` runs. */
  readonly workspaceDirectory: string;
  /** Cargo's output under `--message-format=json-render-diagnostics`: one JSON message a line. */
  readonly buildMessages: string;
  /** The library name of the `cdylib` crate the module is. */
  readonly crateLibraryName: string;
  /** The module's file name in `dist/`. */
  readonly moduleFile: string;
  /** The module to copy when a step after Cargo rewrote it; Cargo's own output otherwise. */
  readonly builtModulePath?: string;
  /** The folders of npm packages whose compiled code the build linked into the module. */
  readonly linkedPackageDirectories?: readonly string[];
}

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
  readonly workspace_members: readonly string[];
  readonly workspace_root: string;
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

/** One project whose compiled code the module carries, and the folder its legal files are in. */
interface CarriedProject {
  readonly name: string;
  readonly version: string;
  readonly license: string | null;
  readonly repository: string | null;
  readonly legalDirectory: string;
}

/**
 * Empties the package's `dist/` and writes the module and `THIRD_PARTY_NOTICES.md` into it. Throws
 * when Cargo's build failed or wrote no module for the crate, or when a carried project declares
 * no license and ships no license file.
 */
export function writeWasmDist(dist: WasmDist): void {
  const messages = dist.buildMessages
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as BuildMessage);
  if (
    !messages.some((message) => message.reason === "build-finished" && message.success === true)
  ) {
    throw new Error("Cargo did not finish building the crate; its errors are printed above");
  }
  const artifacts = messages.filter((message) => message.reason === "compiler-artifact");
  const moduleArtifact = artifacts.find(
    (artifact) =>
      artifact.target?.name === dist.crateLibraryName && artifact.target.kind.includes("cdylib"),
  );
  const modulePath =
    dist.builtModulePath ?? moduleArtifact?.filenames?.find((file) => file.endsWith(".wasm"));
  if (moduleArtifact?.package_id === undefined || modulePath === undefined) {
    throw new Error("Cargo's build wrote no WebAssembly module for the crate");
  }

  const metadata = JSON.parse(
    // Cargo describes every crate the workspace resolves, which passes Node's 1 MiB default.
    execFileSync("cargo", ["metadata", "--format-version", "1"], {
      cwd: dist.workspaceDirectory,
      encoding: "utf8",
      maxBuffer: Infinity,
    }),
  ) as CargoMetadata;
  const carried = [
    ...linkedCratesOf(moduleArtifact.package_id, artifacts, metadata),
    ...(dist.linkedPackageDirectories ?? []).map(npmPackageOf),
  ];

  const distDirectory = path.join(dist.packageDirectory, "dist");
  rmSync(distDirectory, { recursive: true, force: true });
  mkdirSync(distDirectory);
  copyFileSync(modulePath, path.join(distDirectory, dist.moduleFile));
  writeFileSync(
    path.join(distDirectory, "THIRD_PARTY_NOTICES.md"),
    [
      "# Third-Party Notices",
      `\`${dist.moduleFile}\` carries the compiled code of these projects, each under the license ` +
        `named here; their license files are in \`${LICENSES_FOLDER}/\`.`,
      ...carried.map((project) => copyNoticeOf(project, distDirectory)),
    ].join("\n\n") + "\n",
  );
}

/**
 * The crates the module links, found from the crate by its normal dependencies (never a build or
 * test one) and kept only when this build compiled them, which drops a dependency for another
 * platform. A procedural macro runs in the compiler and links nothing, so neither it nor what it
 * depends on is kept. Sorted by name and version. A crate of the build's own workspace that ships
 * no license file of its own is under the workspace's.
 */
function linkedCratesOf(
  crateId: string,
  artifacts: readonly BuildMessage[],
  metadata: CargoMetadata,
): CarriedProject[] {
  const compiledIds = new Set(artifacts.map((artifact) => artifact.package_id));
  const procMacroIds = new Set(
    artifacts
      .filter((artifact) => artifact.target?.kind.includes("proc-macro"))
      .map((artifact) => artifact.package_id),
  );
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
        dependency.dep_kinds.some((kind) => kind.kind === null) &&
        compiledIds.has(dependency.pkg) &&
        !procMacroIds.has(dependency.pkg);
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
    )
    .map((crate) => {
      const crateDirectory = path.dirname(crate.manifest_path);
      const isWorkspaceMember = metadata.workspace_members.includes(crate.id);
      return {
        name: crate.name,
        version: crate.version,
        license: crate.license,
        repository: crate.repository,
        legalDirectory:
          isWorkspaceMember && legalFilesIn(crateDirectory).length === 0
            ? metadata.workspace_root
            : crateDirectory,
      };
    });
}

/** The npm package in `packageDirectory`, read from its manifest. */
function npmPackageOf(packageDirectory: string): CarriedProject {
  const manifest = JSON.parse(
    readFileSync(path.join(packageDirectory, "package.json"), "utf8"),
  ) as {
    readonly name: string;
    readonly version: string;
    readonly license?: string;
    readonly repository?: string | { readonly url: string };
  };
  return {
    name: manifest.name,
    version: manifest.version,
    license: manifest.license ?? null,
    repository:
      typeof manifest.repository === "object"
        ? manifest.repository.url
        : (manifest.repository ?? null),
    legalDirectory: packageDirectory,
  };
}

function legalFilesIn(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && LEGAL_FILE_NAME.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

/**
 * Copies a project's legal files into the licenses folder and returns its section of the notices.
 * A project that ships no license file is named with the license it declares and its source, which
 * holds the license text; one that declares no license either is refused.
 */
function copyNoticeOf(project: CarriedProject, distDirectory: string): string {
  const legalFiles = legalFilesIn(project.legalDirectory);
  if (legalFiles.length === 0 && project.license === null) {
    throw new Error(
      `${project.name} ${project.version} declares no license and ships no license file in ` +
        project.legalDirectory,
    );
  }
  const copiedFolder = `${LICENSES_FOLDER}/${project.name}-${project.version}`;
  for (const file of legalFiles) {
    mkdirSync(path.join(distDirectory, copiedFolder), { recursive: true });
    copyFileSync(
      path.join(project.legalDirectory, file),
      path.join(distDirectory, copiedFolder, file),
    );
  }
  return [
    `## ${project.name} ${project.version}`,
    [
      `- License: ${project.license ?? "not declared"}`,
      `- Source: ${project.repository ?? "not declared"}`,
      ...(legalFiles.length === 0
        ? ["- License files: none in the published package; its source holds the license text"]
        : [
            "- License files:",
            ...legalFiles.map(
              (file) => `  - [\`${copiedFolder}/${file}\`](${copiedFolder}/${file})`,
            ),
          ]),
    ].join("\n"),
  ].join("\n\n");
}
