/**
 * Capability refresh: the CLI-version parse and the refresher that re-reads capabilities.
 *
 * - The parse records a version; nothing compares it, so every installed build runs.
 * - The refresher reads on demand only, never on a timer, and holds no auth record: readiness to
 *   admit a run comes from the account's stored health. Change detection belongs to
 *   `DriverCapabilitiesWriter`; the refresher adds none.
 */

import type { ProviderName } from "@ai-sidekicks/contracts/provider-account";
import semver from "semver";

import { type CapabilityDetectionReading, isCapabilityProbeError } from "./capability-probe.js";
import type { DeclareDriverCapabilitiesResult } from "./driver-capabilities-writer.js";
import type { DriverDiagnosticsEmitter } from "./driver-diagnostics.js";
import type { DriverCliVersionReport } from "./provider-driver.js";

// The first `X.Y.Z` token in prose such as `"cli-name 2.1.245 (build 7)"`. Not `semver.coerce`,
// which would turn `"v2"` into `2.0.0`: a partial version stays unparsed.
const SEMVER_TOKEN_PATTERN = /\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?/;

/**
 * Derives a `DriverCliVersionReport` from a provider-reported raw version: `rawVersion` verbatim,
 * and `parsedVersion` only when a canonical version can be extracted.
 */
export function parseCliVersionReport(rawVersion: string): DriverCliVersionReport {
  const token = SEMVER_TOKEN_PATTERN.exec(rawVersion)?.[0];
  const canonical = token === undefined ? null : semver.valid(token);
  return canonical === null ? { rawVersion } : { rawVersion, parsedVersion: canonical };
}

/**
 * The liveness backstop for one driver's read: a read that never settles would hold the in-flight
 * slot and wedge every later refresh. It abandons the promise; only the seam's own deadline
 * (`resolveProviderExecutable` in `spawned-provider-version.ts`) can cancel provider work.
 */
export const CAPABILITY_REFRESH_READ_TIMEOUT_MS: number = 2 * 60 * 1000;

/**
 * One driver's re-read, as an injected closure so the refresher needs no provider process. It
 * re-reads the declaration and declares it through the writer, which owns change detection; the
 * result is ignored. Every read takes a new detection reading: replaying an earlier one would hide
 * a capability that has since disappeared.
 */
export interface CapabilityRefreshDriverEntry {
  /** Canonical driver id. */
  readonly driverName: ProviderName;
  readonly refreshDeclaration: () => Promise<DeclareDriverCapabilitiesResult>;
}

/**
 * A structured report of a failed read, for the optional callback; every failure also reaches the
 * diagnostics emitter. One driver's failure never stops a sibling's read.
 */
export interface CapabilityRefreshDiagnostic {
  readonly driverName: ProviderName;
  /**
   * `capability-probe` refines `capability-refresh`: the detection read runs inside
   * `refreshDeclaration()`, and this marks failures the probe surface caused. A read that only
   * withdrew a flag has its own kind (see {@link emitCapabilityDetectionDiagnostics}).
   */
  readonly leg: "capability-refresh" | "capability-probe";
  /** The typed error's registered code, where the failure carried one. */
  readonly code?: string | undefined;
  readonly message: string;
  readonly timedOut: boolean;
}

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

/** What the refresher reads and where it reports a failed read. */
export interface CapabilityRefresherDependencies {
  /** The drivers this machine runs; each is re-read on every refresh. */
  readonly drivers: readonly CapabilityRefreshDriverEntry[];
  /** Required, so no refresh failure goes uncounted. */
  readonly diagnostics: DriverDiagnosticsEmitter;
  /** Structured delivery of the same failures, in addition to `diagnostics`. */
  readonly onDiagnostic?: (diagnostic: CapabilityRefreshDiagnostic) => void;
}

/** One read's settlement under the refresher's liveness backstop. */
type RefreshReadOutcome =
  | { readonly settled: "fulfilled" }
  | { readonly settled: "rejected"; readonly reason: unknown }
  | { readonly settled: "timed-out" };

