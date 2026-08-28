// Codex capability declaration + refresh seam (Plan-005 Phase 3, T3.3).
//
// This module answers ONE question for the Codex driver: which capabilities
// does it deliver at the driver boundary? It composes that answer, together
// with T3.4's per-tool census, into the V1 `GetCapabilitiesResult` wrapper the
// registry (T2.3) caches and the writer (T2.4) persists.
//
// -- I-005-2 (undeclared capability = unsupported), realized statically --
//
// `Record<DriverCapabilityFlag, boolean>` is TOTAL: a flag added to the
// contract's canonical `DRIVER_CAPABILITY_FLAGS` tuple and not answered here
// is a COMPILE error, and a flag answered here that the contract does not
// name is an excess-property error. There is therefore no "absent flag" state
// for this driver to be inferred from — which is exactly what the invariant
// asks for, and why no runtime `Object.keys` reconciliation is written here.
// The runtime halves live where the untyped boundaries are:
// `ProviderRegistry.checkCapability` fail-closes on `!== true`, and
// `assertValidCapabilityFlags` proves exact cardinality at the write seam.
//
// -- `cliVersion` is threaded, never fabricated — floored, and READ FROM THE
//    SPAWNED BUILD (T3.12 + T3.23) --
//
// `GetCapabilitiesResult.cliVersion` is REQUIRED and must describe the
// provider binary this daemon actually spawns. Since T3.23 that is structural
// rather than a convention: this module takes a `SpawnedProviderVersionReading`
// — the in-band reading of the process started at a resolved executable path
// (`../../version-gate.js`) — and threads its report through verbatim. A
// declaration composed from a version that did NOT come from the spawned build
// is therefore unrepresentable, which is the half of I-005-10 a bare report
// argument left to caller discipline.
//
// The report is still passed through with no parsing, no normalization, and no
// invented version, and the T3.12 floor is still enforced HERE before
// composing: `getCodexCapabilities` refuses a below-floor reading fail-closed
// (`driver.cli_version_below_floor`), so both attach (the registry's
// registration read) and refresh (the scheduler-driven re-read) hit the gate
// through the one composition path. The read path gates too; the compare is
// pure and idempotent, so gating at both moments closes both doors rather than
// duplicating a decision. The compare and the ratified floor value live in
// `../../capability-refresh.js` — the single source of truth T3.23 re-points at
// the in-band reading without moving the comparison.
//
// -- The refresh seam is an emission seam, not a scheduler --
//
// `refreshCodexCapabilities` recomposes the report and hands it to the T2.4
// writer, whose `declare` performs the change detection and emits
// `runtime_node.capability_declared` / `runtime_node.capability_updated` (an
// EXISTING `Spec-006 §Runtime Node Lifecycle (runtime_node_lifecycle)` surface; the payload's
// `previousState` / `newState` carry the wrapper-shape contents) — CP-005-5,
// no new event type. The emission discriminant is returned to the caller
// unchanged.
//
// What this function deliberately does NOT own: the poll timer, the 15-minute
// cadence, the paired `probeAuth()`, and node attach/detach lifecycle. Those
// belong to the `CapabilityRefreshScheduler` (`../../capability-refresh.js`,
// T3.12 P2-9), which drives THIS seam on the bounded cadence.
// Change detection is likewise NOT re-implemented here: duplicating the
// writer's snapshot compare would create a second, divergable answer to
// "did the capabilities change?".
//
// The writer is injected as `Pick<DriverCapabilitiesWriter, "declare">` rather
// than as a locally-invented port interface: a `Pick` of the real class drifts
// into a compile error the moment the writer's signature moves, while a
// hand-written mirror interface would silently keep compiling against a stale
// shape. It also keeps a test's typed fake honest without a new abstraction.
//
// SCOPE BOUNDARY: the MCP idempotency floor + server-status census (T3.13)
// EXTEND this driver in a sibling PR-B task and are NOT implemented here; the
// CLI-version floor and the refresh cadence landed with T3.12 (the floor
// enforced below, the cadence in `../../capability-refresh.js`). `transcript_replay` is not declared
// because it is not a member of the current canonical flag set; it lands with
// its own task later in this phase, and the `Record` totality above makes
// adding it a compile error until it is answered.
//
// Spec coverage: `Spec-005 §Required Behavior` (drivers declare capability
// flags; the runtime treats undeclared capabilities as unsupported),
// `Spec-005 §Per-Driver Capability Matrix` (the Codex column below).
//
// Refs: Plan-005 §Phase 3 / T3.3, invariants I-005-2 and I-005-3, CP-005-5,
// `Spec-006 §Runtime Node Lifecycle (runtime_node_lifecycle)`,
// `docs/reference/provider-wire/codex.md` (wire surface at the pinned
// `codex-cli` build; regenerate-don't-transcribe).

