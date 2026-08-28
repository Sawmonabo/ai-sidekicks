// Capability refresh — the CLI-version floor seam + the daemon-side refresh
// scheduler (Plan-005 Phase 3, T3.12 / P0-2 + P2-9).
//
// Two concerns share this module because they share one lifecycle moment: a
// capability READING. The floor seam decides whether a reading's version is
// admissible at all, and the scheduler decides when readings happen after
// attach. Both drivers' `capabilities.ts` modules consume the floor seam, and
// T3.23 re-points the *source* of the version string (to the in-band reading of
// the spawned process) without moving the comparison, which is why the compare
// lives here as a single exported source of truth rather than inside either
// driver tree (the driver trees stay import-independent of each other; both may
// import `provider/`-level daemon modules).
//
// -- P0-2: the CLI-version floor ------------------------------------------------
//
// `Spec-005 §Required Behavior`: every `getCapabilities` report carries a
// `DriverCliVersionReport { raw, semver }`; the daemon enforces a per-driver
// minimum-version floor mechanically at attach and refresh. The FLOOR VALUES
// are Spec-005's to set (`Spec-005 §Required Behavior`, "the floor is this
// spec's to set; the pin is the reference family's to record") — the constants
// below restate the ratified pair (Claude Code `2.1.234`, raised 2026-08-26;
// codex-cli `0.141.0`) and are deliberately NOT read from any reference file's
// pin, because a pin records what was measured, not what is supported.
//
// Failure semantics are fail-closed and two-coded
// (`docs/architecture/contracts/error-contracts.md §Driver`, both 409):
//   * `driver.cli_version_unparseable` — the raw string yields no canonical
//     semver. `DriverCliVersionReport.semver` is REQUIRED, so an unparseable
//     version is unrepresentable in the report shape; the refusal therefore
//     fires at report CONSTRUCTION (`parseCliVersionReport`), before any
//     report exists for a floor compare to accept.
//   * `driver.cli_version_below_floor` — the version parses cleanly but sits
//     below the configured floor; attach/refresh refuses. Distinct from
//     `version.floor_exceeded`, which governs client/event-envelope contract
//     floors, not provider CLI installs.
//
// A build AT or ABOVE the floor is admitted — above the measured pin included:
// the floor comparison is the whole of the version gate (`Spec-005 §Required
// Behavior`, the 2026-08-26 version-tolerance amendment).
//
// -- P2-9: the refresh scheduler ------------------------------------------------
//
// `Spec-005 §Resolved Questions and V1 Scope Decisions`: capability and
// account-state declarations refresh per runtime node on a bounded periodic
// cadence — 15 minutes in V1 — and may additionally update live where the
// provider pushes; correctness must not depend on push-only updates.
//
// The `CapabilityRefreshScheduler` is the named lifecycle owner that finding
// P2-9 demanded: without a file that starts and stops the poll, capability /
// CLI-floor / auth state could stay stale indefinitely. It is started on
// runtime-node attach and stopped on detach by the daemon provider subsystem
// (a sanctioned wiring call — this module claims no bootstrap-file ownership),
// holds one timer per runtime node, and on each tick drives every registered
// driver entry's `refreshDeclaration()` PAIRED with its zero-turn
// `probeAuth()`. The pairing is load-bearing (Codex round 5): auth state is
// NOT on `GetCapabilitiesResult` — capabilities/tools/`cliVersion` only — so a
// capabilities-only poll would leave admission auth state stale after a
// post-attach logout. With the pair, a post-attach logout surfaces within one
// cadence period; mid-run credential expiry stays the live-signal path
// (`RecoveryCondition` `reauth-required`, T3.14 P3-3), not this poll's.
//
// Change-detected emission (Codex round 6) is the WRITER's: `refreshDeclaration`
// declares through the T2.4 `DriverCapabilitiesWriter`, which compares the
// reconstructed snapshot against the cached rows and emits
// `runtime_node.capability_updated` only on an actual difference (CP-005-5 — no
// new event type). This scheduler deliberately carries no event sink and adds
// no second change detection: a no-op poll and an auth-only change append
// nothing to the timeline, because the auth-state record updates out-of-band of
// the event surface.
//
// The auth-state record lives HERE because no earlier task minted one: the
// scheduler is the daemon's per-(node, driver) auth-state owner, and run
// admission consumes it through `getAuthState` (`driver.not_authenticated` —
// the admission refusal itself is the admission seam's, not this module's).
// A thrown probe records `indeterminate` — fail closed, while staying
// distinguishable from `unauthenticated` (`DriverAuthProbeResult` doctrine).
//
// Refs: Plan-005 §Phase 3 / T3.12 (P0-2, P2-9), invariant I-005-2, CP-005-5,
// `Spec-005 §Required Behavior`, `Spec-005 §Resolved Questions and V1 Scope
// Decisions`, `docs/architecture/contracts/error-contracts.md §Driver`.

