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
// -- Detection sources (T3.24) --
//
// The declaration is the matrix INTERSECTED with what a zero-turn probe found
// on the installed build, and every flag reports which of the two decided it.
// `../../capability-probe.ts` owns the per-driver mechanism table, the probes,
// their negative control, and the withdraw-only resolution; this module owns
// the ORDERING — floor first, probe second — so no probe is ever issued against
// a build the daemon has already refused. `detectionSource` is composed only
// here, on the live read; the T2.4 writer's `hydrate()` reconstruction leaves it
// absent, which is specified to read as cache reconstruction rather than as
// unknown provenance.
//
// SCOPE BOUNDARY: the MCP idempotency floor + server-status census (T3.13)
// EXTEND this driver in a sibling PR-B task and are NOT implemented here; the
// CLI-version floor and the refresh cadence landed with T3.12 (the floor
// enforced below, the cadence in `../../capability-refresh.js`). `transcript_replay`
// is answered `false` below, and that is a SCOPE BOUNDARY rather than a verdict:
// this provider's injection surface is real, but the replay leg that drives it —
// and the post-replay assertion that is the only admissible evidence it worked —
// is authored by a later task in this phase, and a flag declared ahead of the
// code it gates is a promise no caller can keep. The `supported = 0` row
// backfilled at migration 0012 matches this declaration until both flip together.
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
  ProviderModel,
} from "@ai-sidekicks/contracts";

import {
  applyCapabilityDetection,
  readCapabilityDetection,
  type CapabilityDetectionReading,
  type CapabilityProbeExchange,
} from "../../capability-probe.js";
import {
  assertCliVersionMeetsFloor,
  emitCapabilityDetectionDiagnostics,
} from "../../capability-refresh.js";
import type {
  DeclareDriverCapabilitiesInput,
  DeclareDriverCapabilitiesResult,
  DriverCapabilitiesWriter,
} from "../../driver-capabilities-writer.js";
import type { DriverDiagnosticsEmitter } from "../../driver-diagnostics.js";
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
    // a build that REFUSES the boundary field is classified at the
    // `rollbackTo` fork dispatch as `driver.capability_unsupported` rather
    // than surfacing as an opaque provider fault (Plan-005 T3.24). A build
    // that IGNORES it instead forks the whole thread and is answered by that
    // leg's turn-ledger check, which is a diagnostic and not a refusal.
    rollback: true,
    // Durable per-thread goal set/clear operations exist on the wire.
    session_goals: true,
    // Daemon-registered tools can be surfaced to the model and dispatched
    // back to the daemon for execution.
    callback_tools: true,
    // Peer agents can be spawned, messaged, and closed from within a turn.
    subagents: true,
    // FALSE pending the replay leg — see the scope boundary in the header.
    transcript_replay: false,
    // FALSE: no native spawn-time hard budget cap. Consumed fail-closed by
    // Spec-016's native-cap unpriced-family escape, which refuses reservation
    // on a capless leg rather than admitting an unbounded run
    // (`orchestration.budget_exhausted`, `reason: 'driver_capless'`).
    cost_cap: false,
    // Participant-triggered compaction is a first-class client-request method
    // (`thread/compact/start`), and the compaction it performs announces itself
    // with the same typed frame an unsolicited compaction does — which is the
    // evidence the operation settles on.
    context_compaction: true,
    // The provider publishes an enumerable skill surface (`skills/list`) and
    // signals its own invalidation, so the enumeration is a live read this
    // driver can take and re-take rather than a catalog it would have to cache.
    provider_commands: true,
    // FALSE: this provider publishes no accelerated-output axis at all — its
    // generated method root contains no speed or fast-output member anywhere —
    // so nothing is emulated onto it. A complete declaration, not a gap: the
    // analog is the per-turn `model` / `effort` axis, which this driver DOES
    // carry and declares through `model_mutation` above.
    output_speed: false,
  });

/**
 * The Codex column of the output-speed value vocabulary.
 *
 * EMPTY, and that is the complete declaration the `false` flag above implies:
 * `Spec-005 §The output-speed axis` makes an absent or empty vocabulary the
 * signal that the axis is unsettable, so a caller carrying an `outputSpeed`
 * refuses fail-closed rather than forwarding an unvalidated value to a provider
 * that has no such surface.
 */
