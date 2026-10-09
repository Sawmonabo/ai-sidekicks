// The search a shell makes for the executable a command names, along a child's own environment
// rather than the daemon's: the provider spawns and the daemon's `git` both find theirs here.

import { constants as filesystemConstants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter as pathDelimiter, extname, isAbsolute, join, resolve } from "node:path";

import { selectProviderOperatingSystem } from "../provider/operating-system/selection.js";
import type { SpawnEnvPair } from "../provider/spawn-env.js";

/** "Is this path a file this process may execute?" — never rejects. */
type ExecutableFileProbe = (candidate: string) => Promise<boolean>;

/** The filesystem and platform seams a search depends on; injected so win32 is testable. */
export interface ExecutableSearchDependencies {
  readonly isExecutableFile: ExecutableFileProbe;
  /** `"win32"` selects the `PATHEXT` candidate expansion and case-insensitive name lookup. */
  readonly platform: NodeJS.Platform;
  /** Anchor for a relative command. */
  readonly workingDirectory: string;
}

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

// The `PATHEXT` default cmd.exe uses, consulted only when the environment has none.
const DEFAULT_WINDOWS_PATH_EXTENSIONS: readonly string[] = [".COM", ".EXE", ".BAT", ".CMD"];

function windowsCandidateNames(command: string, pathExtensions: readonly string[]): string[] {
  const withExtensions = pathExtensions.map((extension) => `${command}${extension}`);
  // Like the shell: with an extension, as written first; without, through `PATHEXT`, then bare.
  return extname(command) === "" ? [...withExtensions, command] : [command, ...withExtensions];
}

// The value of `name` in a spawn environment, matched the way the host matches names.
function readSpawnEnvValue(
  environment: readonly SpawnEnvPair[],
  name: string,
  platform: NodeJS.Platform,
): string | undefined {
  const caseInsensitive =
    selectProviderOperatingSystem(platform).environmentNameMatch === "case-insensitive";
  const entry = environment.find(([entryName]) =>
    caseInsensitive ? entryName.toUpperCase() === name : entryName === name,
  );
  return entry?.[1];
}

/**
 * Each path where `command` names an executable file, in the order a shell tries them: a command
 * with a separator is anchored at the working folder, a bare one is searched along `environment`'s
 * `PATH`, through `PATHEXT` on Windows. A relative `PATH` entry yields a relative path.
 */
export async function* findExecutables(
  command: string,
  environment: readonly SpawnEnvPair[],
  dependencies: Partial<ExecutableSearchDependencies> = {},
): AsyncGenerator<string, void, undefined> {
  const platform = dependencies.platform ?? process.platform;
  const isExecutableFile = dependencies.isExecutableFile ?? DEFAULT_IS_EXECUTABLE_FILE;
  const isWindows = platform === "win32";
  const pathExtensions = isWindows
    ? (readSpawnEnvValue(environment, "PATHEXT", platform) ?? "")
        .split(";")
        .map((extension) => extension.trim())
        .filter((extension) => extension !== "")
    : [];
  const effectiveExtensions =
    isWindows && pathExtensions.length === 0 ? DEFAULT_WINDOWS_PATH_EXTENSIONS : pathExtensions;

  const anchored =
    isAbsolute(command) || command.includes("/") || (isWindows && command.includes("\\"));
  const searchRoots: string[] = anchored
    ? [resolve(dependencies.workingDirectory ?? process.cwd(), command)]
    : (readSpawnEnvValue(environment, "PATH", platform) ?? "")
        .split(pathDelimiter)
        .filter((entry) => entry !== "")
        .map((entry) => join(entry, command));

  // win32: `X_OK` acts like `F_OK`, so the `PATHEXT` expansion is what marks an executable.
  const candidates: string[] = isWindows
    ? searchRoots.flatMap((root) => windowsCandidateNames(root, effectiveExtensions))
    : searchRoots;
  for (const candidate of candidates) {
    if (await isExecutableFile(candidate)) {
      yield candidate;
    }
  }
}
