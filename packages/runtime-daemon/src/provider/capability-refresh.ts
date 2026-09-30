/**
 * Capability refresh: the CLI-version floor and the scheduler that re-reads capabilities. The floor
 * lives here so neither driver tree imports the other.
 *
 * - The floor fails closed with two 409 codes: `driver.cli_version_unparseable` (no canonical
 *   semver) and `driver.cli_version_below_floor`. Neither is `version.floor_exceeded`, which
 *   governs client and event-envelope floors. A build at or above the floor is admitted.
 * - Each tick pairs `refreshDeclaration()` with the zero-turn `probeAuth()`, because auth state is
 *   not on `GetCapabilitiesResult`; a capabilities-only poll would leave admission auth state stale
 *   after a logout. Mid-run credential expiry stays with the live `reauth-required` signal.
 * - Change detection belongs to `DriverCapabilitiesWriter`; the scheduler adds none. It owns the
 *   per-(node, driver) auth-state record that run admission reads; a thrown probe records
 *   `indeterminate`: fail closed, yet distinct from `unauthenticated`.
 */

import semver from "semver";

import { type CapabilityDetectionReading, isCapabilityProbeError } from "./capability-probe.js";
import type { DeclareDriverCapabilitiesResult } from "./driver-capabilities-writer.js";
import { type DriverDiagnosticKind, type DriverDiagnosticsEmitter } from "./driver-diagnostics.js";
import { CLI_VERSION_RAW_MAX_LEN } from "./provider-output-validation.js";
import type { DriverAuthProbeResult, DriverCliVersionReport } from "./provider-driver.js";

/** The two drivers the V1 floor table answers for. */
export type FlooredDriverName = "claude" | "codex";

/**
 * The oldest CLI build each driver accepts (a floor, not a pin), compared against the in-band
 * reading of the spawned process.
 */
export const DRIVER_CLI_VERSION_FLOORS: Readonly<Record<FlooredDriverName, string>> = Object.freeze(
  {
    claude: "2.1.234",
    codex: "0.141.0",
  },
);

/**
 * Thrown when a provider-reported version yields no canonical semver (`code`
 * `driver.cli_version_unparseable`, 409). `fields.raw` is capped at `CLI_VERSION_RAW_MAX_LEN` so a
 * provider binary cannot put an oversized string on the error.
 */
export class DriverCliVersionUnparseableError extends Error {
  readonly code = "driver.cli_version_unparseable" as const;
  readonly fields: { readonly driverName: FlooredDriverName; readonly raw: string };

  constructor(driverName: FlooredDriverName, raw: string) {
    super("The provider CLI's reported version could not be parsed to a semantic version");
    this.name = "DriverCliVersionUnparseableError";
    this.fields = {
      driverName,
      raw: raw.length > CLI_VERSION_RAW_MAX_LEN ? raw.slice(0, CLI_VERSION_RAW_MAX_LEN) : raw,
    };
  }
}

/** Thrown when a parsed version is below the driver's floor (`driver.cli_version_below_floor`). */
export class DriverCliVersionBelowFloorError extends Error {
  readonly code = "driver.cli_version_below_floor" as const;
  readonly fields: {
    readonly driverName: FlooredDriverName;
    readonly reportedSemver: string;
    readonly floor: string;
  };

  constructor(driverName: FlooredDriverName, reportedSemver: string, floor: string) {
    super("The provider CLI's reported version is below the configured minimum floor");
    this.name = "DriverCliVersionBelowFloorError";
    this.fields = { driverName, reportedSemver, floor };
  }
}

// The first `X.Y.Z` token in prose such as `"2.1.245 (Claude Code)"`. Not `semver.coerce`, which
// would turn `"v2"` into `2.0.0`: a partial version must be unparseable.
const SEMVER_TOKEN_PATTERN = /\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?/;

/**
 * Derives a `DriverCliVersionReport` from a provider-reported raw version. Throws
 * `DriverCliVersionUnparseableError` when no canonical semver can be extracted; `raw` is kept
 * verbatim.
 */
