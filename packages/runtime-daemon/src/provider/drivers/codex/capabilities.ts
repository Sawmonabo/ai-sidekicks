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
// -- `cliVersion` is threaded, never fabricated --
//
// `GetCapabilitiesResult.cliVersion` is REQUIRED and must describe the
// provider binary this daemon actually spawns. Reading it in-band, and the
// mechanical minimum-version floor that refuses a below-floor build, are
// Plan-005 T3.12 / T3.23 (PR-B). This module therefore takes the report as a
// REQUIRED input and passes it through VERBATIM — no parsing, no
// normalization, no comparison. PR-B re-points the source without changing
// this module's shape, and there is no code path here that can invent a
// version for the fail-closed floor gate to accept.
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
// belong to the `CapabilityRefreshScheduler` (Plan-005 T3.12, P2-9, PR-B).
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
// SCOPE BOUNDARY: the CLI-version floor and the refresh cadence (T3.12) and
// the MCP idempotency floor + server-status census (T3.13) EXTEND this driver
// in PR-B and are NOT implemented here. `transcript_replay` is not declared
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

import type {
  DeclareDriverCapabilitiesInput,
  DeclareDriverCapabilitiesResult,
  DriverCapabilitiesWriter,
} from "../../driver-capabilities-writer.js";

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
 * the caller-supplied `cliVersion`, so there is nothing to await and nothing to
 * fail. `ProviderDriver.getCapabilities()` returns a Promise; T3.1's Codex
 * driver wraps this call, keeping the async boundary where the interface puts
 * it instead of manufacturing one here.
 *
 * Every returned object is FRESH. Handing back the module constants by
 * reference would let one caller's mutation corrupt every later declaration —
 * the same defensive-clone doctrine `ProviderRegistry` applies when it caches
 * a capability snapshot.
 *
 * @param cliVersion The report for the provider binary this node will spawn.
 *   Passed through verbatim; see the file header on why it is never invented.
 */
export function getCodexCapabilities(cliVersion: DriverCliVersionReport): GetCapabilitiesResult {
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
  /** Version report for the spawned provider binary; threaded through verbatim. */
  readonly cliVersion: DriverCliVersionReport;
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
    result: getCodexCapabilities(input.cliVersion),
    // Spread conditionally: under `exactOptionalPropertyTypes` an explicit
    // `actor: undefined` is NOT the same as an absent `actor`, and the writer
    // defaults an ABSENT actor to the system actor.
    ...(input.actor === undefined ? {} : { actor: input.actor }),
  };
  return sink.declare(declareInput);
}
