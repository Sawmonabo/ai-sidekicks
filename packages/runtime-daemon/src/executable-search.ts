// The search a shell makes for the executable a command names, along a child's own environment
// rather than the daemon's: the provider spawns and the daemon's `git` both find theirs here.

import { constants as filesystemConstants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter as pathDelimiter, join, resolve } from "node:path";

import type { ProviderOperatingSystem } from "./provider/operating-system/contract.js";
import { readSpawnEnvValue, type SpawnEnvPair } from "./provider/spawn-env.js";

/** "Is this path a file this process may execute?" — never rejects. */
type ExecutableFileProbe = (candidate: string) => Promise<boolean>;

/** What a search takes from the operating system: how it names programs and compares variables. */
type ExecutableSearchOperatingSystem = Pick<
  ProviderOperatingSystem,
  "environmentNameMatch" | "isPathCommand" | "listExecutableCandidates"
>;

/** The filesystem and operating-system seams a search depends on. */
export interface ExecutableSearchDependencies {
  readonly isExecutableFile: ExecutableFileProbe;
  readonly operatingSystem: ExecutableSearchOperatingSystem;
  /** Anchor for a relative command. */
  readonly workingDirectory: string;
}

/** A search's seams: the operating system's, and the rest the real ones unless a test injects. */
export type ExecutableSearchOptions = Pick<ExecutableSearchDependencies, "operatingSystem"> &
  Partial<ExecutableSearchDependencies>;

// `stat` so a symlink probes as its target; `isFile()` because POSIX `X_OK` succeeds on
// directories. Never rejects.
const DEFAULT_IS_EXECUTABLE_FILE: ExecutableFileProbe = async (candidate) => {
  try {
    const stats = await stat(candidate);
    if (!stats.isFile()) {
      return false;
    }
    await access(candidate, filesystemConstants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * Each path where `command` names an executable file, in the order a shell tries them: a command
 * the system reads as a path is anchored at the working folder, a bare one is searched along
 * `environment`'s `PATH`, each through the file names the system tries. A relative `PATH` entry
 * yields a relative path.
 */
export async function* findExecutables(
  command: string,
  environment: readonly SpawnEnvPair[],
  dependencies: ExecutableSearchOptions,
): AsyncGenerator<string, void, undefined> {
  const { operatingSystem } = dependencies;
  const isExecutableFile = dependencies.isExecutableFile ?? DEFAULT_IS_EXECUTABLE_FILE;
  const readVariable = (name: string): string | undefined =>
    readSpawnEnvValue(environment, name, operatingSystem.environmentNameMatch);

  const searchRoots: string[] = operatingSystem.isPathCommand(command)
    ? [resolve(dependencies.workingDirectory ?? process.cwd(), command)]
    : (readVariable("PATH") ?? "")
        .split(pathDelimiter)
        .filter((entry) => entry !== "")
        .map((entry) => join(entry, command));

  for (const root of searchRoots) {
    for (const candidate of operatingSystem.listExecutableCandidates(root, readVariable)) {
      if (await isExecutableFile(candidate)) {
        yield candidate;
      }
    }
  }
}