export const CODEX_OUTPUT_SPEED_LEVELS: readonly string[] = Object.freeze([]);

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
  detection: CapabilityDetectionReading,
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
  if (detection.driverName !== CODEX_DRIVER_NAME) {
    throw new Error(
      `getCodexCapabilities: refusing a detection reading taken from driver '${detection.driverName}'`,
    );
  }
  // The version and the flags must describe ONE executable. Both readings carry
  // the path the version handshake resolved, so this is a comparison rather than
  // a re-resolution — and it catches the case a re-resolution would create: a
  // `PATH` change or an installer swap between the two reads, which would
  // otherwise compose probed flags for one build onto the version of another
  // with nothing downstream able to tell.
  if (detection.boundExecutablePath !== reading.resolvedExecutablePath) {
    throw new Error(
      "getCodexCapabilities: refusing a detection reading bound to a different executable than the version reading",
    );
  }
  const cliVersion: DriverCliVersionReport = reading.report;
  assertCliVersionMeetsFloor(CODEX_DRIVER_NAME, cliVersion);
  return {
    capabilities: {
      flags: applyCapabilityDetection(CODEX_CAPABILITY_FLAGS, detection),
      contractVersion: CODEX_CAPABILITY_CONTRACT_VERSION,
    },
    tools: getCodexToolMetadata(),
    cliVersion: { raw: cliVersion.raw, semver: cliVersion.semver },
    // Fresh, for the same reason every other member is: the reading's record is
    // frozen and shared, and a caller that mutates a reply must not rewrite the
    // next caller's provenance.
    detectionSource: { ...detection.detectionSource },
    // Present iff the flag is, which on this driver it never is — so the member
    // is omitted rather than served as an empty array. Omission and emptiness
    // mean the same thing to `Spec-005 §The output-speed axis` (the axis is
    // unsettable), and omitting is the honest encoding of a driver that
    // publishes no such axis: an empty array would read as a vocabulary that
    // happens to have no members today.
    ...(CODEX_CAPABILITY_FLAGS.output_speed
      ? { outputSpeedLevels: [...CODEX_OUTPUT_SPEED_LEVELS] }
      : {}),
  };
}

/**
 * Take one detection reading for the Codex build described by `reading`.
 *
 * ORDERING IS THE CONTRACT, and it is why this wrapper exists rather than
 * callers invoking `readCapabilityDetection` directly. The floor gate runs
 * FIRST: `Spec-005` refuses every use of a below-floor build beyond the version
 * handshake itself, and a probe is such a use. A build this daemon has already
 * refused is therefore never asked what it can do.
 *
 * The read is BOUND to the executable the version handshake resolved, taken
 * from that same reading rather than resolved again, so the composition step
 * can check that the version and the flags describe one build.
 *
 * Withdrawals are reported here rather than at the refresh entry point, so
 * every path that takes a detection reading — attach and refresh alike — meters
 * the same fact through the same counter.
 */