import type {
  DriverCapabilityFlag,
  DriverCliVersionReport,
  GetCapabilitiesResult,
} from "@ai-sidekicks/contracts";

import { assertCliVersionMeetsFloor } from "../../capability-refresh.js";
import type {
  DeclareDriverCapabilitiesInput,
  DeclareDriverCapabilitiesResult,
  DriverCapabilitiesWriter,
} from "../../driver-capabilities-writer.js";
import type { SpawnedProviderVersionReading } from "../../version-gate.js";

import { getCodexToolMetadata } from "./tools.js";

/** Canonical driver id for Codex — the `driver_*` table key and registry id. */
export const CODEX_DRIVER_NAME = "codex" as const;

/**
 * The driver's advertised capability-contract version.
 *
 * Per `Spec-005 §Default Behavior` this is a CHANGE-DETECTION token, not a
 * negotiated version: nothing branches on its value. It moves when the shape
 * of what this driver advertises changes, which is what makes a cached
 * snapshot recognizably stale.
 */
export const CODEX_CAPABILITY_CONTRACT_VERSION: string = "1.0.0";

/**
 * The Codex column of `Spec-005 §Per-Driver Capability Matrix`.
 *
 * A flag is `true` only where the DRIVER delivers the capability at its own
 * boundary. A capability supplied by the orchestration layer above the driver
 * keeps its flag `false` — the flag is a statement about this driver, not
 * about the product.
 */
export const CODEX_CAPABILITY_FLAGS: Readonly<Record<DriverCapabilityFlag, boolean>> =
  Object.freeze({
    // Thread resumption is a first-class protocol operation.
    resume: true,
    // Native mid-turn steering exists on the wire (`turn/steer`).
    steer: true,
    // The provider raises typed requests the daemon answers mid-turn
    // (approval + user-input round trips).
    interactive_requests: true,
    // The provider can invoke MCP server tools. Declares invocation support
    // only — not that every server's tools are enumerable to the daemon.
    mcp: true,
    // Tool invocations are surfaced as discrete, correlatable wire items.
    tool_calls: true,
    // FALSE: the provider does not expose reasoning/thinking tokens on this
    // transport. The timeline renders the reasoning surface as unavailable —
    // an absence, not a degradation (`Spec-005 §Fallback Behavior`).
    reasoning_stream: false,
    // Model and effort are accepted as per-turn overrides on turn start.
    model_mutation: true,
    // The turn accepts a caller-supplied output schema.
    structured_output: true,
    // Rewind is delivered by forking a thread at an inclusive turn boundary.
    // Non-probeable at the parameter level, so it resolves from the matrix;
    // an invocation against a build lacking the boundary field refuses as
    // `driver.capability_unsupported` rather than rewinding to the wrong
    // position (Plan-005 T3.24).
    rollback: true,
    // Durable per-thread goal set/clear operations exist on the wire.
    session_goals: true,
    // Daemon-registered tools can be surfaced to the model and dispatched
    // back to the daemon for execution.
    callback_tools: true,
    // Peer agents can be spawned, messaged, and closed from within a turn.
    subagents: true,
    // FALSE: no native spawn-time hard budget cap. Consumed fail-closed by
    // Spec-016's native-cap unpriced-family escape, which refuses reservation
    // on a capless leg rather than admitting an unbounded run
    // (`orchestration.budget_exhausted`, `reason: 'driver_capless'`).
    cost_cap: false,
  });

