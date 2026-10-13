// Lays out a package's `dist/` from a Cargo build of a WebAssembly module: the module, and the
// license files and notices of every crate compiled into it, plus those of any npm package whose
// compiled code the build linked in. A crate's license files come from the folder Cargo unpacked it
// to, or, when it publishes none, from its repository at the commit it was published from. The
// crates come from Cargo's own JSON build messages, so a package's build target and profile are
// named only in its build command.

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const LICENSES_FOLDER = "THIRD_PARTY_LICENSES";

/** A project's legal files, by the names projects ship them under (`LICENSE-MIT`, `COPYING`, …). */
const LEGAL_FILE_NAME = /^(licen[cs]e|copying|notice)/i;

/** What one package's `dist/` is laid out from. */
export interface WasmDistSource {
  /** The package whose `dist/` is written. */
  readonly packageDirectory: string;
  /** The Cargo workspace the module was built in, where `cargo metadata` runs. */
  readonly workspaceDirectory: string;
  /** Cargo's output under `--message-format=json-render-diagnostics`: one JSON message a line. */
  readonly buildMessages: string;
  /** The library name of the `cdylib` crate the module is. */
  readonly crateLibraryName: string;
  /** Whether that crate was written outside this repository, so the notices name it too. */
  readonly isCrateThirdParty: boolean;
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

/** The `.cargo_vcs_info.json` Cargo writes into a published crate: where it was packaged from. */
interface CrateVcsInfo {
  readonly git: { readonly sha1: string };
  /** The crate's folder in its repository, `""` at the root. */
  readonly path_in_vcs: string;
}

/** One project whose compiled code the module carries, and the folder its legal files are in. */
interface CarriedProject {
  readonly name: string;
  readonly version: string;
  readonly license: string | null;
  readonly repository: string | null;
  readonly legalDirectory: string;
  /** The commit the legal files were fetched from, when the published project ships none. */
  readonly legalFilesCommit?: string;
}

/**
 * Empties the package's `dist/` and writes the module and `THIRD_PARTY_NOTICES.md` into it. Throws
 * when Cargo's build failed or wrote no module for the crate, or when no license file can be found
 * for a carried project, in what it publishes or in its repository.
 */
export function writeWasmDist(source: WasmDistSource): void {
  const messages = source.buildMessages
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
      artifact.target?.name === source.crateLibraryName && artifact.target.kind.includes("cdylib"),
  );
  const modulePath =
    source.builtModulePath ?? moduleArtifact?.filenames?.find((file) => file.endsWith(".wasm"));
  if (moduleArtifact?.package_id === undefined || modulePath === undefined) {
    throw new Error("Cargo's build wrote no WebAssembly module for the crate");
  }

  const metadata = JSON.parse(
    // Cargo describes every crate the workspace resolves, which passes Node's 1 MiB default.
    execFileSync("cargo", ["metadata", "--format-version", "1"], {
      cwd: source.workspaceDirectory,
      encoding: "utf8",
      maxBuffer: Infinity,
    }),
  ) as CargoMetadata;
  // License files fetched from a crate's repository are written here, and the folder is removed
  // once they are copied into `dist/`.
  const scratchDirectory = mkdtempSync(path.join(tmpdir(), "wasm-dist-"));
  try {
    const carried = [
      ...linkedCratesOf(
        moduleArtifact.package_id,
        source.isCrateThirdParty,
        artifacts,
        metadata,
        scratchDirectory,
      ),
      ...(source.linkedPackageDirectories ?? []).map(npmPackageOf),
    ];

    const distDirectory = path.join(source.packageDirectory, "dist");
    rmSync(distDirectory, { recursive: true, force: true });
    mkdirSync(distDirectory);
    copyFileSync(modulePath, path.join(distDirectory, source.moduleFile));
    writeFileSync(
      path.join(distDirectory, "THIRD_PARTY_NOTICES.md"),
      [
        "# Third-Party Notices",
        `\`${source.moduleFile}\` carries the compiled code of these projects, each under the ` +
          `license named here; their license files are in \`${LICENSES_FOLDER}/\`.`,
        ...carried.map((project) => copyNoticeOf(project, distDirectory)),
      ].join("\n\n") + "\n",
    );
  } finally {
    rmSync(scratchDirectory, { recursive: true, force: true });
  }
}

/**
 * The crates the module links, found from the crate by its normal dependencies (never a build or
 * test one) and kept only when this build compiled them, which drops a dependency for another
 * platform. A procedural macro runs in the compiler and links nothing, so neither it nor what it
 * depends on is kept. The crate itself is kept when it is third-party. Sorted by name and version.
 * A crate of the build's own workspace that ships no license file of its own is under the
 * workspace's; any other crate that ships none takes the files from its repository.
 */
function linkedCratesOf(
  crateId: string,
  isCrateThirdParty: boolean,
  artifacts: readonly BuildMessage[],
  metadata: CargoMetadata,
  scratchDirectory: string,
): CarriedProject[] {
  const compiledIds = new Set(artifacts.map((artifact) => artifact.package_id));
  const procMacroIds = new Set(
    artifacts
      .filter((artifact) => artifact.target?.kind.includes("proc-macro"))
      .map((artifact) => artifact.package_id),
  );
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const linkedIds = new Set<string>(isCrateThirdParty ? [crateId] : []);
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
  const repositories = new SourceRepositories(scratchDirectory);
  return metadata.packages
    .filter((crate) => linkedIds.has(crate.id))
    .sort((left, right) =>
      `${left.name} ${left.version}`.localeCompare(`${right.name} ${right.version}`),
    )
    .map((crate) => {
      const project = {
        name: crate.name,
        version: crate.version,
        license: crate.license,
        repository: crate.repository,
      };
      const crateDirectory = path.dirname(crate.manifest_path);
      if (legalFilesIn(crateDirectory).length > 0) {
        return { ...project, legalDirectory: crateDirectory };
      }
      if (metadata.workspace_members.includes(crate.id)) {
        return { ...project, legalDirectory: metadata.workspace_root };
      }
      return { ...project, ...repositories.fetchLegalFiles(crate, crateDirectory) };
    });
}

