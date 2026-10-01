// Provider version gate: spawn-time executable resolution, the in-band version read, and the
// floor check, in one module so they cannot describe different installs.
//
// - The reported version is the version that spawned: the executable is resolved to an exact build
//   path (a launcher's `--version` names the launcher's current build, measurably not the one a
//   path-addressed spawn runs) and the version is read in-band from that process.
// - Each provider's descriptor reads its version out of the handshake reply
//   (`ProviderDriverDescriptor.readReportedVersion`) and declares its floor.
// - The transport is an injected seam with no default (each driver's `lifecycle.ts` owns process
//   talk); its implementer owns the deadline (`driver.timeout`).
import { constants as filesystemConstants } from "node:fs";
import { access, realpath as realpathFromFilesystem, stat } from "node:fs/promises";
import { delimiter as pathDelimiter, extname, isAbsolute, join, resolve } from "node:path";

import type { ProviderName } from "@ai-sidekicks/contracts";

import {
  DriverCliVersionUnparseableError,
  assertCliVersionMeetsFloor,
  parseCliVersionReport,
} from "./capability-refresh.js";
import type { SpawnedVersionBindingCarriers } from "./runtime-binding-store.js";
import type { DriverCliVersionReport } from "./provider-driver.js";
import { PROVIDER_DRIVER_DESCRIPTORS } from "./provider-driver-descriptors.js";

/**
 * Composes the handshake child's environment with the auto-update opt-out applied last, so an
 * inherited `DISABLE_AUTOUPDATER=0` cannot re-enable it. Sessions use `buildProviderSpawnEnv`.
 */
export function composeProviderChildEnvironment(
  driverName: ProviderName,
  baseEnvironment: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  return {
    ...baseEnvironment,
    ...PROVIDER_DRIVER_DESCRIPTORS[driverName].autoUpdateOptOutEnvironment,
  };
}

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
  /** Read once per resolution; supplies `PATH` and, on win32, `PATHEXT`. */
  readonly readEnvironment: () => Readonly<Record<string, string | undefined>>;
  /** `"win32"` selects the `PATHEXT` candidate expansion. */
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
    readEnvironment: partial.readEnvironment ?? (() => process.env),
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

/**
 * Resolves a configured command to the exact build path to spawn: a command with a separator is
 * anchored, a bare one is searched along `PATH`, and the winner is `realpath`ed. Throws
 * {@link ProviderExecutableUnresolvableError} when nothing resolves.
 */
export async function resolveProviderExecutable(
  driverName: ProviderName,
  requestedCommand: string,
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

  const environment = resolvedDependencies.readEnvironment();
  const isWindows = resolvedDependencies.platform === "win32";
  const pathExtensions = isWindows
    ? (environment["PATHEXT"] ?? "")
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
    : (environment["PATH"] ?? "")
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
  /** Auto-update suppression already applied ({@link composeProviderChildEnvironment}). */
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
  /** At or above the driver's floor by construction. */
  readonly report: DriverCliVersionReport;
}

/** Everything one spawned-version reading needs. */
export interface SpawnedProviderVersionReadRequest {
  readonly driverName: ProviderName;
  /** The configured provider command: a bare name, or a path. */
  readonly requestedCommand: string;
  /** The transport that spawns and performs the handshake; it has no default. */
  readonly handshake: ProviderVersionHandshake;
  /** Defaults to this process's environment; the opt-out is applied over it. */
  readonly baseEnvironment?: Readonly<Record<string, string | undefined>>;
  /** Defaults to {@link DEFAULT_PROVIDER_VERSION_CLIENT_NAME}. */
  readonly clientName?: string;
  readonly resolver?: Partial<ProviderExecutableResolverDependencies>;
}

/**
 * Resolves, spawns, reads in-band, and gates on the floor. The floor refusal comes before any
 * other use of the process, so no session, probe or billed turn touches an unsupported build.
 */
export async function readSpawnedProviderVersion(
  request: SpawnedProviderVersionReadRequest,
): Promise<SpawnedProviderVersionReading> {
  const { driverName, requestedCommand } = request;
  const clientName = request.clientName ?? DEFAULT_PROVIDER_VERSION_CLIENT_NAME;
  const resolved = await resolveProviderExecutable(
    driverName,
    requestedCommand,
    request.resolver ?? {},
  );
  const environment = composeProviderChildEnvironment(
    driverName,
    request.baseEnvironment ?? process.env,
  );

  const payload = await request.handshake({
    driverName,
    resolvedExecutablePath: resolved.resolvedExecutablePath,
    environment,
    clientName,
  });

  const reading = PROVIDER_DRIVER_DESCRIPTORS[driverName].readReportedVersion(payload, clientName);
  if ("unreadableReply" in reading) {
    throw new DriverCliVersionUnparseableError(driverName, reading.unreadableReply);
  }

  const report = parseCliVersionReport(driverName, reading.version);
  assertCliVersionMeetsFloor(driverName, report);
  return { driverName, resolvedExecutablePath: resolved.resolvedExecutablePath, report };
}

/** Projects the reading onto the two `runtime_bindings` carriers from one reading. */
export function toBindingVersionCarriers(
  reading: SpawnedProviderVersionReading,
): SpawnedVersionBindingCarriers {
  return {
    cliVersion: { raw: reading.report.raw, semver: reading.report.semver },
    resolvedExecutablePath: reading.resolvedExecutablePath,
  };
}