export function parseCliVersionReport(
  driverName: FlooredDriverName,
  raw: string,
): DriverCliVersionReport {
  const token = SEMVER_TOKEN_PATTERN.exec(raw)?.[0];
  const canonical = token === undefined ? null : semver.valid(token);
  if (canonical === null) {
    throw new DriverCliVersionUnparseableError(driverName, raw);
  }
  return { raw, semver: canonical };
}

/**
 * The floor gate: throws `DriverCliVersionBelowFloorError` below the driver's floor, and
 * `DriverCliVersionUnparseableError` for a non-canonical `semver` instead of a raw `TypeError`.
 */
export function assertCliVersionMeetsFloor(
  driverName: FlooredDriverName,
  report: DriverCliVersionReport,
): void {
  if (semver.valid(report.semver) !== report.semver) {
    throw new DriverCliVersionUnparseableError(driverName, report.raw);
  }
  const floor = DRIVER_CLI_VERSION_FLOORS[driverName];
  if (semver.lt(report.semver, floor)) {
    throw new DriverCliVersionBelowFloorError(driverName, report.semver, floor);
  }
}

/** The refresh cadence: 15 minutes, a constant rather than a constructor option. */
export const CAPABILITY_REFRESH_INTERVAL_MS: number = 15 * 60 * 1000;

/**
 * The liveness backstop for one poll leg, well inside the cadence: a leg that never settles would
 * hold its `#pollsInFlight` key and wedge the node. It abandons the promise; only the seam's own
 * deadline (`resolveProviderExecutable` in `version-gate.ts`) can cancel provider work.
 */
export const CAPABILITY_REFRESH_POLL_LEG_TIMEOUT_MS: number = 2 * 60 * 1000;

/**
 * One driver's refresh pair on one runtime node, as injected closures so the scheduler needs no
 * provider process. Both must settle; their implementer owns the deadline, and the poll-leg timeout
 * turns a hang into a reported failure but cannot cancel the work.
 */
export interface CapabilityRefreshDriverEntry {
  /** Canonical driver id; the auth-record key. */
  readonly driverName: FlooredDriverName;
  /**
   * Re-reads the declaration and declares it through the writer, which owns change detection; the
   * result is ignored. Every poll must take a new detection reading: replaying the attach-time one
   * would hide a capability that has since disappeared and report `probed` for a stale answer.
   */
  readonly refreshDeclaration: () => Promise<DeclareDriverCapabilitiesResult>;
  /** The zero-turn authentication probe, paired with every refresh. */
  readonly probeAuth: () => Promise<DriverAuthProbeResult>;
}

/** What the scheduler is handed at node attach. */
export interface CapabilityRefreshNodeRegistration {
  readonly nodeId: string;
  readonly drivers: readonly CapabilityRefreshDriverEntry[];
}

/**
 * The per-(node, driver) auth-state record run admission consumes. `detail` may carry personal
 * data, so it stays in memory and is never persisted or emitted here.
 */
export interface DriverAuthStateRecord {
  readonly status: DriverAuthProbeResult["status"];
  readonly detail?: string | undefined;
  /** When the probe answered (epoch ms) — staleness is the reader's judgment. */
  readonly observedAtMs: number;
}

/**
 * A structured report of a failed poll leg, for the optional callback; every failure also reaches
 * the diagnostics emitter. One failure never kills the timer or a sibling's poll.
 */
export interface CapabilityRefreshDiagnostic {
  readonly nodeId: string;
  readonly driverName: FlooredDriverName;
  /**
   * `capability-probe` refines `capability-refresh`: the detection read runs inside
   * `refreshDeclaration()`, and this marks failures the probe surface caused. A read that only
   * withdrew a flag has its own kind (see {@link emitCapabilityDetectionDiagnostics}).
   */
  readonly leg: "capability-refresh" | "auth-probe" | "capability-probe";
  /** The typed error's registered code, where the failure carried one. */
  readonly code?: string | undefined;
  readonly message: string;
  readonly timedOut: boolean;
}