// On timeout the read's promise is abandoned, not canceled. Both settlement paths attach before the
// race, so a late rejection is never unhandled.
async function settleReadWithinDeadline(
  runRead: () => Promise<unknown>,
  deadlineMs: number,
): Promise<RefreshReadOutcome> {
  let readPromise: Promise<RefreshReadOutcome>;
  try {
    readPromise = runRead().then(
      (): RefreshReadOutcome => ({ settled: "fulfilled" }),
      (reason: unknown): RefreshReadOutcome => ({ settled: "rejected", reason }),
    );
  } catch (cause) {
    // A seam that throws synchronously produced no promise to race.
    return { settled: "rejected", reason: cause };
  }

  let deadlineTimer: NodeJS.Timeout | undefined;
  const deadlinePromise = new Promise<RefreshReadOutcome>((resolve) => {
    deadlineTimer = setTimeout(() => {
      resolve({ settled: "timed-out" });
    }, deadlineMs);
    deadlineTimer.unref();
  });

  try {
    return await Promise.race([readPromise, deadlinePromise]);
  } finally {
    if (deadlineTimer !== undefined) {
      clearTimeout(deadlineTimer);
    }
  }
}

/**
 * Re-reads every driver's capabilities when asked: at daemon start and on each refresh trigger,
 * never on a timer. A refresh asked for while one is running is dropped, not stacked, and nothing
 * is read after `shutdown`.
 */
export class CapabilityRefresher {
  readonly #drivers: readonly CapabilityRefreshDriverEntry[];
  readonly #diagnostics: DriverDiagnosticsEmitter;
  readonly #onDiagnostic: ((diagnostic: CapabilityRefreshDiagnostic) => void) | undefined;
  #refreshInFlight = false;
  #isShutDown = false;

  constructor(dependencies: CapabilityRefresherDependencies) {
    this.#drivers = dependencies.drivers;
    this.#diagnostics = dependencies.diagnostics;
    this.#onDiagnostic = dependencies.onDiagnostic;
  }

  /** Reads every driver once; resolves when each read has settled or timed out. */
  async refreshNow(): Promise<void> {
    if (this.#isShutDown || this.#refreshInFlight) {
      return;
    }
    this.#refreshInFlight = true;
    try {
      await Promise.all(this.#drivers.map((entry) => this.#refreshDriver(entry)));
    } finally {
      this.#refreshInFlight = false;
    }
  }

  /** Stops the refresher: every later `refreshNow` reads nothing. */
  shutdown(): void {
    this.#isShutDown = true;
  }

  async #refreshDriver(entry: CapabilityRefreshDriverEntry): Promise<void> {
    const outcome = await settleReadWithinDeadline(
      () => entry.refreshDeclaration(),
      CAPABILITY_REFRESH_READ_TIMEOUT_MS,
    );
    if (outcome.settled !== "fulfilled") {
      this.#reportFailure(entry.driverName, outcome);
    }
  }

  #reportFailure(
    driverName: ProviderName,
    outcome: Exclude<RefreshReadOutcome, { readonly settled: "fulfilled" }>,
  ): void {
    const timedOut = outcome.settled === "timed-out";
    const reason = outcome.settled === "rejected" ? outcome.reason : undefined;
    const leg: CapabilityRefreshDiagnostic["leg"] = isCapabilityProbeError(reason)
      ? "capability-probe"
      : "capability-refresh";
    const code =
      typeof reason === "object" &&
      reason !== null &&
      "code" in reason &&
      typeof reason.code === "string"
        ? reason.code
        : undefined;
    const message = timedOut
      ? `read did not settle within ${String(CAPABILITY_REFRESH_READ_TIMEOUT_MS)}ms`
      : reason instanceof Error
        ? reason.message
        : String(reason);

    this.#diagnostics.emit({
      provider: driverName,
      kind: "capability_refresh_failed",
      rawWireType: null,
      dispositionReason: timedOut
        ? "capability read exceeded the refresher's liveness backstop; abandoned until the next trigger"
        : "capability read rejected; reported, and read again on the next trigger",
      details: { leg, timedOut, code: code ?? null, message },
    });

    this.#onDiagnostic?.({ driverName, leg, code, message, timedOut });
  }
}
