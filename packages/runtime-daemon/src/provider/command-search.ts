// Finds a provider's command in the folders its installers, npm and the Node version and package
// managers put it, for a spawn whose login shell's search path holds none. Where more than one
// build is found, the newest runs: each build's `--version` is read once, under a deadline, and
// kept for its path. A build runs with the folder it was found in first on its search path, where
// a Node manager keeps the `node` its script's `#!/usr/bin/env node` names.

import { execFile } from "node:child_process";
import { readdir, realpath as realpathFromFilesystem } from "node:fs/promises";
import { delimiter as pathDelimiter, dirname, join } from "node:path";
import { promisify } from "node:util";

import semver from "semver";

import {
  findExecutables,
  readSpawnEnvValue,
  type ExecutableSearchDependencies,
} from "../executable/search.js";
import { describeRejection } from "../rejection.js";
import { parseCliVersionReport } from "./capability/refresh.js";
import type {
  ProviderCommandFolder,
  ProviderOperatingSystem,
  ProviderProgramStart,
} from "./operating-system/contract.js";
import { placeFolderFirstOnSearchPath, type SpawnEnvPair } from "./spawn-env.js";
import { startResolvedBuild } from "./spawned-version.js";

/** How long one build may take to print its version before it ranks below every build that did. */
const VERSION_READ_DEADLINE_MS = 5_000;

const runProgram = promisify(execFile);

/** The filesystem and process seams a search depends on. */
export interface ProviderCommandSearchDependencies extends ExecutableSearchDependencies {
  /** `fs.promises.realpath`; rejects for a path that went away. */
  readonly realpath: (candidate: string) => Promise<string>;
  /** The names in a folder; rejects for a folder that cannot be read. */
  readonly listFolder: (folder: string) => Promise<readonly string[]>;
  /** What the build printed for `--version`; rejects for one that fails or misses the deadline. */
  readonly readVersionOutput: (
    start: ProviderProgramStart,
    environment: Readonly<Record<string, string>>,
  ) => Promise<string>;
}

/** One build the search found: its resolved path and the folder its command was found in. */
export interface ProviderCommandSearchHit {
  readonly build: string;
  /** Put first on the build's search path, so a Node script finds the Node installed beside it. */
  readonly folder: string;
}

/** What one search is built from. */
export interface ProviderCommandSearchOptions {
  readonly operatingSystem: Pick<
    ProviderOperatingSystem,
    "environmentNameMatch" | "providerCommandFolders" | "startProviderBuild"
  >;
  /** The person's home folder, which most of the folders sit under. */
  readonly homeDirectory: string;
  readonly writeServiceLog: (line: string) => void;
  readonly dependencies?: Partial<ProviderCommandSearchDependencies>;
}

const DEFAULT_DEPENDENCIES: Omit<
  ProviderCommandSearchDependencies,
  keyof ExecutableSearchDependencies
> = {
  realpath: realpathFromFilesystem,
  listFolder: async (folder) => await readdir(folder),
  readVersionOutput: async (start, environment) =>
    (
      await runProgram(start.program, [...start.leadingArguments, "--version"], {
        env: environment,
        timeout: VERSION_READ_DEADLINE_MS,
      })
    ).stdout,
};

/**
 * The search a provider's default command falls back to after the login shell's `PATH`. Keeps each
 * build's version for the daemon's life, keyed by its resolved path.
 */
export class ProviderCommandSearch {
  readonly #options: ProviderCommandSearchOptions;
  readonly #dependencies: Omit<
    ProviderCommandSearchDependencies,
    keyof ExecutableSearchDependencies
  > &
    Partial<ExecutableSearchDependencies>;
  // `null` for a build that printed no version it could be ranked by.
  readonly #versions = new Map<string, Promise<semver.SemVer | null>>();

  constructor(options: ProviderCommandSearchOptions) {
    this.#options = options;
    this.#dependencies = { ...DEFAULT_DEPENDENCIES, ...options.dependencies };
  }