// Keyed by the closed leg union so a leg without a kind is a compile error; `capability-probe`
// shares `capability_refresh_failed` because it is the same condition.
const CAPABILITY_REFRESH_DIAGNOSTIC_KINDS: Readonly<
  Record<CapabilityRefreshDiagnostic["leg"], DriverDiagnosticKind>
> = Object.freeze({
  "capability-refresh": "capability_refresh_failed",
  "capability-probe": "capability_refresh_failed",
  "auth-probe": "auth_probe_failed",
});

/**
 * Reports every flag a successful detection read withdrew, under `capability_flag_withdrawn` and
 * not a `*_failed` kind: the read worked, but the node can do less than its matrix says. Emits
 * nothing when every flag was accepted.
 */
export function emitCapabilityDetectionDiagnostics(
  diagnostics: DriverDiagnosticsEmitter,
  reading: CapabilityDetectionReading,
): void {
  for (const withdrawal of reading.diagnostics) {
    diagnostics.emit({
      provider: withdrawal.driverName,
      kind: "capability_flag_withdrawn",
      // The probe name is the wire name that caused this record.
      rawWireType: withdrawal.probeName,
      dispositionReason:
        withdrawal.disposition === "unknown-name"
          ? "probe channel refused the wire name itself, so this build does not carry the surface the flag declares; flag withdrawn from the declaration"
          : "probe answer could not be classified, and an unclassifiable answer is never read as availability; flag withdrawn fail-closed",
      details: {
        flag: withdrawal.flag,
        probeName: withdrawal.probeName,
        disposition: withdrawal.disposition,
        boundExecutablePath: reading.boundExecutablePath,
      },
    });
  }
}

/** What the scheduler needs to report poll failures. */
export interface CapabilityRefreshSchedulerDependencies {
  /** Required, so no node's refresh failures go uncounted. */
  readonly diagnostics: DriverDiagnosticsEmitter;
  /** Structured delivery of the same failures, in addition to `diagnostics`. */
  readonly onDiagnostic?: (diagnostic: CapabilityRefreshDiagnostic) => void;
}

interface ScheduledNode {
  readonly registration: CapabilityRefreshNodeRegistration;
  readonly timer: NodeJS.Timeout;
  /**
   * Monotonic lifetime token: a poll re-checks it before writing, so a detached lifetime cannot
   * write a stale credential reading into a re-attached node.
   */
  readonly generation: number;
}

/** One poll leg's settlement under the scheduler's liveness backstop. */
type PollLegOutcome<TValue> =
  | { readonly settled: "fulfilled"; readonly value: TValue }
  | { readonly settled: "rejected"; readonly reason: unknown }
  | { readonly settled: "timed-out" };

// On timeout the leg's promise is abandoned, not canceled. Both settlement paths attach before the
// race, so a late rejection is never unhandled.
async function settleLegWithinDeadline<TValue>(
  runLeg: () => Promise<TValue>,
  deadlineMs: number,
): Promise<PollLegOutcome<TValue>> {
  let legPromise: Promise<PollLegOutcome<TValue>>;
  try {
    legPromise = runLeg().then(
      (value): PollLegOutcome<TValue> => ({ settled: "fulfilled", value }),
      (reason: unknown): PollLegOutcome<TValue> => ({ settled: "rejected", reason }),
    );
  } catch (cause) {
    // A seam that throws synchronously produced no promise to race.
    return { settled: "rejected", reason: cause };
  }

  let deadlineTimer: NodeJS.Timeout | undefined;
  const deadlinePromise = new Promise<PollLegOutcome<TValue>>((resolve) => {
    deadlineTimer = setTimeout(() => {
      resolve({ settled: "timed-out" });
    }, deadlineMs);
    deadlineTimer.unref();
  });

  try {
    return await Promise.race([legPromise, deadlinePromise]);
  } finally {
    if (deadlineTimer !== undefined) {
      clearTimeout(deadlineTimer);
    }
  }
}

