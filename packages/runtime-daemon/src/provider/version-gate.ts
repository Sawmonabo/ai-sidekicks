// Provider version gate — spawn-time executable resolution, the in-band version
// read, and the ratified floor gate (Plan-005 Phase 3, T3.23).
//
// `Spec-005 §Required Behavior` (2026-08-26): "The version a driver reports is
// the version that spawned." The driver RESOLVES the executable, SPAWNS it, and
// READS the version in-band from the running process — never from a launcher
// symlink and never from a `--version` shell-out. One reading then serves both
// consumers: it is what the floor comparison compares, and it is what the run's
// `runtime_bindings` row records (`cli_version_raw` / `cli_version_semver`, with
// the resolved executable path on the daemon-owned `spawn_config` carrier). That
// is why resolution, the read, and the compare live in ONE module: split across
// three, they could describe three different installs.
//
// -- Why a launcher is not an acceptable version source ------------------------
//
// At the measured pin `claude --version` names the LAUNCHER's current build,
// which is measurably not the build a path-addressed spawn runs
// (`docs/reference/provider-wire/claude.md`). Resolution therefore dereferences
// the launcher to an exact build path, and the version comes from the process
// started at THAT path — so a drifted launcher changes neither the reading nor
// the recorded row.
//
// -- The two in-band channels are not symmetric --------------------------------
//
//   * Claude — the `get_binary_version` control request answers `{ version,
//     buildTime }` for the build that is running. The `version` member is a
//     version string, so it is ADOPTED as-is.
//   * Codex — the `initialize` result answers a COMPOSITE `userAgent` that also
//     carries the CALLER's own name and version
//     (`<clientName>/<codexVersion> (<os>; <arch>) <terminal> (<clientName>;
//     <clientVersion>)` at the pin), so it is EXTRACTED under a stated rule and
//     never adopted. There is no structured alternative to fall back to:
//     `server/diagnostics` refuses without the `experimentalApi` capability and,
//     granted it, returns process gauges carrying no version at all (Verified
//     2026-08-26 at `0.149.1`), and negotiating that capability is exactly what
//     V1's posture realization is built not to need.
//
// -- What this module deliberately does NOT own --------------------------------
//
//   * **The transport.** {@link ProviderVersionHandshake} is a REQUIRED injected
//     seam with no default. Each driver's `lifecycle.ts` (T3.1 / T3.6) already
//     owns how this daemon talks to a provider process; forking a second stdio
//     JSON-RPC transport here would be a second, divergable answer to that one
//     question. This module composes the spawn — the resolved path, the client
//     name, and the auto-update-suppressed environment, all decided in ONE place
//     — and adjudicates the reply; the seam's implementer executes it and owns
//     its DEADLINE (`driver.timeout` is already registered, so no timeout is
//     grown here).
//   * **The child-environment builder.** The provider-neutral builder every
//     driver spawn flows through is `spawn-env.ts` (T3.25). Until it lands, the
//     opt-out table below is the single source of truth for the suppression
//     `Spec-005 §Required Behavior` mandates, and T3.25 CONSUMES it rather than
//     restating it.
//   * **The floor VALUES and the comparison.** Both stay in
//     `./capability-refresh.js` (T3.12 / P0-2). This task re-points the SOURCE of
//     the compared version, never the comparison — which is the whole of the
//     version gate: at or above the floor a build attaches, above the measured
//     pin included.
//
// Spec coverage: `Spec-005 §Required Behavior` (the ratified V1 floors Claude
// Code `2.1.234` / codex-cli `0.141.0`; the floor-is-this-spec's /
// pin-is-the-reference-family's split; the version a driver reports is the
// version that spawned; provider auto-update disabled in every driver-spawned
// child).
//
// Refs: Plan-005 §Phase 3 / T3.23, invariant I-005-10,
// `docs/architecture/contracts/error-contracts.md §Driver`,
// `docs/reference/provider-wire/claude.md`,
// `docs/reference/provider-wire/codex.md`.

import { constants as filesystemConstants } from "node:fs";
import { access, realpath as realpathFromFilesystem, stat } from "node:fs/promises";
import { delimiter as pathDelimiter, extname, isAbsolute, join, resolve } from "node:path";

