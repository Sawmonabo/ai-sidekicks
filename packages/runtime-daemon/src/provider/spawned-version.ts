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
import { realpath as realpathFromFilesystem } from "node:fs/promises";
import { isAbsolute } from "node:path";

import type { ProviderName } from "@ai-sidekicks/contracts/provider/name";

import { findExecutables, type ExecutableSearchDependencies } from "../executable/search.js";
import { parseCliVersionReport } from "./capability/refresh.js";
import type { ProviderCommandSearch } from "./command-search.js";
import type { SpawnedVersionBindingCarriers } from "./runtime-binding-store.js";
import type { DriverCliVersionReport } from "./driver/contract.js";
import { PROVIDER_DRIVER_DESCRIPTORS } from "./driver/descriptor.js";
import { assertValidCliVersionReport } from "./output-validation.js";
import { buildProviderSpawnEnv, type SpawnEnvNameMatch, type SpawnEnvPair } from "./spawn-env.js";

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

/** The search's seams, and the `realpath` that turns a launcher into the exact build path. */
export interface ProviderExecutableResolverDependencies extends ExecutableSearchDependencies {
  readonly realpath: ExecutableRealpathResolver;
  /** Where a bare command is looked for once the `PATH` holds none. */
  readonly commandSearch: Pick<ProviderCommandSearch, "find">;
}

/** The one executable a spawn and its binding row both name; only the build describes it. */
export interface ResolvedProviderExecutable {
  /** The command as configured — a bare name, or a relative/absolute path. */
  readonly requestedCommand: string;
  /** Absolute and symlink-dereferenced; this is what gets spawned and stored. */
  readonly resolvedExecutablePath: string;
}

/**
 * Resolves a configured command to the exact build path to spawn: a command with a separator is
 * anchored, a bare one is searched along the spawn environment's `PATH` (never the daemon's own)
 * and then through the command search, and the winner is `realpath`ed. Throws
 * {@link ProviderExecutableUnresolvableError} when nothing resolves.
 */
export async function resolveProviderExecutable(
  driverName: ProviderName,
  requestedCommand: string,
  spawnEnvironment: readonly SpawnEnvPair[],
  dependencies: Partial<ProviderExecutableResolverDependencies> = {},
): Promise<ResolvedProviderExecutable> {
  if (requestedCommand.trim() === "") {
    throw new ProviderExecutableUnresolvableError(
      driverName,
      requestedCommand,
      "the configured provider command is empty",
    );
  }
  // Resolves like `fs.realpath.native()`: a launcher symlink becomes the exact build path.
  const realpath = dependencies.realpath ?? realpathFromFilesystem;
  for await (const candidate of findExecutables(requestedCommand, spawnEnvironment, dependencies)) {
    let resolvedExecutablePath: string;
    try {
      resolvedExecutablePath = await realpath(candidate);
    } catch {
      // Vanished between probe and dereference: try the next, never the unresolved launcher path.
      continue;
    }
    return checkedResolution(driverName, requestedCommand, resolvedExecutablePath);
  }
  const found = await dependencies.commandSearch?.find(requestedCommand, spawnEnvironment);
  if (found !== undefined) {
    return checkedResolution(driverName, requestedCommand, found);
  }
  throw new ProviderExecutableUnresolvableError(
    driverName,
    requestedCommand,
    "the configured provider command names no executable file",
  );
}

// A resolution that names an absolute build path; a relative one cannot be spawned or recorded.
function checkedResolution(
  driverName: ProviderName,
  requestedCommand: string,
  resolvedExecutablePath: string,
): ResolvedProviderExecutable {
  if (!isAbsolute(resolvedExecutablePath)) {
    throw new ProviderExecutableUnresolvableError(
      driverName,
      requestedCommand,
      "the resolved provider executable path is not absolute",
    );
  }
  return { requestedCommand, resolvedExecutablePath };
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
   * The captured base the provider's session spawn builds on, never the daemon's own `process.env`;
   * the opt-out is applied over it, and a bare command is searched along its `PATH`.
   */
  readonly baseEnv: readonly SpawnEnvPair[];
  /** How this system compares environment variable names. */
  readonly environmentNameMatch: SpawnEnvNameMatch;
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
    hostEnvNameMatch: request.environmentNameMatch,
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