  /**
   * The newest build `command` names in the folders, or `undefined` where none holds it. A build
   * whose version cannot be read ranks below every build whose can; among equals the earlier
   * folder wins.
   */
  async find(
    command: string,
    spawnEnvironment: readonly SpawnEnvPair[],
  ): Promise<ProviderCommandSearchHit | undefined> {
    const folders = await this.#listFolders(spawnEnvironment);
    // The folders as a `PATH` of their own, so they are searched the way the shell's is.
    const environment: readonly SpawnEnvPair[] = [
      ["PATH", folders.join(pathDelimiter)],
      ...spawnEnvironment,
    ];
    const builds: ProviderCommandSearchHit[] = [];
    for await (const candidate of findExecutables(command, environment, this.#dependencies)) {
      let build: string;
      try {
        build = await this.#dependencies.realpath(candidate);
      } catch {
        // Gone between the probe and the dereference: the next candidate is tried.
        continue;
      }
      // The folder the command sits in, never the build's own: a Node manager links its command
      // to a script deep in its packages, beside no `node`.
      if (!builds.some((found) => found.build === build)) {
        builds.push({ build, folder: dirname(candidate) });
      }
    }
    if (builds.length <= 1) {
      return builds[0];
    }
    const versions = await Promise.all(
      builds.map(async (hit) => await this.#readVersion(hit, spawnEnvironment)),
    );
    let newest = 0;
    versions.forEach((version, index) => {
      const best = versions[newest] ?? null;
      if (version !== null && (best === null || semver.gt(version, best))) {
        newest = index;
      }
    });
    return builds[newest];
  }

  async #listFolders(spawnEnvironment: readonly SpawnEnvPair[]): Promise<string[]> {
    const { environmentNameMatch, providerCommandFolders } = this.#options.operatingSystem;
    const entries = providerCommandFolders({
      homeDirectory: this.#options.homeDirectory,
      readVariable: (name) => {
        const value = readSpawnEnvValue(spawnEnvironment, name, environmentNameMatch);
        return value === "" ? undefined : value;
      },
    });
    const folders: string[] = [];
    for (const entry of entries) {
      folders.push(...(await this.#expandFolder(entry)));
    }
    return folders;
  }

  async #expandFolder(entry: ProviderCommandFolder): Promise<readonly string[]> {
    if (typeof entry === "string") {
      return [entry];
    }
    let names: readonly string[];
    try {
      names = await this.#dependencies.listFolder(entry.parent);
    } catch (error) {
      // A manager that is not installed has no folder, which is no reason to log.
      if (!isMissingFolderError(error)) {
        this.#options.writeServiceLog(
          `The folder ${entry.parent} could not be listed (${describeRejection(error)}), so ` +
            "no provider command is looked for in it.",
        );
      }
      return [];
    }
    return [...names].sort().map((name) => join(entry.parent, name, entry.child));
  }

  #readVersion(
    { build, folder }: ProviderCommandSearchHit,
    spawnEnvironment: readonly SpawnEnvPair[],
  ): Promise<semver.SemVer | null> {
    const known = this.#versions.get(build);
    if (known !== undefined) {
      return known;
    }
    const reading = (async (): Promise<semver.SemVer | null> => {
      try {
        const { operatingSystem } = this.#options;
        const environment = placeFolderFirstOnSearchPath(
          spawnEnvironment,
          folder,
          operatingSystem.environmentNameMatch,
        );
        const start = await startResolvedBuild(build, environment, {
          ...this.#dependencies,
          operatingSystem,
        });
        const output = await this.#dependencies.readVersionOutput(
          start,
          Object.fromEntries(environment),
        );
        const parsed = parseCliVersionReport(output).parsedVersion;
        if (parsed !== undefined) {
          return new semver.SemVer(parsed);
        }
        this.#options.writeServiceLog(
          `The provider build ${build} printed no version it could be ranked by, so it runs only ` +
            "where no build that did is found.",
        );
      } catch (error) {
        this.#options.writeServiceLog(
          `The provider build ${build} did not print its version (${describeRejection(error)}), ` +
            "so it runs only where no build that did is found.",
        );
      }
      return null;
    })();
    this.#versions.set(build, reading);
    return reading;
  }
}

function isMissingFolderError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}