/**
 * One timer per attached runtime node, each tick polling every registered driver's refresh and
 * auth-probe pair. `refreshNow` is the lever for provider-push updates.
 */
export class CapabilityRefreshScheduler {
  readonly #nodes: Map<string, ScheduledNode> = new Map();
  // nodeId → driverName → latest probe record. Dropped on detach so a re-attach never answers
  // admission with a previous lifetime's credential state.
  readonly #authStates: Map<string, Map<string, DriverAuthStateRecord>> = new Map();
  // Keyed by (nodeId, generation): a tick outliving the interval must not stack a second poll, and
  // a detached lifetime's poll must not block the re-attached one.
  readonly #pollsInFlight: Set<string> = new Set();
  // Per-node lifetime counter minted at each `startForNode`. Never reset on detach, so a
  // re-attach cannot reuse a token an in-flight poll still holds.
  readonly #nodeGenerations: Map<string, number> = new Map();
  readonly #diagnostics: DriverDiagnosticsEmitter;
  readonly #onDiagnostic: ((diagnostic: CapabilityRefreshDiagnostic) => void) | undefined;

  constructor(dependencies: CapabilityRefreshSchedulerDependencies) {
    this.#diagnostics = dependencies.diagnostics;
    this.#onDiagnostic = dependencies.onDiagnostic;
  }

