// Provider version read: spawn-time executable resolution and the in-band version read, in one
// module so they cannot describe different installs. Any version runs; the reading is recorded.
//
// - The reported version is the version that spawned: the executable is resolved to an exact build
//   path (a launcher's `--version` names the launcher's current build, measurably not the one a
//   path-addressed spawn runs) and the version is read in-band from that process.
// - Each provider's descriptor reads its version out of the handshake reply
//   (`ProviderDriverDescriptor.readReportedVersion`).
// - The transport is an injected seam with no default (each driver's `lifecycle.ts` owns process
//   talk); its implementer owns the deadline (`driver.timeout`).
import { constants as filesystemConstants } from "node:fs";
import { access, realpath as realpathFromFilesystem, stat } from "node:fs/promises";
import { delimiter as pathDelimiter, extname, isAbsolute, join, resolve } from "node:path";

import type { ProviderName } from "@ai-sidekicks/contracts/provider/account/account";

import { parseCliVersionReport } from "./capability-refresh.js";
import type { SpawnedVersionBindingCarriers } from "./runtime-binding-store.js";
import type { DriverCliVersionReport } from "./provider-driver.js";
import { PROVIDER_DRIVER_DESCRIPTORS } from "./provider-driver-descriptors.js";
import { assertValidCliVersionReport } from "./provider-output-validation.js";
import {
  buildProviderSpawnEnv,
  hostEnvNameMatchForPlatform,
  type SpawnEnvPair,
} from "./spawn-env.js";

/**
 * Thrown when the configured provider command names no runnable executable, or one whose real
 * path cannot be read. Code `driver.unavailable`; `requestedCommand` is the person's configuration.
 */
export class ProviderExecutableUnresolvableError extends Error {
  readonly code = "driver.unavailable" as const;
  readonly fields: {
    readonly driverName: ProviderName;
    readonly requestedCommand: string;
    readonly reason: string;
  };

  constructor(driverName: ProviderName, requestedCommand: string, reason: string) {
    super("Provider driver is currently unavailable");
    this.name = "ProviderExecutableUnresolvableError";
    this.fields = { driverName, requestedCommand, reason };
  }
}

/** `fs.promises.realpath` seam. Rejects with a Node `ErrnoException`. */
type ExecutableRealpathResolver = (candidate: string) => Promise<string>;

/** "Is this path a file this process may execute?" — never rejects. */
type ExecutableFileProbe = (candidate: string) => Promise<boolean>;