import semver from "semver";

import type { DriverAuthProbeResult, DriverCliVersionReport } from "@ai-sidekicks/contracts";

import type { DeclareDriverCapabilitiesResult } from "./driver-capabilities-writer.js";
import { CLI_VERSION_RAW_MAX_LEN } from "./provider-output-validation.js";

// --------------------------------------------------------------------------
// P0-2 — the per-driver floors (Spec-005 §Required Behavior sets these)
// --------------------------------------------------------------------------

/** The two drivers the V1 floor table answers for. */
export type FlooredDriverName = "claude" | "codex";

/**
 * The ratified V1 minimum-version floors, per driver.
 *
 * `Spec-005 §Required Behavior` sets these values (Claude Code raised
 * `2.1.198` → `2.1.234` on 2026-08-26; codex-cli unchanged). They are floors,
 * not pins: the oldest build each driver accepts, never the newest build
 * measured. T3.23 re-points where the compared version COMES FROM (the in-band
 * reading of the spawned process); the values and the comparison stay here.
 */
export const DRIVER_CLI_VERSION_FLOORS: Readonly<Record<FlooredDriverName, string>> = Object.freeze(
  {
    claude: "2.1.234",
    codex: "0.141.0",
  },
);

/**
 * Thrown when a provider-reported version string yields no canonical semantic
 * version. `code === "driver.cli_version_unparseable"`
 * (`docs/architecture/contracts/error-contracts.md §Driver`, 409 — the
 * blocked-until-repair family): capability attach/refresh fails closed until
 * the provider install is repaired.
 *
 * Leak-safe: the message is the stable canonical sentence; `fields` carries the
 * structured throw-site detail, with `raw` bounded to the same length cap the
 * persistence seam enforces (`CLI_VERSION_RAW_MAX_LEN`) so an adversarial
 * mega-string from a provider binary cannot ride the error object.
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

/**
 * Thrown when a cleanly-parsed provider version sits below the configured
 * per-driver floor. `code === "driver.cli_version_below_floor"`
 * (`docs/architecture/contracts/error-contracts.md §Driver`, 409): capability
 * attach/refresh fails closed until the provider install is upgraded.
 */
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

// The first `X.Y.Z` (with optional pre-release) token in a raw version string.
// Providers wrap the version in prose (`"codex-cli 0.149.1 (build …)"`,
// `"2.1.245 (Claude Code)"`), so extraction-then-validation is the contract's
// `raw` → `semver` derivation. Deliberately NO `semver.coerce`: coercion turns
// `"v2"` into `2.0.0` and `"2.1"` into `2.1.0` — fabricated precision the
// fail-closed doctrine forbids; a partial version is unparseable here.
const SEMVER_TOKEN_PATTERN = /\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?/;

/**
 * Derive a `DriverCliVersionReport` from a provider-reported raw version
 * string, or refuse fail-closed.
 *
 * The report shape makes unparsed-but-attached state unrepresentable (`semver`
 * is required), so THIS function is where `driver.cli_version_unparseable`
 * fires — before any report exists. `raw` is preserved verbatim on the report
 * (bounds are the persistence seam's, `assertValidCliVersionReport`); `semver`
 * is the canonical form `semver.valid` returns for the extracted token.
 *
 * T3.23 feeds this from the in-band reading of the spawned process (Claude
 * `get_binary_version`, the Codex `initialize` `userAgent`); the derivation
 * does not move when the source does.
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
 * The floor gate (P0-2): refuse a report whose version sits below the
 * configured per-driver floor.
 *
 * The comparison is the WHOLE of the version gate — at or above the floor the
 * report passes, above the measured pin included (`Spec-005 §Required
 * Behavior`, 2026-08-26). A report whose `semver` member is not canonical
 * (possible only via an untyped boundary — well-behaved callers construct
 * reports through `parseCliVersionReport`) refuses as unparseable rather than
 * letting `semver.lt` throw a raw `TypeError` out of the gate.
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

// --------------------------------------------------------------------------
// P2-9 — the refresh scheduler
// --------------------------------------------------------------------------

/**
 * The V1 refresh cadence — 15 minutes, per `Spec-005 §Resolved Questions and
 * V1 Scope Decisions`. A constant rather than a constructor knob: the cadence
 * is a ratified V1 decision, and a configurable interval would be a second
 * place for it to be wrong. Tests drive the tick with fake timers.
 */