import type { DriverCliVersionReport } from "@ai-sidekicks/contracts";

import {
  DriverCliVersionUnparseableError,
  assertCliVersionMeetsFloor,
  parseCliVersionReport,
  type FlooredDriverName,
} from "./capability-refresh.js";
import type { SpawnedVersionBindingCarriers } from "./runtime-binding-store.js";

// The two driver ids as LITERALS rather than as imports from the driver trees:
// a `provider/`-level module is imported BY `provider/drivers/**`, never the
// reverse, and reaching into `drivers/codex/capabilities.ts` for its
// `CODEX_DRIVER_NAME` would invert that direction for a two-token constant.
// `FlooredDriverName` is what keeps the two spellings honest — a driver added to
// that union without a branch here is a compile error at the exhaustive switch.
const CLAUDE_DRIVER: FlooredDriverName = "claude";
const CODEX_DRIVER: FlooredDriverName = "codex";

// --------------------------------------------------------------------------
// Auto-update suppression in the spawned child
// --------------------------------------------------------------------------

/**
 * The documented auto-update opt-out each provider's child environment carries
 * (`Spec-005 §Required Behavior`, 2026-08-26).
 *
 * Suppression is a CORRECTNESS obligation, not hygiene: a build that replaces
 * itself mid-session invalidates the version recorded on the run's binding AND
 * the capability snapshot the run was admitted against, because neither
 * describes the process that is still executing.
 *
 * TOTAL over `FlooredDriverName`, and the empty Codex entry is a DECLARATION
 * rather than an omission — the same doctrine the per-driver capability tables
 * use. codex-cli documents no environment opt-out, so it reaches the same
 * guarantee the spec's fallback names: the driver resolves and spawns an EXACT
 * BUILD PATH rather than a floating launcher, which {@link
 * resolveProviderExecutable} is. An omitted key and a deliberately-empty one
 * must never look alike.
 */
export const PROVIDER_AUTO_UPDATE_OPT_OUT_ENV: Readonly<
  Record<FlooredDriverName, Readonly<Record<string, string>>>
> = Object.freeze({
  // Presence-style gates on the pinned build
  // (`docs/reference/provider-wire/claude.md`).
  claude: Object.freeze({ DISABLE_AUTOUPDATER: "1", DISABLE_UPDATES: "1" }),
  codex: Object.freeze({}),
});

/**
 * Compose the environment for a driver-spawned child.
 *
 * The opt-out is applied LAST and therefore WINS: an inherited
 * `DISABLE_AUTOUPDATER=0` in the daemon's own environment must not be able to
 * re-enable a provider auto-updater underneath a running driver. The base
 * environment is otherwise passed through untouched — this function decides
 * exactly one thing, and pruning the rest would be a second, undeclared policy.
 */
export function composeProviderChildEnvironment(
  driverName: FlooredDriverName,
  baseEnvironment: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  return { ...baseEnvironment, ...PROVIDER_AUTO_UPDATE_OPT_OUT_ENV[driverName] };
}

// --------------------------------------------------------------------------
// Executable resolution
// --------------------------------------------------------------------------

/**
 * Thrown when the configured provider command names no executable this node can
 * run, or names one whose real path cannot be read.
 *
 * `code === "driver.unavailable"`
 * (`docs/architecture/contracts/error-contracts.md §Driver`, HTTP 503). NO code
 * is minted: the 2026-08-26 amendment mints none, and a provider binary that is
 * absent from the node IS the driver being unavailable. Co-located with the
 * throwing module and carrying its own `fields`, matching the sibling
 * `driver.unavailable` classes in `provider-registry.ts` and both drivers'
 * `lifecycle.ts` — the registry's variant is bound to registry LOOKUP
 * (`fields: { driverId }`) and would misdescribe a filesystem resolution.
 *
 * `requestedCommand` is OPERATOR-CONFIGURED daemon input, not provider output,
 * so it rides `fields` verbatim under the same reasoning that lets the registry
 * variant carry a `driverId`.
 */