  /**
   * Starts (or restarts) the node's poll timer. The first poll fires one full cadence after attach,
   * since attach already makes the initial declaration.
   */
  startForNode(registration: CapabilityRefreshNodeRegistration): void {
    this.stopForNode(registration.nodeId);
    const generation = (this.#nodeGenerations.get(registration.nodeId) ?? 0) + 1;
    this.#nodeGenerations.set(registration.nodeId, generation);
    const timer = setInterval(() => {
      void this.#pollNode(registration.nodeId);
    }, CAPABILITY_REFRESH_INTERVAL_MS);
    // A refresh timer must never keep the process alive.
    timer.unref();
    this.#nodes.set(registration.nodeId, { registration, timer, generation });
  }

  /** Stop the node's timer and drop its auth records. */
  stopForNode(nodeId: string): void {
    const scheduled = this.#nodes.get(nodeId);
    if (scheduled !== undefined) {
      clearInterval(scheduled.timer);
      this.#nodes.delete(nodeId);
    }
    this.#authStates.delete(nodeId);
  }

  /** Clear every node's timer. */
  shutdown(): void {
    for (const nodeId of [...this.#nodes.keys()]) {
      this.stopForNode(nodeId);
    }
  }

  /** Runs one poll now, outside the cadence; a push landing mid-poll is dropped, not stacked. */
  async refreshNow(nodeId: string): Promise<void> {
    await this.#pollNode(nodeId);
  }

  /** The admission-side read of the latest probe result for one driver. */
  getAuthState(nodeId: string, driverName: string): DriverAuthStateRecord | undefined {
    return this.#authStates.get(nodeId)?.get(driverName);
  }

  async #pollNode(nodeId: string): Promise<void> {
    const scheduled = this.#nodes.get(nodeId);
    if (scheduled === undefined) {
      return;
    }
    const inFlightKey = this.#composeInFlightKey(nodeId, scheduled.generation);
    if (this.#pollsInFlight.has(inFlightKey)) {
      return;
    }
    this.#pollsInFlight.add(inFlightKey);
    try {
      await Promise.all(
        scheduled.registration.drivers.map((entry) =>
          this.#pollDriver(nodeId, scheduled.generation, entry),
        ),
      );
    } finally {
      this.#pollsInFlight.delete(inFlightKey);
    }
  }

  async #pollDriver(
    nodeId: string,
    generation: number,
    entry: CapabilityRefreshDriverEntry,
  ): Promise<void> {
    // The pair settles independently: a refresh refusal (say, a below-floor install found
    // mid-lifetime) must not suppress the auth reading, nor the reverse.
    const [refreshOutcome, probeOutcome] = await Promise.all([
      settleLegWithinDeadline(
        () => entry.refreshDeclaration(),
        CAPABILITY_REFRESH_POLL_LEG_TIMEOUT_MS,
      ),
      settleLegWithinDeadline(() => entry.probeAuth(), CAPABILITY_REFRESH_POLL_LEG_TIMEOUT_MS),
    ]);

    if (refreshOutcome.settled !== "fulfilled") {
      this.#reportFailure(nodeId, entry.driverName, "capability-refresh", refreshOutcome);
    }

    if (probeOutcome.settled === "fulfilled") {
      this.#recordAuthState(nodeId, generation, entry.driverName, {
        status: probeOutcome.value.status,
        detail: probeOutcome.value.detail,
        observedAtMs: Date.now(),
      });
    } else {
      // A thrown or never-settling probe is recorded `indeterminate` so the record never keeps
      // a stale `authenticated` past a broken probe.
      this.#recordAuthState(nodeId, generation, entry.driverName, {
        status: "indeterminate",
        observedAtMs: Date.now(),
      });
      this.#reportFailure(nodeId, entry.driverName, "auth-probe", probeOutcome);
    }
  }

  #recordAuthState(
    nodeId: string,
    generation: number,
    driverName: FlooredDriverName,
    record: DriverAuthStateRecord,
  ): void {
    // A record from a poll begun under an earlier node lifetime must not land on the current
    // one, or a re-attach would inherit a pre-detach `authenticated` reading it never probed.
    if (this.#nodes.get(nodeId)?.generation !== generation) {
      return;
    }
    let nodeRecords = this.#authStates.get(nodeId);
    if (nodeRecords === undefined) {
      nodeRecords = new Map();
      this.#authStates.set(nodeId, nodeRecords);
    }
    nodeRecords.set(driverName, record);
  }

  #composeInFlightKey(nodeId: string, generation: number): string {
    // NUL-separated so a nodeId containing the separator cannot forge another lifetime's key.
    return `${nodeId}\u0000${String(generation)}`;
  }

  #reportFailure(
    nodeId: string,
    driverName: FlooredDriverName,
    dispatchedLeg: CapabilityRefreshDiagnostic["leg"],
    outcome: PollLegOutcome<unknown>,
  ): void {
    const timedOut = outcome.settled === "timed-out";
    const reason = outcome.settled === "rejected" ? outcome.reason : undefined;
    // Only the refresh leg can fail on the capability probe surface; the auth probe has its own
    // failure vocabulary.
    const leg: CapabilityRefreshDiagnostic["leg"] =
      dispatchedLeg === "capability-refresh" && isCapabilityProbeError(reason)
        ? "capability-probe"
        : dispatchedLeg;
    const code =
      typeof reason === "object" &&
      reason !== null &&
      "code" in reason &&
      typeof (reason as { code: unknown }).code === "string"
        ? (reason as { code: string }).code
        : undefined;
    const message = timedOut
      ? `leg did not settle within ${String(CAPABILITY_REFRESH_POLL_LEG_TIMEOUT_MS)}ms`
      : reason instanceof Error
        ? reason.message
        : String(reason);

    this.#diagnostics.emit({
      provider: driverName,
      kind: CAPABILITY_REFRESH_DIAGNOSTIC_KINDS[leg],
      rawWireType: null,
      dispositionReason: timedOut
        ? "poll leg exceeded the scheduler's liveness backstop; abandoned and retried next cadence, with the auth record left fail-closed"
        : "poll leg rejected; reported and retried next cadence, with the auth record left fail-closed",
      details: { nodeId, leg, timedOut, code: code ?? null, message },
    });

    this.#onDiagnostic?.({ nodeId, driverName, leg, code, message, timedOut });
  }
}