export const CAPABILITY_REFRESH_INTERVAL_MS: number = 15 * 60 * 1000;

/**
 * One driver's refresh pair on one runtime node.
 *
 * Both members are injected closures rather than a `ProviderDriver` reference:
 * the scheduler needs exactly these two operations, the driver classes widen
 * toward the full contract across sibling tasks, and a two-function seam keeps
 * this module testable without a live provider process.
 */
export interface CapabilityRefreshDriverEntry {
  /** Canonical driver id (`"claude"` / `"codex"`) — the auth-record key. */
  readonly driverName: string;
  /**
   * Re-read the declaration and declare it through the T2.4 writer
   * (`refreshCodexCapabilities` / `ClaudeCapabilityReporter.refreshDeclaration`).
   * The writer owns change detection and emission (CP-005-5); the scheduler
   * reacts to the discriminant not at all.
   */
  readonly refreshDeclaration: () => Promise<DeclareDriverCapabilitiesResult>;
  /** The zero-turn authentication probe, paired with every refresh. */
  readonly probeAuth: () => Promise<DriverAuthProbeResult>;
}

/** What the daemon provider subsystem hands the scheduler at node attach. */
export interface CapabilityRefreshNodeRegistration {
  readonly nodeId: string;
  readonly drivers: readonly CapabilityRefreshDriverEntry[];
}

/**
 * The per-(node, driver) auth-state record run admission consumes.
 *
 * `detail` is the probe's knowingly PII-bearing operator diagnostic
 * (`DriverAuthProbeResult.detail`) — held in memory only, never persisted or
 * evented by this module, per that field's Spec-022 scope note.
 */
export interface DriverAuthStateRecord {
  readonly status: DriverAuthProbeResult["status"];
  readonly detail?: string | undefined;
  /** When the probe answered (epoch ms) — staleness is the reader's judgment. */
  readonly observedAtMs: number;
}

/**
 * A structured, non-throwing report of a failed poll leg. The scheduler never
 * lets one driver's failure kill the timer or a sibling driver's poll; it
 * reports here and keeps polling (a below-floor install can be upgraded, and
 * the next tick sees the repair).
 */
export interface CapabilityRefreshDiagnostic {
  readonly nodeId: string;
  readonly driverName: string;
  readonly leg: "capability-refresh" | "auth-probe";
  /** The typed error's registered code, where the failure carried one. */
  readonly code?: string | undefined;
  readonly message: string;
}

export interface CapabilityRefreshSchedulerDependencies {
  /** Structured failure reporting; absent means failures are silently retried
   * next tick (the record still updates fail-closed either way). */
  readonly onDiagnostic?: (diagnostic: CapabilityRefreshDiagnostic) => void;
}

interface ScheduledNode {
  readonly registration: CapabilityRefreshNodeRegistration;
  readonly timer: NodeJS.Timeout;
}

/**
 * The poll-lifecycle owner (P2-9): one timer per attached runtime node, each
 * tick driving every registered driver's refresh + auth-probe pair.
 *
 * Lifecycle: `startForNode` on attach, `stopForNode` on detach, `shutdown` at
 * daemon shutdown — after any of which the node's timer is cleared and no
 * further polls fire (no timer leaks). `refreshNow` is the sanctioned lever
 * for provider-push updates: push MAY tighten freshness, but correctness never
 * depends on it (`Spec-005 §Resolved Questions and V1 Scope Decisions`).
 */
export class CapabilityRefreshScheduler {
  readonly #nodes: Map<string, ScheduledNode> = new Map();
  // nodeId → driverName → latest probe record. Dropped with the node on
  // detach: a stale record surviving re-attach would answer admission with
  // another node-lifetime's credential state.
  readonly #authStates: Map<string, Map<string, DriverAuthStateRecord>> = new Map();
  // Re-entrancy guard: a tick that outlives the interval (hung provider) must
  // not stack a second concurrent poll of the same node behind it.
  readonly #pollsInFlight: Set<string> = new Set();
  readonly #onDiagnostic: ((diagnostic: CapabilityRefreshDiagnostic) => void) | undefined;

  constructor(dependencies: CapabilityRefreshSchedulerDependencies = {}) {
    this.#onDiagnostic = dependencies.onDiagnostic;
  }