export async function readCodexCapabilityDetection(
  reading: SpawnedProviderVersionReading,
  exchange: CapabilityProbeExchange,
  diagnostics: DriverDiagnosticsEmitter,
): Promise<CapabilityDetectionReading> {
  if (reading.driverName !== CODEX_DRIVER_NAME) {
    throw new Error(
      `readCodexCapabilityDetection: refusing a spawned-version reading taken from driver '${reading.driverName}'`,
    );
  }
  assertCliVersionMeetsFloor(CODEX_DRIVER_NAME, reading.report);
  const detection = await readCapabilityDetection({
    driverName: CODEX_DRIVER_NAME,
    boundExecutablePath: reading.resolvedExecutablePath,
    exchange,
  });
  emitCapabilityDetectionDiagnostics(diagnostics, detection);
  return detection;
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
  /**
   * The zero-turn probe transport (T3.24). Held as the SEAM rather than as a
   * reading, because the cadence must RE-PROBE: each refresh takes a new
   * detection reading through this exchange for the same reason it takes a new
   * version reading, and a caller that passed a value could replay attach-time
   * provenance for a build that has since been replaced.
   */
  readonly probe: CapabilityProbeExchange;
  /**
   * The daemon diagnostic channel the detection read reports withdrawals on.
   * REQUIRED for the same reason the refresh scheduler's emitter is: a flag a
   * build silently stopped carrying is exactly the class of condition the
   * closed-kind-plus-counter pairing exists to keep metered, and an optional
   * emitter would let a whole node's withdrawals go uncounted.
   */
  readonly diagnostics: DriverDiagnosticsEmitter;
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
  const detection = await readCodexCapabilityDetection(
    input.reading,
    input.probe,
    input.diagnostics,
  );
  const declareInput: DeclareDriverCapabilitiesInput = {
    sessionId: input.sessionId,
    nodeId: input.nodeId,
    driverName: CODEX_DRIVER_NAME,
    result: getCodexCapabilities(input.reading, detection),
    // Spread conditionally: under `exactOptionalPropertyTypes` an explicit
    // `actor: undefined` is NOT the same as an absent `actor`, and the writer
    // defaults an ABSENT actor to the system actor.
    ...(input.actor === undefined ? {} : { actor: input.actor }),
  };
  return sink.declare(declareInput);
}

// --------------------------------------------------------------------------
// The model catalog (T3.12 C-8)
// --------------------------------------------------------------------------

/**
 * One declared catalog entry, frozen at construction.
 *
 * `capabilities` is `[]` by CONSTRUCTION rather than by omission — the helper
 * takes no argument for it, so no declaration can populate a member the corpus
 * registers no vocabulary for and nothing reads. This provider's per-model
 * auxiliary axes (`inputModalities`, `additionalSpeedTiers`, `modelSpecialty`,
 * `supportsPersonality`) are recorded in the catalog's provenance note rather
 * than flattened into it: one shared string list cannot carry both a modality
 * and a speed tier and still mean anything to a reader.
 */
function declaredCodexModel(
  id: string,
  name: string,
  effortLevels: readonly string[],
): ProviderModel {
  return Object.freeze({
    id,
    name,
    capabilities: freezeDeclaredModelArray([]),
    effortLevels: freezeDeclaredModelArray([...effortLevels]),
  });
}

/**
 * Freeze one nested catalog array WITHOUT widening its declared type.
 *
 * `Object.freeze` on the entry alone is shallow: it stops `entry.effortLevels =
 * […]` and does nothing about `entry.effortLevels.push(…)`, so a process-wide
 * constant re-exported from this driver's barrel was one `push` away from being
 * rewritten for every later caller. `ProviderModel` declares these members as
 * MUTABLE `string[]`, and this returns the same declared type rather than
 * `readonly string[]` on purpose: making the contract type deep-readonly would
 * ripple through every driver-constructed catalog and every normalizer that
 * builds one, to fix a hazard that only exists for the two shared constants.
 * The freeze is therefore a runtime property of these declarations, enforced by
 * a mutation-attempt test rather than by the type.
 */
function freezeDeclaredModelArray(values: string[]): string[] {
  Object.freeze(values);
  return values;
}

/**
 * The two SHARED effort vocabularies, by model generation.
 *
 * The pinned build publishes THREE distinct lists across its eight models; the
 * third belongs to exactly one row and is written inline there rather than
 * named here, because a constant naming one model's list would read as a
 * generation. The count is stated because it is the fact that makes the levels
 * per-model rather than per-provider — a provider-wide list would be wrong for
 * some model in the very same reply.
 */