export class ProviderExecutableUnresolvableError extends Error {
  readonly code = "driver.unavailable" as const;
  readonly fields: {
    readonly driverName: FlooredDriverName;
    readonly requestedCommand: string;
    readonly reason: string;
  };

  constructor(driverName: FlooredDriverName, requestedCommand: string, reason: string) {
    super("Provider driver is currently unavailable");
    this.name = "ProviderExecutableUnresolvableError";
    this.fields = { driverName, requestedCommand, reason };
  }
}

/** `fs.promises.realpath` seam. Rejects with a Node `ErrnoException`. */
export type ExecutableRealpathResolver = (candidate: string) => Promise<string>;

/** "Is this path a file this process may execute?" — never rejects. */
export type ExecutableFileProbe = (candidate: string) => Promise<boolean>;

/**
 * The filesystem and platform seams resolution depends on. Injected for the
 * same reason `trust-envelope.ts` injects its `realpath`: the win32 leg has to
 * be drivable from a posix test host, and a resolution suite must not depend on
 * which provider builds happen to be installed on the machine running it.
 */
export interface ProviderExecutableResolverDependencies {
  readonly realpath: ExecutableRealpathResolver;
  readonly isExecutableFile: ExecutableFileProbe;
  /** Read once per resolution — supplies `PATH` and, on win32, `PATHEXT`. */
  readonly readEnvironment: () => Readonly<Record<string, string | undefined>>;
  /** `"win32"` selects the `PATHEXT` candidate expansion below. */
  readonly platform: NodeJS.Platform;
  /** Anchor for a RELATIVE configured command. */
  readonly workingDirectory: string;
}

/**
 * The production executability probe.
 *
 * `stat` (not `lstat`) so a launcher SYMLINK probes as the file it points at,
 * and an explicit `isFile()` test because POSIX `X_OK` succeeds on DIRECTORIES —
 * a `PATH` entry that happens to contain a directory named `claude` would
 * otherwise resolve as the provider binary. Never rejects: an unreadable,
 * missing, or non-executable candidate is simply not a candidate, and the
 * refusal belongs to the caller once every candidate is exhausted.
 */