/** The filesystem and platform seams resolution depends on; injected so win32 is testable. */
export interface ProviderExecutableResolverDependencies {
  readonly realpath: ExecutableRealpathResolver;
  readonly isExecutableFile: ExecutableFileProbe;
  /** `"win32"` selects the `PATHEXT` candidate expansion and case-insensitive name lookup. */
  readonly platform: NodeJS.Platform;
  /** Anchor for a relative configured command. */
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

// Resolves like `fs.realpath.native()`: a launcher symlink becomes the exact build path.
const DEFAULT_EXECUTABLE_REALPATH: ExecutableRealpathResolver = realpathFromFilesystem;

function resolveExecutableResolverDependencies(
  partial: Partial<ProviderExecutableResolverDependencies> = {},
): ProviderExecutableResolverDependencies {
  return {
    realpath: partial.realpath ?? DEFAULT_EXECUTABLE_REALPATH,
    isExecutableFile: partial.isExecutableFile ?? DEFAULT_IS_EXECUTABLE_FILE,
    platform: partial.platform ?? process.platform,
    workingDirectory: partial.workingDirectory ?? process.cwd(),
  };
}

/** The one executable a spawn and its binding row both name; only the build describes it. */
export interface ResolvedProviderExecutable {
  /** The command as configured — a bare name, or a relative/absolute path. */
  readonly requestedCommand: string;
  /** Absolute and symlink-dereferenced; this is what gets spawned and stored. */
  readonly resolvedExecutablePath: string;
}

// The `PATHEXT` default cmd.exe uses, consulted only when the environment has none.
const DEFAULT_WINDOWS_PATH_EXTENSIONS: readonly string[] = [".COM", ".EXE", ".BAT", ".CMD"];

function windowsCandidateNames(command: string, pathExtensions: readonly string[]): string[] {
  const withExtensions = pathExtensions.map((extension) => `${command}${extension}`);
  // Like the shell: with an extension, as written first; without, through `PATHEXT`, then bare.
  return extname(command) === "" ? [...withExtensions, command] : [command, ...withExtensions];
}

// The value of `name` in a spawn environment, matched the way the host matches names.
function readSpawnEnvValue(
  spawnEnvironment: readonly SpawnEnvPair[],
  name: string,
  platform: NodeJS.Platform,
): string | undefined {
  const caseInsensitive = hostEnvNameMatchForPlatform(platform) === "case-insensitive";
  const entry = spawnEnvironment.find(([entryName]) =>
    caseInsensitive ? entryName.toUpperCase() === name : entryName === name,
  );
  return entry?.[1];
}

/**
 * Resolves a configured command to the exact build path to spawn: a command with a separator is
 * anchored, a bare one is searched along the spawn environment's `PATH` (never the daemon's own),
 * and the winner is `realpath`ed. Throws {@link ProviderExecutableUnresolvableError} when nothing
 * resolves.
 */
export async function resolveProviderExecutable(
  driverName: ProviderName,
  requestedCommand: string,
  spawnEnvironment: readonly SpawnEnvPair[],
  dependencies: Partial<ProviderExecutableResolverDependencies> = {},
): Promise<ResolvedProviderExecutable> {
  const resolvedDependencies = resolveExecutableResolverDependencies(dependencies);
  if (requestedCommand.trim() === "") {
    throw new ProviderExecutableUnresolvableError(
      driverName,
      requestedCommand,
      "the configured provider command is empty",
    );
  }

  const platform = resolvedDependencies.platform;
  const isWindows = platform === "win32";
  const pathExtensions = isWindows
    ? (readSpawnEnvValue(spawnEnvironment, "PATHEXT", platform) ?? "")
        .split(";")
        .map((extension) => extension.trim())
        .filter((extension) => extension !== "")
    : [];
  const effectiveExtensions =
    isWindows && pathExtensions.length === 0 ? DEFAULT_WINDOWS_PATH_EXTENSIONS : pathExtensions;

  const anchored =
    isAbsolute(requestedCommand) ||
    requestedCommand.includes("/") ||
    (isWindows && requestedCommand.includes("\\"));
  const searchRoots: string[] = anchored
    ? [resolve(resolvedDependencies.workingDirectory, requestedCommand)]
    : (readSpawnEnvValue(spawnEnvironment, "PATH", platform) ?? "")
        .split(pathDelimiter)
        .filter((entry) => entry !== "")
        .map((entry) => join(entry, requestedCommand));

  // win32: `X_OK` acts like `F_OK`, so the `PATHEXT` expansion is what marks an executable.
  const candidates: string[] = isWindows
    ? searchRoots.flatMap((root) => windowsCandidateNames(root, effectiveExtensions))
    : searchRoots;

  for (const candidate of candidates) {
    if (!(await resolvedDependencies.isExecutableFile(candidate))) {
      continue;
    }
    let resolvedExecutablePath: string;
    try {
      resolvedExecutablePath = await resolvedDependencies.realpath(candidate);
    } catch {
      // Vanished between probe and dereference: try the next, never the unresolved launcher path.
      continue;
    }
    if (!isAbsolute(resolvedExecutablePath)) {
      throw new ProviderExecutableUnresolvableError(
        driverName,
        requestedCommand,
        "the resolved provider executable path is not absolute",
      );
    }
    return { requestedCommand, resolvedExecutablePath };
  }

  throw new ProviderExecutableUnresolvableError(
    driverName,
    requestedCommand,
    anchored
      ? "the configured provider executable path is not an executable file"
      : "no executable named by the configured provider command was found on PATH",
  );
}

/**
 * The client name sent at the version handshake; no `/` or whitespace, since a provider that
 * echoes it beside its own version is read by the text after it.
 */
export const DEFAULT_PROVIDER_VERSION_CLIENT_NAME: string = "ai-sidekicks-daemon";

/** What the transport needs in order to run one zero-turn version handshake. */
export interface ProviderVersionHandshakeRequest {
  readonly driverName: ProviderName;
  /** Absolute, symlink-dereferenced; spawn this, never the configured name. */
  readonly resolvedExecutablePath: string;
  /** Auto-update suppression already applied ({@link buildProviderSpawnEnv}). */
  readonly environment: Readonly<Record<string, string | undefined>>;
  /** The client name to send; one value for the transport and the version reader to compare. */
  readonly clientName: string;
}

// Runs one zero-turn in-band version handshake and returns the reply unadjudicated (`unknown`:
// provider output). The implementer owns the process lifetime and deadline and must spawn
// `request.resolvedExecutablePath` with `request.environment`.
type ProviderVersionHandshake = (request: ProviderVersionHandshakeRequest) => Promise<unknown>;

/**
 * One spawned-build reading: the resolved executable and what the process started at that path
 * reported. Never cached across spawns, so a refresh detects a mid-lifetime replacement.
 */
export interface SpawnedProviderVersionReading {
  readonly driverName: ProviderName;
  /** Absolute, symlink-dereferenced: the build that answered the handshake. */
  readonly resolvedExecutablePath: string;
  readonly report: DriverCliVersionReport;
}

/** Everything one spawned-version reading needs. */
export interface SpawnedProviderVersionReadRequest {
  readonly driverName: ProviderName;
  /** The configured provider command: a bare name, or a path. */
  readonly requestedCommand: string;
  /** The transport that spawns and performs the handshake; it has no default. */
  readonly handshake: ProviderVersionHandshake;
  /**
   * The curated base the provider's session spawn uses, never the daemon's own `process.env`;
   * the opt-out is applied over it, and a bare command is searched along its `PATH`.
   */
  readonly baseEnv: readonly SpawnEnvPair[];
  /** Defaults to {@link DEFAULT_PROVIDER_VERSION_CLIENT_NAME}. */
  readonly clientName?: string;
  readonly resolver?: Partial<ProviderExecutableResolverDependencies>;
}

/** Resolves the configured command to one build, spawns it and reads its version in-band. */
export async function readSpawnedProviderVersion(
  request: SpawnedProviderVersionReadRequest,
): Promise<SpawnedProviderVersionReading> {
  const { driverName, requestedCommand } = request;
  const clientName = request.clientName ?? DEFAULT_PROVIDER_VERSION_CLIENT_NAME;
  // The same builder as a session spawn, so the opt-out wins under the host's name matching.
  const spawnEnvironment = buildProviderSpawnEnv({
    driverName,
    baseEnv: request.baseEnv,
    hostEnvNameMatch: hostEnvNameMatchForPlatform(request.resolver?.platform ?? process.platform),
  });
  // Searched along the child's own environment, so the version read and the spawn find one build.
  const resolved = await resolveProviderExecutable(
    driverName,
    requestedCommand,
    spawnEnvironment,
    request.resolver ?? {},
  );
  const environment = Object.fromEntries(spawnEnvironment);

  const payload = await request.handshake({
    driverName,
    resolvedExecutablePath: resolved.resolvedExecutablePath,
    environment,
    clientName,
  });

  const reading = PROVIDER_DRIVER_DESCRIPTORS[driverName].readReportedVersion(payload, clientName);
  // A reply that carried no version text keeps that text as the printed version, unparsed: its
  // version-shaped tokens may name something else, such as the caller's own client version.
  const report =
    "unreadableReply" in reading
      ? { rawVersion: reading.unreadableReply }
      : parseCliVersionReport(reading.version);
  // The one place the version enters the daemon, so the storage bounds are checked here too; an
  // empty reply has no printed version and is refused as invalid provider output.
  assertValidCliVersionReport(driverName, report);
  return { driverName, resolvedExecutablePath: resolved.resolvedExecutablePath, report };
}

/** Projects the reading onto the two `runtime_bindings` carriers from one reading. */
export function toBindingVersionCarriers(
  reading: SpawnedProviderVersionReading,
): SpawnedVersionBindingCarriers {
  return {
    cliVersion: { ...reading.report },
    resolvedExecutablePath: reading.resolvedExecutablePath,
  };
}
