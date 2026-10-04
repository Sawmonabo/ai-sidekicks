/**
 * Per-capability zero-turn detection: one table entry per `DriverCapabilityFlag` per driver, naming
 * the mechanism that decides it or the admissibility conjunct that fails.
 *
 * - A probe must be zero-turn, non-mutating and decisive at the granularity the flag is consumed
 *   at; otherwise the flag is `static` and resolves from the driver's matrix.
 * - Resolution is withdraw-only (`declared && !withdrawn`): a probe never grants a `false` flag.
 * - Only a name-level refusal withdraws; an unclassifiable reply withdraws too (fail-closed), and
 *   ambiguity resolves toward `accepted`. A negative control that answers, or a rejecting
 *   transport, fails the whole read.
 * - Each provider names the wire names no probe may issue: one that mutates a session or starts a
 *   turn would break the never-started-session property that keeps probes non-mutating.
 */

import type { DriverCapabilityFlag } from "@ai-sidekicks/contracts/provider-driver";
import type { ProviderName } from "@ai-sidekicks/contracts/provider-account";

import type { CapabilityDetectionSource } from "./provider-driver.js";
import { PROVIDER_DRIVER_DESCRIPTORS } from "./provider-driver-descriptors.js";

/** The three conjuncts an admissible probe must satisfy; a `static` entry names those that fail. */
type ProbeAdmissibilityConjunct =
  | "zero-turn"
  | "non-mutating"
  | "decisive-at-consumption-granularity";

/** A non-empty tuple: a `static` entry naming no failing conjunct would be unjustified. */
type FailingConjuncts = readonly [ProbeAdmissibilityConjunct, ...ProbeAdmissibilityConjunct[]];

/** One admissible probe: the wire name(s) issued, and why the answer decides. */
interface CapabilityProbe {
  /**
   * The wire names this probe issues, with no payload. All must classify `accepted`; a name-level
   * refusal on any one withdraws the flag.
   */
  readonly probeNames: readonly [string, ...string[]];
  /** Why the answer is decisive at the granularity the flag is consumed at. */
  readonly decisiveness: string;
}

/**
 * How one flag's value is arrived at for one driver, discriminated on the wire literal
 * `CapabilityDetectionSource`.
 */
export type CapabilityDetectionMechanism =
  | {
      readonly detectionSource: "static";
      readonly failingConjuncts: FailingConjuncts;
      readonly rationale: string;
    }
  | { readonly detectionSource: "probed"; readonly probe: CapabilityProbe };

/** One mechanism per flag, total over the flag union, so an unanswered flag fails to compile. */
export type DriverCapabilityDetectionTable = Readonly<
  Record<DriverCapabilityFlag, CapabilityDetectionMechanism>
>;

/** Which request surface a probe name belongs to. */
export type CapabilityProbeChannel = "control_request" | "client_request";

/** One probe dispatch. It has no message body, turn identity or payload, so no turn is billed. */
export interface CapabilityProbeRequest {
  readonly driverName: ProviderName;
  readonly channel: CapabilityProbeChannel;
  readonly probeName: string;
  /**
   * The resolved executable path the version handshake proved, carried through (never re-resolved)
   * so each request and the reading name the executable being reported.
   */
  readonly boundExecutablePath: string;
}

/**
 * The injected probe transport, with no default. The implementer owns the deadline and must probe
 * on a connection that has never started a thread or sent a user message.
 * Returns `unknown` because it is untrusted provider output.
 */
export type CapabilityProbeExchange = (request: CapabilityProbeRequest) => Promise<unknown>;

/**
 * Base class for a failure of the probe surface itself. It has no wire `code`, so the refresh
 * scheduler discriminates on the class.
 */
export abstract class CapabilityProbeError extends Error {}

/** The negative control was answered, so the channel's refusals cannot be trusted. */
export class CapabilityProbeNegativeControlError extends CapabilityProbeError {
  readonly driverName: ProviderName;
  readonly probeName: string;

  constructor(driverName: ProviderName, probeName: string) {
    super(
      `capability probe negative control '${probeName}' was answered by driver '${driverName}` +
        `'; refusing to report capabilities from a channel that does not refuse`,
    );
    this.name = "CapabilityProbeNegativeControlError";
    this.driverName = driverName;
    this.probeName = probeName;
  }
}

/** The transport rejected: no reading exists, so nothing is declared. */
class CapabilityProbeTransportError extends CapabilityProbeError {
  readonly driverName: ProviderName;
  readonly probeName: string;

  constructor(driverName: ProviderName, probeName: string, options: { cause: unknown }) {
    super(
      `capability probe '${probeName}' transport failed for driver '${driverName}'`,
      // `cause` is provider- or transport-originated; it stays data and is never put in a message.
      options,
    );
    this.name = "CapabilityProbeTransportError";
    this.driverName = driverName;
    this.probeName = probeName;
  }
}