export const DEFAULT_IS_EXECUTABLE_FILE: ExecutableFileProbe = async (candidate) => {
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
 * `node:fs/promises.realpath`, which Node documents as resolving with the
 * semantics of `fs.realpath.native()` — the dereference that turns a launcher
 * symlink into the exact build path this module spawns and records.
 */
export const DEFAULT_EXECUTABLE_REALPATH: ExecutableRealpathResolver = realpathFromFilesystem;

/** Production defaults; every member is overridable for tests. */
export function resolveExecutableResolverDependencies(
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

/**
 * The one executable a spawn and its binding row both name.
 *
 * `requestedCommand` is kept beside the resolution so a diagnostic can show what
 * drifted — the configured launcher and the build it dereferenced to are
 * different facts, and the whole point of this module is that only the second
 * one describes the running process.
 */
export interface ResolvedProviderExecutable {
  /** The command as configured — a bare name, or a relative/absolute path. */
  readonly requestedCommand: string;
  /** Absolute and symlink-dereferenced. This is what gets spawned and stored. */
  readonly resolvedExecutablePath: string;
}

// The `PATHEXT` fallback cmd.exe itself defaults to. Consulted only when the
// environment carries no `PATHEXT`, so a configured value always wins.
const DEFAULT_WINDOWS_PATH_EXTENSIONS: readonly string[] = [".COM", ".EXE", ".BAT", ".CMD"];

function windowsCandidateNames(command: string, pathExtensions: readonly string[]): string[] {
  const withExtensions = pathExtensions.map((extension) => `${command}${extension}`);
  // A command that already spells an extension is tried AS WRITTEN first (the
  // shell's own rule); one that does not is tried only through `PATHEXT`, with
  // the bare name last so an extensionless executable still resolves.
  return extname(command) === "" ? [...withExtensions, command] : [command, ...withExtensions];
}

/**
 * Resolve a configured provider command to the exact build path this node will
 * spawn — `Spec-005 §Required Behavior`'s "resolving and spawning an exact build
 * path rather than a floating launcher".
 *
 * A command carrying a path separator is anchored (relative commands against
 * `workingDirectory`); a BARE command is searched along `PATH` in order, first
 * executable candidate winning, exactly as a shell would find the launcher. The
 * winner is then `realpath`ed, which is the step that makes the result a build
 * path rather than a launcher path.
 *
 * DECLARED PLATFORM PROPERTY, not an oversight: on win32 the `X_OK` probe is
 * inert (Node documents it as behaving like `F_OK` there), so the `PATHEXT`
 * expansion is what distinguishes an executable candidate from an arbitrary
 * file. On posix `PATHEXT` is not consulted at all.
 *
 * Refuses `driver.unavailable` rather than returning a sentinel: a daemon that
 * cannot name the binary cannot honestly report a version for it, and every
 * caller of this module is on the fail-closed side of an admission decision.
 */
export async function resolveProviderExecutable(
  driverName: FlooredDriverName,
  requestedCommand: string,
  dependencies: Partial<ProviderExecutableResolverDependencies> = {},
): Promise<ResolvedProviderExecutable> {
  const deps = resolveExecutableResolverDependencies(dependencies);
  if (requestedCommand.trim() === "") {
    throw new ProviderExecutableUnresolvableError(
      driverName,
      requestedCommand,
      "the configured provider command is empty",
    );
  }

  const environment = deps.readEnvironment();
  const isWindows = deps.platform === "win32";
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
    ? [resolve(deps.workingDirectory, requestedCommand)]
    : (environment["PATH"] ?? "")
        .split(pathDelimiter)
        .filter((entry) => entry !== "")
        .map((entry) => join(entry, requestedCommand));

  const candidates: string[] = isWindows
    ? searchRoots.flatMap((root) => windowsCandidateNames(root, effectiveExtensions))
    : searchRoots;

  for (const candidate of candidates) {
    if (!(await deps.isExecutableFile(candidate))) {
      continue;
    }
    let resolvedExecutablePath: string;
    try {
      resolvedExecutablePath = await deps.realpath(candidate);
    } catch {
      // The candidate vanished (or became unreadable) between the probe and the
      // dereference. Fall through to the next candidate rather than refusing on
      // a race — but never fall back to the UNRESOLVED candidate, which is the
      // launcher path this module exists to stop trusting.
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

// --------------------------------------------------------------------------
// The in-band version handshake
// --------------------------------------------------------------------------

/**
 * The `clientInfo.name` the daemon supplies at the Codex `initialize` handshake.
 *
 * Constrained by `Spec-005 §Required Behavior`'s extraction rule: it must carry
 * no `/` and no whitespace, because it is the LEADING TOKEN of the composite
 * `userAgent` and the delimiter the provider's own version is read against. A
 * name carrying either would make the extraction ambiguous in the provider's
 * favour, which is the failure the rule exists to prevent.
 */
export const DEFAULT_PROVIDER_VERSION_CLIENT_NAME: string = "ai-sidekicks-daemon";

/** What the transport needs in order to run one zero-turn version handshake. */
export interface ProviderVersionHandshakeRequest {
  readonly driverName: FlooredDriverName;
  /** Absolute, symlink-dereferenced — spawn THIS, never the configured name. */
  readonly resolvedExecutablePath: string;
  /** Auto-update suppression already applied ({@link composeProviderChildEnvironment}). */
  readonly environment: Readonly<Record<string, string | undefined>>;
  /**
   * The `clientInfo.name` to send. Carried on the REQUEST so the name the
   * transport sends and the name the extractor compares against are one value —
   * two constants could drift, and the drift would be invisible until a
   * provider's `userAgent` silently parsed as the client's own version.
   */
  readonly clientName: string;
}

/**
 * Run one zero-turn in-band version handshake against an already-resolved
 * executable and return the provider's REPLY PAYLOAD, unadjudicated.
 *
 * Deliberately `Promise<unknown>`: the reply is provider output crossing a trust
 * boundary, and this module's extractors are where it is adjudicated. A typed
 * seam here would let a transport's own cast decide what the daemon believes
 * about the running build.
 *
 * The implementer owns the process lifetime and the deadline
 * (`driver.timeout`), and MUST spawn `request.resolvedExecutablePath` with
 * `request.environment`.
 */
export type ProviderVersionHandshake = (
  request: ProviderVersionHandshakeRequest,
) => Promise<unknown>;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Read the running build's version out of a Claude `get_binary_version` reply.
 *
 * ADOPTED AS-IS: the reply's `version` member is a version string in its own
 * right, so there is nothing to extract. `buildTime` rides the same reply and is
 * deliberately NOT carried onto the reading — no consumer reads it, and this
 * spec's own discovery rule forbids minting a member ahead of its reader.
 *
 * A reply that is not an object, or whose `version` is not a string, refuses as
 * `driver.cli_version_unparseable` — the same fail-closed code an unparseable
 * version string takes, because a provider that answered the version request
 * without a version has told us nothing about the build either way.
 */
export function extractClaudeReportedVersion(payload: unknown): string {
  const reply = asRecord(payload);
  const version = reply?.["version"];
  if (typeof version !== "string") {
    throw new DriverCliVersionUnparseableError(CLAUDE_DRIVER, "");
  }
  return version;
}

/**
 * Extract the running build's version from a Codex `initialize` reply's
 * COMPOSITE `userAgent` (`Spec-005 §Required Behavior`, the stated rule).
 *
 * The rule, in the order it is applied — every step is load-bearing, because the
 * string carries the CALLER's own name and version too and a naive parse returns
 * the client's version instead of the provider's:
 *
 *   1. The daemon-supplied `clientName` carries no `/` and no whitespace. This
 *      is a DAEMON obligation, so its violation is an internal-invariant `Error`
 *      rather than a provider refusal.
 *   2. The `userAgent`'s leading token — everything before the FIRST `/` — must
 *      be exactly that name. A `userAgent` that does not start with the name the
 *      daemon supplied is not the shape this rule can read, and it refuses
 *      rather than guessing.
 *   3. The version is the substring between that first `/` and the next
 *      whitespace.
 *   4. That substring must BE a canonical semantic version, not merely CONTAIN
 *      one. The check is a round-trip through the shared
 *      {@link parseCliVersionReport} seam plus an equality test, because that
 *      parser extracts the first `X.Y.Z` token ANYWHERE in its input — handed a
 *      whole `userAgent` it would land on the right version only by accident of
 *      the pin's field order, and handed a token like `v0.149.1` or
 *      `0.149.1+meta` it would answer a value the provider did not report.
 *
 * Anything else refuses as `driver.cli_version_unparseable`. There is
 * deliberately NO shell-out fallback: `claude --version`-style resolution is the
 * failure mode this whole module exists to eliminate, and Codex's structured
 * alternative (`server/diagnostics`) is `experimentalApi`-gated and carries no
 * version field anyway.
 */
export function extractCodexReportedVersion(payload: unknown, clientName: string): string {
  if (clientName === "" || clientName.includes("/") || /\s/.test(clientName)) {
    throw new Error(
      "Codex version extraction requires a daemon-supplied clientInfo.name carrying no '/' and no whitespace",
    );
  }
  const reply = asRecord(payload);
  const userAgent = reply?.["userAgent"];
  if (typeof userAgent !== "string") {
    throw new DriverCliVersionUnparseableError(CODEX_DRIVER, "");
  }

  const firstSlashIndex = userAgent.indexOf("/");
  if (firstSlashIndex === -1 || userAgent.slice(0, firstSlashIndex) !== clientName) {
    throw new DriverCliVersionUnparseableError(CODEX_DRIVER, userAgent);
  }
  const versionToken = /^\S*/.exec(userAgent.slice(firstSlashIndex + 1))?.[0] ?? "";

  let parsed: DriverCliVersionReport;
  try {
    parsed = parseCliVersionReport(CODEX_DRIVER, versionToken);
  } catch {
    // Rethrown against the WHOLE `userAgent`: that is the string the provider
    // actually reported, and an operator diagnosing a shape change needs to see
    // it rather than the fragment this rule carved out of it.
    throw new DriverCliVersionUnparseableError(CODEX_DRIVER, userAgent);
  }
  if (parsed.semver !== versionToken) {
    throw new DriverCliVersionUnparseableError(CODEX_DRIVER, userAgent);
  }
  return versionToken;
}

// --------------------------------------------------------------------------
// The one reading
// --------------------------------------------------------------------------

/**
 * ONE spawned-build reading: which executable was resolved, and what the process
 * started at that path reported about itself.
 *
 * This is the value `Spec-005 §Required Behavior` means by "one reading serves
 * both consumers". It is threaded, never re-derived and never cached across
 * spawns: a refresh takes a NEW reading of the same install (that is what makes
 * a mid-lifetime replacement detectable), while a single spawn's capability
 * declaration and its `runtime_bindings` row must both come from the SAME value.
 */
export interface SpawnedProviderVersionReading {
  readonly driverName: FlooredDriverName;
  /** Absolute, symlink-dereferenced — the build that answered the handshake. */
  readonly resolvedExecutablePath: string;
  /** At or above the driver's ratified floor by construction. */
  readonly report: DriverCliVersionReport;
}

/** Everything one spawned-version reading needs. */
export interface SpawnedProviderVersionReadRequest {
  readonly driverName: FlooredDriverName;
  /** The configured provider command — a bare name, or a path. */
  readonly requestedCommand: string;
  /** The transport that spawns and performs the handshake (no default). */
  readonly handshake: ProviderVersionHandshake;
  /** Defaults to this process's environment; the opt-out is applied over it. */
  readonly baseEnvironment?: Readonly<Record<string, string | undefined>>;
  /** Defaults to {@link DEFAULT_PROVIDER_VERSION_CLIENT_NAME}. */
  readonly clientName?: string;
  readonly resolver?: Partial<ProviderExecutableResolverDependencies>;
}

/**
 * Resolve, spawn, read in-band, and gate on the ratified floor — the whole of
 * T3.23's admission path, in the order the spec states it.
 *
 * ORDERING IS THE CONTRACT. The minimal version-handshake process IS permitted
 * to spawn on a below-floor build, because the version is read in-band FROM it;
 * what the floor refusal precedes is every use of that process BEYOND the
 * handshake — no session is created, no capability is probed, and no turn is
 * billed against a build the daemon does not support.
 *
 * The floor compare here and the one each driver's capability composition
 * performs are the SAME comparison at two moments, deliberately: this one covers
 * the read, and the composition's covers refresh (whose reading arrives through
 * the driver's own seam). The compare is pure and idempotent, so running it
 * twice costs a semver comparison and buys a gate that cannot be bypassed by
 * entering through either door.
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

  // Exhaustive over `FlooredDriverName`: a driver added to that union without an
  // in-band channel declared here fails to compile rather than silently
  // inheriting another provider's reply shape.
  let raw: string;
  switch (driverName) {
    case "claude":
      raw = extractClaudeReportedVersion(payload);
      break;
    case "codex":
      raw = extractCodexReportedVersion(payload, clientName);
      break;
  }

  const report = parseCliVersionReport(driverName, raw);
  assertCliVersionMeetsFloor(driverName, report);
  return { driverName, resolvedExecutablePath: resolved.resolvedExecutablePath, report };
}

/**
 * Project the reading onto the two `runtime_bindings` carriers, so the recorded
 * version and the recorded executable path can only ever come from ONE reading
 * (`Spec-005 §Required Behavior`: "the recorded version can never describe a
 * different install from the one that ran").
 *
 * Consumed by the store's own `withSpawnedVersionCarriers`, which is where the
 * pair is merged into a create input — a caller that assembled the two members
 * by hand is exactly the drift this projection removes.
 */
export function toBindingVersionCarriers(
  reading: SpawnedProviderVersionReading,
): SpawnedVersionBindingCarriers {
  return {
    cliVersion: { raw: reading.report.raw, semver: reading.report.semver },
    resolvedExecutablePath: reading.resolvedExecutablePath,
  };
}