  /**
   * Start (or restart) the node's poll timer. Idempotent per node: a re-attach
   * replaces the previous registration and timer rather than stacking a second
   * one. The first poll fires one full cadence after attach — the attach path
   * itself performs the initial declaration through registry registration, so
   * an immediate poll here would only duplicate it.
   */
  startForNode(registration: CapabilityRefreshNodeRegistration): void {
    this.stopForNode(registration.nodeId);
    const timer = setInterval(() => {
      void this.#pollNode(registration.nodeId);
    }, CAPABILITY_REFRESH_INTERVAL_MS);
    // The daemon's shutdown ordering owns process lifetime; a refresh timer
    // must never be what keeps the process alive.
    timer.unref();
    this.#nodes.set(registration.nodeId, { registration, timer });
  }

  /** Stop the node's timer and drop its auth records (detach semantics). */
  stopForNode(nodeId: string): void {
    const scheduled = this.#nodes.get(nodeId);
    if (scheduled !== undefined) {
      clearInterval(scheduled.timer);
      this.#nodes.delete(nodeId);
    }
    this.#authStates.delete(nodeId);
  }

  /** Clear every node's timer (daemon shutdown — no timer leaks). */
  shutdown(): void {
    for (const nodeId of [...this.#nodes.keys()]) {
      this.stopForNode(nodeId);
    }
  }

  /**
   * Run one poll of the node now, outside the cadence — the provider-push
   * lever. Shares the in-flight guard with the timer path, so a push landing
   * mid-poll coalesces instead of stacking.
   */
  async refreshNow(nodeId: string): Promise<void> {
    await this.#pollNode(nodeId);
  }

  /** The admission-side read of the latest probe result for one driver. */
  getAuthState(nodeId: string, driverName: string): DriverAuthStateRecord | undefined {
    return this.#authStates.get(nodeId)?.get(driverName);
  }

  async #pollNode(nodeId: string): Promise<void> {
    if (this.#pollsInFlight.has(nodeId)) {
      return;
    }
    const scheduled = this.#nodes.get(nodeId);
    if (scheduled === undefined) {
      return;
    }
    this.#pollsInFlight.add(nodeId);
    try {
      await Promise.all(
        scheduled.registration.drivers.map((entry) => this.#pollDriver(nodeId, entry)),
      );
    } finally {
      this.#pollsInFlight.delete(nodeId);
    }
  }

  async #pollDriver(nodeId: string, entry: CapabilityRefreshDriverEntry): Promise<void> {
    // The PAIR is dispatched together and settles independently: a refresh
    // refusal (e.g. a below-floor install detected mid-lifetime) must not
    // suppress the auth reading, nor the reverse.
    const [refreshOutcome, probeOutcome] = await Promise.allSettled([
      entry.refreshDeclaration(),
      entry.probeAuth(),
    ]);

    if (refreshOutcome.status === "rejected") {
      this.#reportFailure(nodeId, entry.driverName, "capability-refresh", refreshOutcome.reason);
    }
    // A fulfilled refresh needs no reaction here: the writer already decided
    // declared/updated/noop and emitted (or deliberately did not) — CP-005-5.

    if (probeOutcome.status === "fulfilled") {
      this.#recordAuthState(nodeId, entry.driverName, {
        status: probeOutcome.value.status,
        detail: probeOutcome.value.detail,
        observedAtMs: Date.now(),
      });
    } else {
      // A THROWN probe is distinct from a probe that answered
      // `indeterminate`, but admission must treat both fail-closed — record
      // `indeterminate` so the record never silently retains a stale
      // `authenticated` past a broken probe surface.
      this.#recordAuthState(nodeId, entry.driverName, {
        status: "indeterminate",
        observedAtMs: Date.now(),
      });
      this.#reportFailure(nodeId, entry.driverName, "auth-probe", probeOutcome.reason);
    }
  }

  #recordAuthState(nodeId: string, driverName: string, record: DriverAuthStateRecord): void {
    // A record for a node that detached while its poll was in flight must not
    // resurrect the node's map — detach dropped it deliberately.
    if (!this.#nodes.has(nodeId)) {
      return;
    }
    let nodeRecords = this.#authStates.get(nodeId);
    if (nodeRecords === undefined) {
      nodeRecords = new Map();
      this.#authStates.set(nodeId, nodeRecords);
    }
    nodeRecords.set(driverName, record);
  }

  #reportFailure(
    nodeId: string,
    driverName: string,
    leg: CapabilityRefreshDiagnostic["leg"],
    reason: unknown,
  ): void {
    if (this.#onDiagnostic === undefined) {
      return;
    }
    const code =
      typeof reason === "object" &&
      reason !== null &&
      "code" in reason &&
      typeof (reason as { code: unknown }).code === "string"
        ? (reason as { code: string }).code
        : undefined;
    const message = reason instanceof Error ? reason.message : String(reason);
    this.#onDiagnostic({ nodeId, driverName, leg, code, message });
  }
}