/** A probe name the table or a caller must never issue reached the dispatcher. */
export class CapabilityProbeProhibitedNameError extends CapabilityProbeError {
  readonly probeName: string;

  constructor(probeName: string) {
    super(`capability probe refused: '${probeName}' is a prohibited probe wire name`);
    this.name = "CapabilityProbeProhibitedNameError";
    this.probeName = probeName;
  }
}

/**
 * Throws `CapabilityProbeProhibitedNameError` for a wire name no probe of `driverName` may issue,
 * wherever it came from.
 */
export function assertProbeWireNameAdmissible(driverName: ProviderName, probeName: string): void {
  if (PROVIDER_DRIVER_DESCRIPTORS[driverName].capabilityProbeProhibitedNames.includes(probeName)) {
    throw new CapabilityProbeProhibitedNameError(probeName);
  }
}

/** True for every failure of the probe surface; the refresh scheduler uses it to tag its leg. */
export function isCapabilityProbeError(value: unknown): value is CapabilityProbeError {
  return value instanceof CapabilityProbeError;
}

/**
 * What one probe's answer says about its name. `accepted` includes a handler's own typed refusal;
 * only a name-level refusal withdraws.
 */
export type ProbeAnswer = "accepted" | "unknown-name" | "unrecognized";

/** One reason a detection table is not admissible. */
interface CapabilityDetectionTableViolation {
  readonly driverName: ProviderName;
  readonly flag: DriverCapabilityFlag;
  readonly reason: string;
}

/**
 * Report every entry that is not admissible: the runtime half of what the tuple types enforce at
 * compile time, for a table that may arrive from elsewhere.
 */
function findCapabilityDetectionTableViolations(
  driverName: ProviderName,
  table: DriverCapabilityDetectionTable,
): readonly CapabilityDetectionTableViolation[] {
  const violations: CapabilityDetectionTableViolation[] = [];
  for (const [flag, mechanism] of Object.entries(table) as [
    DriverCapabilityFlag,
    CapabilityDetectionMechanism,
  ][]) {
    if (mechanism.detectionSource === "static") {
      if (mechanism.failingConjuncts.length === 0) {
        violations.push({
          driverName,
          flag,
          reason: "a `static` entry must name at least one failing admissibility conjunct",
        });
      }
      if (mechanism.rationale.trim() === "") {
        violations.push({ driverName, flag, reason: "a `static` entry must carry a rationale" });
      }
      continue;
    }
    const { probeNames } = mechanism.probe;
    if (probeNames.length === 0) {
      violations.push({
        driverName,
        flag,
        reason: "a `probed` entry must declare at least one probe wire name",
      });
    }
    // A probe issues every name, so a prohibited one anywhere reaches the wire.
    for (const probeName of probeNames) {
      if (probeName.trim() === "") {
        violations.push({
          driverName,
          flag,
          reason: "a `probed` entry must declare a non-empty probe wire name",
        });
      }
      if (
        PROVIDER_DRIVER_DESCRIPTORS[driverName].capabilityProbeProhibitedNames.includes(probeName)
      ) {
        violations.push({
          driverName,
          flag,
          reason: `a probe may never issue the prohibited wire name '${probeName}'`,
        });
      }
    }
    if (mechanism.probe.decisiveness.trim() === "") {
      violations.push({
        driverName,
        flag,
        reason: "a `probed` entry must state why its answer is decisive",
      });
    }
  }
  return violations;
}

/** One flag withdrawn by its own probe, with the disposition that withdrew it. */
interface CapabilityProbeDiagnostic {
  readonly driverName: ProviderName;
  readonly flag: DriverCapabilityFlag;
  /** The first name, in table order, that withdrew the flag; the rest are not dispatched. */
  readonly probeName: string;
  /** `unrecognized-reply` is an answer that could not be classified, never read as availability. */
  readonly disposition: "unknown-name" | "unrecognized-reply";
}

/**
 * One live detection reading for one driver. `detectionSource` is total over the flag set;
 * `withdrawnFlags` is separate because a flag is `probed` whether its probe confirmed or withdrew.
 */
export interface CapabilityDetectionReading {
  readonly driverName: ProviderName;
  /** The build this reading describes, so a composition site can refuse a mixed report. */
  readonly boundExecutablePath: string;
  readonly detectionSource: Readonly<Record<DriverCapabilityFlag, CapabilityDetectionSource>>;
  readonly withdrawnFlags: readonly DriverCapabilityFlag[];
  readonly diagnostics: readonly CapabilityProbeDiagnostic[];
}

/** What one detection read needs: the driver, the build, and the transport. */
export interface CapabilityDetectionReadRequest {
  readonly driverName: ProviderName;
  /**
   * The resolved executable path the version handshake proved
   * (`SpawnedProviderVersionReading.resolvedExecutablePath`). Never re-resolved: a second
   * resolution can differ (a `PATH` change, an installer swap).
   */
  readonly boundExecutablePath: string;
  readonly exchange: CapabilityProbeExchange;
}