const CODEX_EXTENDED_EFFORT_LEVELS: readonly string[] = Object.freeze([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);
const CODEX_BASE_EFFORT_LEVELS: readonly string[] = Object.freeze([
  "low",
  "medium",
  "high",
  "xhigh",
]);

/**
 * GOLDEN VECTOR — the Codex model catalog this driver declares.
 *
 *   Source doc      : `docs/reference/provider-wire/codex.md`
 *   Section         : §Client requests (`model/list` on the default,
 *                     non-experimental generation)
 *   Pin             : codex-cli 0.150.1
 *   Provenance      : Binary probe. One live `codex app-server` JSON-RPC
 *                     `model/list` request after `initialize` / `initialized`
 *                     on 2026-08-30, `nextCursor: null` in the reply. Zero-turn:
 *                     no thread is started and nothing is billed.
 *   Trust           : Verified at 0.150.1. Every id, name, and effort level
 *                     below is a reading, not an illustration.
 *   Derived by      : Plan-005 T3.12 (currency duty C-8).
 *
 * WHY A DECLARATION EXISTS AT ALL: see the sibling Claude catalog's note. The
 * read is admissible, so {@link CodexModelCatalogExchange} is the preferred
 * source and this constant is the answer for a composition that binds none.
 *
 * The eight rows are ordered as the provider returns them — its own default
 * (`gpt-5.6-sol`) first. `hidden` is `false` on every row at the pin;
 * {@link normalizeCodexModelCatalog} still filters hidden rows, because a
 * hidden model is one the provider declines to offer for selection and
 * publishing it would offer a model its own surface does not.
 */
export const CODEX_DECLARED_MODEL_CATALOG: readonly ProviderModel[] = Object.freeze([
  declaredCodexModel("gpt-5.6-sol", "GPT-5.6-Sol", CODEX_EXTENDED_EFFORT_LEVELS),
  declaredCodexModel("gpt-5.6-terra", "GPT-5.6-Terra", CODEX_EXTENDED_EFFORT_LEVELS),
  // `max` without `ultra` — the one row that splits the two vocabularies, and
  // the reason the levels are carried per model rather than per provider.
  declaredCodexModel(
    "gpt-5.6-luna",
    "GPT-5.6-Luna",
    Object.freeze(["low", "medium", "high", "xhigh", "max"]),
  ),
  declaredCodexModel("gpt-daybreak-blue-latest", "Daybreak Blue", CODEX_EXTENDED_EFFORT_LEVELS),
  declaredCodexModel("gpt-5.5", "GPT-5.5", CODEX_BASE_EFFORT_LEVELS),
  declaredCodexModel("gpt-5.4", "GPT-5.4", CODEX_BASE_EFFORT_LEVELS),
  declaredCodexModel("gpt-5.4-mini", "GPT-5.4-Mini", CODEX_BASE_EFFORT_LEVELS),
  declaredCodexModel("gpt-5.3-codex-spark", "GPT-5.3-Codex-Spark", CODEX_BASE_EFFORT_LEVELS),
]);

/**
 * The live model-catalog read seam — one `model/list` client request on the
 * connection this driver already holds.
 *
 * Returns `unknown` for the same reason {@link CapabilityProbeExchange} does:
 * everything it yields is UNTRUSTED provider output. The implementer dispatches
 * and owns the deadline; THIS module composes and adjudicates, so the
 * normalization is testable without a process and a wire-shape change surfaces
 * here rather than in a transport.
 *
 * Deliberately payload-free and turn-free: like the capability probe, a billed
 * turn is not merely forbidden, it is unrepresentable.
 */
export type CodexModelCatalogExchange = () => Promise<unknown>;

/**
 * A `model/list` reply that could not be read as a catalog.
 *
 * Carries no `code`, on the capability-probe module's reasoning: this is a
 * provider-surface fault with no registered wire code, and inventing one would
 * mint an error contract this task may not mint.
 *
 * Deliberately duplicated from the sibling Claude module rather than shared
 * with it, on this file's standing reason: the two driver trees stay
 * import-independent, so neither can break the other by moving a file.
 */
export class CodexModelCatalogUnreadableError extends Error {
  constructor(detail: string) {
    super(`Codex model/list reply is not a readable model catalog: ${detail}`);
    this.name = "CodexModelCatalogUnreadableError";
  }
}

function readNonEmptyCodexString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Normalize one `model/list` reply into the contract's model shape.
 *
 * STRICT, not tolerant — the accepted shape is the one the pinned build
 * answers and nothing else. Three rules the wire forces:
 *
 *   1. **A paginated reply REFUSES.** `nextCursor` is `null` at the pin. A
 *      non-null cursor means this page is not the catalog, and answering the
 *      first page would publish a silently short model list — a participant
 *      would simply not see models the provider offers, with nothing anywhere
 *      recording that a page was dropped. Refusing is loud and, at the pin,
 *      unreachable.
 *   2. **Hidden rows are dropped.** A hidden model is one the provider declines
 *      to offer for selection.
 *   3. **A duplicate id REFUSES.** Unlike the sibling provider, this surface has
 *      no alias mechanism — every row names its own model — so two rows for one
 *      id is a malformed reply rather than a shape to collapse, and collapsing
 *      it would hide the malformation.
 */
export function normalizeCodexModelCatalog(payload: unknown): ProviderModel[] {
  if (typeof payload !== "object" || payload === null) {
    throw new CodexModelCatalogUnreadableError("reply is not an object");
  }
  const reply = payload as Record<string, unknown>;
  const rawModels = reply["data"];
  if (!Array.isArray(rawModels)) {
    throw new CodexModelCatalogUnreadableError("reply has no `data` array");
  }
  const nextCursor = reply["nextCursor"];
  if (nextCursor !== null && nextCursor !== undefined) {
    throw new CodexModelCatalogUnreadableError(
      "reply is paginated and this driver reads a single page",
    );
  }

  const models: ProviderModel[] = [];
  const seenIds = new Set<string>();
  for (const rawEntry of rawModels) {
    if (typeof rawEntry !== "object" || rawEntry === null) {
      throw new CodexModelCatalogUnreadableError("a `data` entry is not an object");
    }
    const entry = rawEntry as Record<string, unknown>;
    const id = readNonEmptyCodexString(entry, "id");
    if (id === undefined) {
      throw new CodexModelCatalogUnreadableError("a `data` entry has no `id`");
    }
    if (seenIds.has(id)) {
      throw new CodexModelCatalogUnreadableError(`model '${id}' appears twice`);
    }
    seenIds.add(id);
    if (entry["hidden"] === true) {
      continue;
    }
    const displayName = readNonEmptyCodexString(entry, "displayName");
    if (displayName === undefined) {
      throw new CodexModelCatalogUnreadableError(`model '${id}' has no \`displayName\``);
    }
    const model: ProviderModel = { id, name: displayName, capabilities: [] };
    const rawEfforts = entry["supportedReasoningEfforts"];
    if (Array.isArray(rawEfforts) && rawEfforts.length > 0) {
      const effortLevels: string[] = [];
      for (const rawEffort of rawEfforts) {
        // The level rides a nested object on this surface (`{ reasoningEffort,
        // description }`), unlike the sibling provider's flat string list.
        const level =
          typeof rawEffort === "object" && rawEffort !== null
            ? readNonEmptyCodexString(rawEffort as Record<string, unknown>, "reasoningEffort")
            : undefined;
        if (level === undefined) {
          throw new CodexModelCatalogUnreadableError(
            `model '${id}' has an unreadable reasoning-effort entry`,
          );
        }
        effortLevels.push(level);
      }
      model.effortLevels = effortLevels;
    }
    models.push(model);
  }
  return models;
}

/**
 * Answer the Codex driver's `listModels()`.
 *
 * @param exchange The live read, or an EXPLICIT `null` for a composition that
 *   binds none. Null rather than optional so a construction site cannot arrive
 *   at the declaration by never having decided — the reasoning that makes
 *   `resolveCredentialEnvPolicy` and the capability probe required options
 *   rather than defaulted ones.
 *
 * A bound exchange that FAILS is never quietly answered from the declaration.
 * Serving a stale catalog under the appearance of a live read is the one
 * confusion the detection-source doctrine exists to prevent, so a read failure
 * propagates and only an unbound exchange reaches the declaration.
 */
export async function resolveCodexModelCatalog(
  exchange: CodexModelCatalogExchange | null,
): Promise<ProviderModel[]> {
  if (exchange === null) {
    // Fresh copies: the constant is frozen and shared process-wide, and
    // `ProviderModel` carries mutable arrays a caller could otherwise rewrite
    // for every later caller.
    return CODEX_DECLARED_MODEL_CATALOG.map((model) => ({
      id: model.id,
      name: model.name,
      capabilities: [...model.capabilities],
      ...(model.effortLevels === undefined ? {} : { effortLevels: [...model.effortLevels] }),
    }));
  }
  return normalizeCodexModelCatalog(await exchange());
}