/**
 * Compose the Codex `getCapabilities()` report.
 *
 * Synchronous and side-effect-free: every input is either a module constant or
 * the caller-supplied `cliVersion`, so there is nothing to await.
 * `ProviderDriver.getCapabilities()` returns a Promise; T3.1's Codex driver
 * wraps this call, keeping the async boundary where the interface puts it
 * instead of manufacturing one here.
 *
 * Every returned object is FRESH. Handing back the module constants by
 * reference would let one caller's mutation corrupt every later declaration —
 * the same defensive-clone doctrine `ProviderRegistry` applies when it caches
 * a capability snapshot.
 *
 * The one thing that CAN fail is the T3.12 floor gate: a below-floor (or
 * non-canonical) reading REFUSES here — throwing
 * `DriverCliVersionBelowFloorError` / `DriverCliVersionUnparseableError` —
 * before any report is composed, so neither attach nor refresh can cache a
 * declaration for a build the daemon does not support.
 *
 * @param reading The in-band reading of the build this node spawned
 *   (`readSpawnedProviderVersion`). Its report is threaded verbatim; see the
 *   file header on why it is never invented and why a bare report is not
 *   accepted here.
 */
export function getCodexCapabilities(
  reading: SpawnedProviderVersionReading,
): GetCapabilitiesResult {
  // A reading taken from ANOTHER driver's build would compose this driver's
  // flags against a foreign version — a daemon wiring fault, not provider
  // misbehaviour, so it is an internal-invariant `Error` rather than a typed
  // provider refusal.
  if (reading.driverName !== CODEX_DRIVER_NAME) {
    throw new Error(
      `getCodexCapabilities: refusing a spawned-version reading taken from driver '${reading.driverName}'`,
    );
  }
  const cliVersion: DriverCliVersionReport = reading.report;
  assertCliVersionMeetsFloor(CODEX_DRIVER_NAME, cliVersion);
  return {
    capabilities: {
      flags: { ...CODEX_CAPABILITY_FLAGS },
      contractVersion: CODEX_CAPABILITY_CONTRACT_VERSION,
    },
    tools: getCodexToolMetadata(),
    cliVersion: { raw: cliVersion.raw, semver: cliVersion.semver },
  };
}

/**
 * The write seam this module declares through — structurally a
 * `DriverCapabilitiesWriter`, narrowed to the one method used.
 */
export type DriverCapabilityDeclarationSink = Pick<DriverCapabilitiesWriter, "declare">;

/** Caller-supplied context for one capability declaration/refresh. */
export interface CodexCapabilityRefreshInput {
  /** Session partition the capability event is appended to. */
  readonly sessionId: string;
  /** Runtime node the declared capabilities describe. */
  readonly nodeId: string;
  /**
   * The in-band reading of the spawned provider build (T3.23). A REFRESH takes
   * a NEW reading rather than replaying the attach-time one — that is what
   * makes a mid-lifetime replacement detectable, and it is why the scheduler's
   * entry closes over a reader rather than over a value.
   */
  readonly reading: SpawnedProviderVersionReading;
  /** EventEnvelope actor; omitted means the system actor. */
  readonly actor?: string | null;
}

/**
 * Declare (or re-declare) Codex capabilities through the T2.4 writer.
 *
 * Returns the writer's own emission discriminant unchanged — `"declared"` on
 * the first write, `"updated"` when the snapshot actually differs, `"noop"`
 * when it does not. A `"noop"` appends nothing to the timeline, which is what
 * makes a periodic refresh safe to run without manufacturing false timeline
 * changes (CP-005-5, change-detected emission).
 */
export async function refreshCodexCapabilities(
  sink: DriverCapabilityDeclarationSink,
  input: CodexCapabilityRefreshInput,
): Promise<DeclareDriverCapabilitiesResult> {
  const declareInput: DeclareDriverCapabilitiesInput = {
    sessionId: input.sessionId,
    nodeId: input.nodeId,
    driverName: CODEX_DRIVER_NAME,
    result: getCodexCapabilities(input.reading),
    // Spread conditionally: under `exactOptionalPropertyTypes` an explicit
    // `actor: undefined` is NOT the same as an absent `actor`, and the writer
    // defaults an ABSENT actor to the system actor.
    ...(input.actor === undefined ? {} : { actor: input.actor }),
  };
  return sink.declare(declareInput);
}