/**
 * Read one driver's detection sources through `exchange`; with no probe declared, nothing is sent.
 * Throws `CapabilityProbeNegativeControlError` when the negative control is answered,
 * `CapabilityProbeTransportError` when the transport rejects, and the prohibited-name error.
 */
export async function readCapabilityDetection(
  request: CapabilityDetectionReadRequest,
): Promise<CapabilityDetectionReading> {
  const { driverName, boundExecutablePath, exchange } = request;
  const descriptor = PROVIDER_DRIVER_DESCRIPTORS[driverName];
  const table = descriptor.capabilityDetectionTable;
  const violations = findCapabilityDetectionTableViolations(driverName, table);
  if (violations.length > 0) {
    // A malformed table is a daemon fault, not provider misbehavior.
    throw new Error(
      `capability detection table for driver '${driverName}' is inadmissible: ${violations
        .map((violation) => `${violation.flag}: ${violation.reason}`)
        .join("; ")}`,
    );
  }

  const tableEntries = Object.entries(table) as [
    DriverCapabilityFlag,
    CapabilityDetectionMechanism,
  ][];
  const declaresProbe = tableEntries.some(
    ([, mechanism]) => mechanism.detectionSource === "probed",
  );

  // Runs first: a channel that answers a name that cannot exist would accept every probe.
  if (declaresProbe) {
    const negativeControlName = descriptor.capabilityProbeNegativeControl;
    const negativeControlAnswer = await dispatchProbe(
      driverName,
      negativeControlName,
      boundExecutablePath,
      exchange,
    );
    if (negativeControlAnswer !== "unknown-name") {
      throw new CapabilityProbeNegativeControlError(driverName, negativeControlName);
    }
  }

  const detectionSource: Record<DriverCapabilityFlag, CapabilityDetectionSource> = {} as Record<
    DriverCapabilityFlag,
    CapabilityDetectionSource
  >;
  const withdrawnFlags: DriverCapabilityFlag[] = [];
  const diagnostics: CapabilityProbeDiagnostic[] = [];

  // Table order, one dispatch per distinct probe name (two flags sharing a name issue it once).
  const answersByProbeName = new Map<string, ProbeAnswer>();
  for (const [flag, mechanism] of tableEntries) {
    detectionSource[flag] = mechanism.detectionSource;
    if (mechanism.detectionSource !== "probed") {
      continue;
    }
    // All names must classify `accepted`; the first that does not withdraws the flag.
    for (const probeName of mechanism.probe.probeNames) {
      let answer = answersByProbeName.get(probeName);
      if (answer === undefined) {
        answer = await dispatchProbe(driverName, probeName, boundExecutablePath, exchange);
        answersByProbeName.set(probeName, answer);
      }
      if (answer === "accepted") {
        continue;
      }
      withdrawnFlags.push(flag);
      diagnostics.push({
        driverName,
        flag,
        probeName,
        disposition: answer === "unknown-name" ? "unknown-name" : "unrecognized-reply",
      });
      break;
    }
  }

  return Object.freeze({
    driverName,
    boundExecutablePath,
    detectionSource: Object.freeze(detectionSource),
    withdrawnFlags: Object.freeze(withdrawnFlags),
    diagnostics: Object.freeze(diagnostics),
  });
}

async function dispatchProbe(
  driverName: ProviderName,
  probeName: string,
  boundExecutablePath: string,
  exchange: CapabilityProbeExchange,
): Promise<ProbeAnswer> {
  // Screened here as well as at the table, so a name from anywhere else is refused too.
  assertProbeWireNameAdmissible(driverName, probeName);
  let payload: unknown;
  try {
    payload = await exchange({
      driverName,
      channel: PROVIDER_DRIVER_DESCRIPTORS[driverName].capabilityProbeChannel,
      probeName,
      boundExecutablePath,
    });
  } catch (cause) {
    throw new CapabilityProbeTransportError(driverName, probeName, { cause });
  }
  return PROVIDER_DRIVER_DESCRIPTORS[driverName].classifyCapabilityProbeReply(payload, probeName);
}

/**
 * Intersect a driver's declared matrix with what the probes found: `declared && !withdrawn`, since
 * a probe must never declare a capability the driver code does not implement. Returns a fresh
 * record because the matrix constant is frozen and shared.
 */
export function applyCapabilityDetection(
  declared: Readonly<Record<DriverCapabilityFlag, boolean>>,
  reading: CapabilityDetectionReading,
): Record<DriverCapabilityFlag, boolean> {
  const resolved: Record<DriverCapabilityFlag, boolean> = { ...declared };
  for (const flag of reading.withdrawnFlags) {
    resolved[flag] = false;
  }
  return resolved;
}