/**
 * The repositories of published crates, fetched into a scratch folder: of each commit, Git fetches
 * the folder trees and only the files read, and a commit several crates were published from is
 * fetched once.
 */
class SourceRepositories {
  readonly #scratchDirectory: string;
  readonly #fetchedDirectories = new Map<string, string>();

  constructor(scratchDirectory: string) {
    this.#scratchDirectory = scratchDirectory;
  }

  /**
   * Writes the legal files of a crate that publishes none, from its repository at the commit
   * it was published from: those in its folder there, else in the nearest folder above. Throws
   * when the crate names no repository or commit, or no such folder holds a legal file.
   */
  fetchLegalFiles(
    crate: CratePackage,
    crateDirectory: string,
  ): { legalDirectory: string; legalFilesCommit: string } {
    const vcsInfoPath = path.join(crateDirectory, ".cargo_vcs_info.json");
    if (crate.repository === null || !existsSync(vcsInfoPath)) {
      throw new Error(
        `${crate.name} ${crate.version} ships no license file in ${crateDirectory} and names no ` +
          "repository and commit to take one from",
      );
    }
    const vcsInfo = JSON.parse(readFileSync(vcsInfoPath, "utf8")) as CrateVcsInfo;
    const commit = vcsInfo.git.sha1;
    const gitDirectory = this.#fetch(crate.repository, commit);
    const folders = vcsInfo.path_in_vcs === "" ? [] : vcsInfo.path_in_vcs.split("/");
    for (let depth = folders.length; depth >= 0; depth -= 1) {
      const folder = folders.slice(0, depth).join("/");
      const legalFiles = execFileSync(
        "git",
        ["--git-dir", gitDirectory, "ls-tree", commit, ...(folder === "" ? [] : [`${folder}/`])],
        { encoding: "utf8" },
      )
        .split("\n")
        .map((line) => /^\d+ blob (\w+)\t(.+)$/.exec(line))
        .filter((match) => match !== null)
        .map(([, objectId = "", filePath = ""]) => ({
          objectId,
          name: path.posix.basename(filePath),
        }))
        .filter((file) => LEGAL_FILE_NAME.test(file.name));
      if (legalFiles.length > 0) {
        const legalDirectory = path.join(this.#scratchDirectory, `${crate.name}-${crate.version}`);
        mkdirSync(legalDirectory);
        for (const file of legalFiles) {
          writeFileSync(
            path.join(legalDirectory, file.name),
            execFileSync("git", ["--git-dir", gitDirectory, "cat-file", "blob", file.objectId]),
          );
        }
        return { legalDirectory, legalFilesCommit: commit };
      }
    }
    throw new Error(
      `${crate.name} ${crate.version} ships no license file, and ${crate.repository} holds none at ` +
        `commit ${commit} in ${vcsInfo.path_in_vcs === "" ? "its root" : vcsInfo.path_in_vcs} ` +
        "or a folder above it",
    );
  }

  /** The bare repository holding `commit`'s trees, fetched on first use. */
  #fetch(repository: string, commit: string): string {
    const key = `${repository} ${commit}`;
    const fetched = this.#fetchedDirectories.get(key);
    if (fetched !== undefined) {
      return fetched;
    }
    const gitDirectory = path.join(
      this.#scratchDirectory,
      `repository-${String(this.#fetchedDirectories.size)}`,
    );
    execFileSync("git", ["init", "--quiet", "--bare", gitDirectory]);
    execFileSync("git", ["--git-dir", gitDirectory, "remote", "add", "origin", repository]);
    // A named remote with a filter is a promisor, so Git fetches a file the first time it is read.
    execFileSync(
      "git",
      [
        "--git-dir",
        gitDirectory,
        "fetch",
        "--quiet",
        "--depth",
        "1",
        "--filter=blob:none",
        "origin",
        commit,
      ],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
    this.#fetchedDirectories.set(key, gitDirectory);
    return gitDirectory;
  }
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
 * Throws when its folder holds no legal file.
 */
function copyNoticeOf(project: CarriedProject, distDirectory: string): string {
  const legalFiles = legalFilesIn(project.legalDirectory);
  if (legalFiles.length === 0) {
    throw new Error(
      `${project.name} ${project.version} ships no license file in ${project.legalDirectory}`,
    );
  }
  const copiedFolder = `${LICENSES_FOLDER}/${project.name}-${project.version}`;
  mkdirSync(path.join(distDirectory, copiedFolder), { recursive: true });
  for (const file of legalFiles) {
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
      project.legalFilesCommit === undefined
        ? "- License files:"
        : `- License files, from its source at commit ${project.legalFilesCommit}, as the ` +
          "published crate ships none:",
      ...legalFiles.map((file) => `  - [\`${copiedFolder}/${file}\`](${copiedFolder}/${file})`),
    ].join("\n"),
  ].join("\n\n");
}
