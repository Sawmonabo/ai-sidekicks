// Per-capability zero-turn detection and its declared detection source
// (Plan-005 Phase 3, T3.24 — EXTENDs T3.12).
//
// `Spec-005 §Capability discovery` makes a capability declaration a READING OF
// THE INSTALLED BUILD rather than a table lookup, but only where a reading is
// honestly obtainable. This module is the place that distinction is written
// down and enforced: one entry per `DriverCapabilityFlag` per driver, each
// naming the mechanism that decides it, and — where no mechanism is admissible
// — naming the conjunct that fails.
//
// -- Admissibility is conjunctive, and a failing conjunct must be NAMED --
//
// A probe is admissible only when it is all three of:
//
//   * **zero-turn** — it spends no billed turn against the account;
//   * **non-mutating** — dispatching it performs no operation whose effect
//     outlives the probe. An operation whose defined effect is to REPLACE a set
//     is not made non-mutating by invoking it with an empty set;
//   * **decisive at the granularity the capability is consumed at** — the
//     answer settles the question the flag's own consumers ask, not a coarser
//     one nearby.
//
// A flag with no admissible probe resolves from the driver's per-driver matrix
// and is declared `static` WITH the failing conjunct named. The type below
// makes that structural: a `static` entry carries a NON-EMPTY tuple of failing
// conjuncts, and a `probed` entry carries a probe. Neither state can be spelled
// without its evidence, so "claims `probed` without a declared probe" is a
// compile error before it is a suite failure — and the suite asserts it anyway,
// because the table is also walked at runtime.
//
// -- Totality, and why it is a `Record` annotation --
//
// Each per-driver table is annotated `Readonly<Record<DriverCapabilityFlag,
// CapabilityDetectionMechanism>>`. A flag added to the contract's canonical
// `DRIVER_CAPABILITY_FLAGS` and not answered here is a MISSING-PROPERTY compile
// error in this file, which is exactly the loud failure a union growth needs
// (Plan-005 T3.26 grows it by three). The annotation is preferred over a bare
// `satisfies` because `isolatedDeclarations` is on repo-wide and the neighbours
// (`CODEX_CAPABILITY_FLAGS`, `CLAUDE_CAPABILITY_FLAGS`) already carry the
// annotated form.
//
// -- The transport is an injected seam, and a turn is UNREPRESENTABLE on it --
//
// `CapabilityProbeExchange` mirrors T3.23's `ProviderVersionHandshake`: a
// REQUIRED injected seam with no default. This module composes the probe names
// and adjudicates the replies; the seam's implementer executes them against the
// build T3.23 resolved and owns their deadline. The request shape carries a
// driver, a channel, and a WIRE NAME — and no field for message content — so a
// turn-start or a user message cannot be expressed through it at all. That is
// the structural half of "zero billed turns"; the suite asserts the other half
// at a recording transport double, because a daemon-side assertion on
// `usage.cost_update` could not see a turn billed before event handling
// attached.
//
// The seam's implementer carries one further obligation, and it is what makes
// **non-mutating** structural rather than behavioural: probes run on a
// DEDICATED PROBE CONNECTION — the one T3.23 already spawns to read the version
// in-band — which has never started a thread (Codex `thread/start`) and never
// sent a user message (Claude). There is therefore no session state for a probe
// to mutate even if a provider chose to act on one, and a probe never touches
// the connection a participant's run is bound to.
//
// -- Withdraw-only resolution --
//
// `applyCapabilityDetection` intersects: `declared && !withdrawn`. A probe may
// WITHDRAW a flag the matrix declares `true`; it may never GRANT one the matrix
// declares `false`. `Spec-005 §Capability discovery` forbids a flag declared
// ahead of the code that reads it, and Codex `transcript_replay` is `false` for
// exactly that reason (the replay leg is T3.20's) — a probe that flipped it
// would promise a caller a capability with no implementation behind it.
//
// -- Failure is per capability, except where it is not --
//
//   * a probe answering a typed name-refusal withdraws EXACTLY the flag it
//     probed; every other flag and the session survive;
//   * a probe answering something this module cannot classify withdraws that
//     one flag too, fail-closed, with a diagnostic — an unparseable answer is
//     never read as availability;
//   * the NEGATIVE CONTROL answering at all fails the whole read
//     (`CapabilityProbeNegativeControlError`). A channel that accepts a name
//     that cannot exist reports every capability available, so the honest
//     outcome is no report rather than an optimistic one;
//   * a transport that rejects fails the whole read
//     (`CapabilityProbeTransportError`). Attach refuses; the refresh cadence
//     reports the leg and retries.
//
// -- What this module deliberately does NOT do --
//
// It mints no event type (a changed snapshot rides the shipped
// `runtime_node.capability_updated` through the T2.4 writer's own change
// detection, CP-005-5), no error code (an invocation against a withdrawn flag
// refuses as the already-registered `driver.capability_unsupported`), and no
// durable column (`detectionSource` is live-scoped and absent on
// `DriverCapabilitiesWriter.hydrate()`, so the cache stores flag VALUES and not
// provenance).
//
// And it never issues `mcp_set_servers` under any flag's mechanism. That
// control request is not a capability flag, and `Spec-028 §Required Behavior`
// defines it as replacing the full named-server set — an empty-set call would
// clear a live session's servers. Its runtime availability is Plan-028's to
// establish from that plan's own full-desired-set reconcile (CP-005-11), and a
// refusal there withdraws no flag here — least of all `mcp`, which denotes MCP
// tool INVOCATION and is unaffected. The prohibition is enforced twice: the
// table may name only allowed wire names (checked at module load), and the
// runner issues only names the table declares plus the negative control.
//
// Refs: Plan-005 T3.24 (verifies I-005-10), `Spec-005 §Required Behavior`,
// `Spec-005 §Capability discovery`,
// `docs/architecture/contracts/api-payload-contracts.md §Plan-005 — Provider Driver Contract (Internal Interface)`,
// `docs/reference/provider-wire/claude.md`,
// `docs/reference/provider-wire/codex.md`.

import type { CapabilityDetectionSource, DriverCapabilityFlag } from "@ai-sidekicks/contracts";

import type { FlooredDriverName } from "./capability-refresh.js";

// --------------------------------------------------------------------------
// The mechanism table's vocabulary
// --------------------------------------------------------------------------

/**
 * The three conjuncts `Spec-005 §Capability discovery` requires of an
 * admissible probe. A `static` entry names the one (or more) that fails.
 */
export type ProbeAdmissibilityConjunct =
  | "zero-turn"
  | "non-mutating"
  | "decisive-at-consumption-granularity";

/**
 * A non-empty tuple: a `static` entry that named ZERO failing conjuncts would
 * be a matrix lookup with no justification, which is the state the invariant
 * exists to forbid. Making it unrepresentable is cheaper than asserting it.
 */
export type FailingConjuncts = readonly [
  ProbeAdmissibilityConjunct,
  ...ProbeAdmissibilityConjunct[],
];

/** One admissible probe: the wire name issued, and why its answer decides. */
export interface CapabilityProbe {
  /**
   * The wire name this probe issues — a control-request subtype on the Claude
   * channel, a client-request method on the Codex one. It is the ONLY thing
   * sent; no payload is composed, which is why the classifier keys on the
   * dispatcher's own name-level refusal rather than on a handler's result.
   */
  readonly probeName: string;
  /** Why the answer is decisive at the granularity the flag is consumed at. */
  readonly decisiveness: string;
}

/**
 * How one flag's value is arrived at for one driver. Discriminated on the same
 * literal the wire carries (`CapabilityDetectionSource`), so composing the
 * report is a projection rather than a translation.
 */
export type CapabilityDetectionMechanism =
  | {
      readonly detectionSource: "static";
      readonly failingConjuncts: FailingConjuncts;
      readonly rationale: string;
    }
  | { readonly detectionSource: "probed"; readonly probe: CapabilityProbe };

/** TOTAL over the canonical flag union — see this module's header. */
export type DriverCapabilityDetectionTable = Readonly<
  Record<DriverCapabilityFlag, CapabilityDetectionMechanism>
>;

// --------------------------------------------------------------------------
// The per-driver tables
// --------------------------------------------------------------------------

/**
 * Codex's detection-mechanism table.
 *
 * The driver's ONE zero-turn channel is the client-request method enumeration:
 * a default (non-experimental) `initialize` negotiation fixes which methods the
 * connection accepts, and an unaccepted method answers `-32600`, whose message
 * enumerates the accepted set (`docs/reference/provider-wire/codex.md`). Two
 * consequences run through every entry below. A flag whose mechanism IS a
 * client-request method is decided by that channel. A flag whose mechanism is a
 * turn parameter, a server-to-client frame, or a handshake-declared state is
 * not decidable by it in EITHER direction, so those entries fail
 * `decisive-at-consumption-granularity` — the `false` and `true` values alike
 * are complete declarations from the matrix, not unprobed gaps.
 */
export const CODEX_CAPABILITY_DETECTION_TABLE: DriverCapabilityDetectionTable = Object.freeze({
  resume: {
    detectionSource: "static",
    failingConjuncts: ["decisive-at-consumption-granularity"],
    rationale:
      "Thread resumption is delivered through the thread lifecycle rather than through a single client-request method the wire reference establishes, so the method enumeration cannot decide it in either direction.",
  },
  steer: {
    detectionSource: "probed",
    probe: {
      probeName: "turn/steer",
      decisiveness:
        "The flag asserts native mid-turn steering exists on the wire, and `turn/steer` is precisely the method its consumers call. The method takes the turn identity the driver already holds, so acceptance leaves no parameter-level fact unestablished — the failure mode that makes the sibling `rollback` entry static.",
    },
  },
  interactive_requests: {
    detectionSource: "static",
    failingConjuncts: ["decisive-at-consumption-granularity"],
    rationale:
      "The provider RAISES these requests; they are server-to-client frames and appear in no client-request enumeration, so the one zero-turn channel cannot observe them.",
  },
  mcp: {
    detectionSource: "static",
    failingConjuncts: ["zero-turn", "non-mutating"],
    rationale:
      "The flag asserts only that the provider can invoke MCP server tools, and the sole direct probe of that is invoking one — which consumes a turn and performs the tool's own effect. It resolves from the matrix.",
  },
  tool_calls: {
    detectionSource: "static",
    failingConjuncts: ["decisive-at-consumption-granularity"],
    rationale:
      "Tool invocations are surfaced as server-to-client items; the client-request enumeration says nothing about the shape of the frames the provider emits.",
  },
  reasoning_stream: {
    detectionSource: "static",
    failingConjuncts: ["decisive-at-consumption-granularity"],
    rationale:
      "A stream-output property. No client-request method names it, so the method enumeration cannot decide it in either direction.",
  },
  model_mutation: {
    detectionSource: "static",
    failingConjuncts: ["decisive-at-consumption-granularity"],
    rationale:
      "Delivered as per-turn overrides on `turn/start`. Acceptance of `turn/start` establishes the method, never that this build's turn parameters carry the override — the same parameter-level gap the `rollback` entry names.",
  },
  structured_output: {
    detectionSource: "static",
    failingConjuncts: ["decisive-at-consumption-granularity"],
    rationale:
      "A `turn/start` parameter, decided at parameter granularity and not at method granularity.",
  },
  rollback: {
    detectionSource: "static",
    failingConjuncts: ["decisive-at-consumption-granularity"],
    rationale:
      "The enumeration establishes that `thread/fork` is accepted, not that `ThreadForkParams.lastTurnId` is present — the wire reference verifies that field at the 0.150.1 pin rather than at the 0.141.0 admission floor. The flag resolves from the matrix until a parameter-level probe exists, and an invocation against a build that accepts the method without the boundary field refuses as `driver.capability_unsupported` rather than silently rewinding to the wrong position.",
  },
  session_goals: {
    detectionSource: "probed",
    probe: {
      probeName: "thread/goal/set",
      decisiveness:
        "The flag asserts durable per-thread goal operations exist on the wire, and `thread/goal/set` is the method its consumers call. It takes the thread identity the driver already holds, so method acceptance is decisive at the consumed granularity.",
    },
  },
  callback_tools: {
    detectionSource: "static",
    failingConjuncts: ["decisive-at-consumption-granularity"],
    rationale:
      "Daemon-registered tools reach the model through turn construction and return over the tool-call surface; no client-request method names the capability, so the enumeration cannot decide it.",
  },
  subagents: {
    detectionSource: "static",
    failingConjuncts: ["decisive-at-consumption-granularity"],
    rationale:
      "Peer agents are spawned from WITHIN a turn; the wire reference establishes no client-request method for them, so the enumeration cannot decide it in either direction.",
  },
  transcript_replay: {
    detectionSource: "static",
    failingConjuncts: ["decisive-at-consumption-granularity"],
    rationale:
      "An item-injection method being accepted does not establish that a seeded history is faithfully adopted — which is what the flag's consumers depend on, and what T3.20's post-replay assertion is the only admissible evidence of.",
  },
  cost_cap: {
    detectionSource: "static",
    failingConjuncts: ["decisive-at-consumption-granularity"],
    rationale:
      "A spawn-time budget property. No client-request method names it, so the one zero-turn channel cannot decide it; the `false` is a complete declaration and Spec-016's unpriced-family escape consumes it fail-closed.",
  },
});

/**
 * Claude's detection-mechanism table.
 *
 * The driver's ONE zero-turn channel is the control-request registry: a subtype
 * the dispatcher does not know answers the typed `Unsupported control request
 * subtype: <name>`, and every other answer — a `success`, or a handler's own
 * typed refusal such as the reference's `get_usage is not supported in this
 * context` arm — means the dispatcher KNOWS the subtype. That asymmetry is what
 * makes the channel probeable without composing a valid payload, and therefore
 * without performing any operation.
 *
 * The provider's other enumerations — the `system/init` handshake capability
 * set and the command/skill sets — are turn-bearing, so entries that depend on
 * them fail **zero-turn**. Entries whose mechanism is a launch-time CLI flag or
 * a stream-output shape are not addressable on the control channel at all and
 * fail **decisiveness**.
 */
export const CLAUDE_CAPABILITY_DETECTION_TABLE: DriverCapabilityDetectionTable = Object.freeze({
  resume: {
    detectionSource: "static",
    failingConjuncts: ["decisive-at-consumption-granularity"],
    rationale:
      "Delivered by launch-time flags (`--resume`, `--fork-session`), which the control-request channel cannot interrogate; the wire reference's own rule is that a flag's presence in a binary census is never promoted to availability.",
  },
  steer: {
    detectionSource: "static",
    failingConjuncts: ["decisive-at-consumption-granularity"],
    rationale:
      "FALSE on this driver: no mid-turn content-injection subtype exists, and the steer intervention degrades to queue-plus-interrupt as a REPORTED degradation. A probe cannot grant a flag anyway (resolution is withdraw-only), so the channel has nothing to decide here.",
  },
  interactive_requests: {
    detectionSource: "probed",
    probe: {
      probeName: "can_use_tool",
      decisiveness:
        "The flag names the control-request registry itself — the tool-permission and clarification round trips this channel carries. `can_use_tool` is a censused member of that registry, so a build whose dispatcher answers the typed unsupported-subtype refusal for it does not have the registry the flag asserts, and any other answer means it does. The subtype is a QUESTION the provider asks rather than an operation it performs, so a dispatch mutates nothing even before the probe connection's own never-started session is considered.",
    },
  },
  mcp: {
    detectionSource: "static",
    failingConjuncts: ["zero-turn", "non-mutating"],
    rationale:
      "The flag asserts only that the provider can invoke MCP server tools, and the sole direct probe of that is invoking one — which consumes a turn and performs the tool's own effect. It resolves from the matrix. The set-replacing `mcp_set_servers` reconcile is NOT a probe of this flag and is not issued here at all.",
  },
  tool_calls: {
    detectionSource: "static",
    failingConjuncts: ["decisive-at-consumption-granularity"],
    rationale:
      "A property of the streamed output surface. No control-request subtype reports it, so the channel cannot decide it in either direction.",
  },
  reasoning_stream: {
    detectionSource: "static",
    failingConjuncts: ["decisive-at-consumption-granularity"],
    rationale:
      "Thinking blocks are a stream-output shape; the control-request channel observes no output frames.",
  },
  model_mutation: {
    detectionSource: "static",
    failingConjuncts: ["non-mutating"],
    rationale:
      "The subtype that would decide it (`set_model`) is defined to CHANGE the session's model. Deciding the flag by issuing it rests on an unstated assumption that a payload the handler rejects performs nothing — an assumption the wire reference does not record and whose worst case is that the model is actually set.",
  },
  structured_output: {
    detectionSource: "static",
    failingConjuncts: ["decisive-at-consumption-granularity"],
    rationale:
      "Delivered by the launch-time `--json-schema` flag, which the control-request channel cannot interrogate.",
  },
  rollback: {
    detectionSource: "static",
    failingConjuncts: ["decisive-at-consumption-granularity"],
    rationale:
      "Composed from launch-time resume-at plus `--fork-session`. The conversation-rewind subtype is absent from the control-request census entirely, and the file-side `rewind_files` sibling decides a different capability (the daemon's turn-snapshot leg), so the channel cannot decide this flag.",
  },
  session_goals: {
    detectionSource: "static",
    failingConjuncts: ["decisive-at-consumption-granularity"],
    rationale:
      "Driver-EMULATED: the goal is daemon-stored and composed into the system prompt at the next turn or resume boundary. There is no provider-side surface to probe, and the provider's answer could not decide a capability the daemon itself delivers.",
  },
  callback_tools: {
    detectionSource: "static",
    failingConjuncts: ["decisive-at-consumption-granularity"],
    rationale:
      "Delivered by a daemon-hosted ephemeral MCP server bound at launch. The capability is the daemon's to deliver, so no provider answer decides it.",
  },
  subagents: {
    detectionSource: "static",
    failingConjuncts: ["decisive-at-consumption-granularity"],
    rationale:
      "Delivered by the launch-time `--agents` definitions, which the control-request channel cannot interrogate.",
  },
  transcript_replay: {
    detectionSource: "static",
    failingConjuncts: ["decisive-at-consumption-granularity"],
    rationale:
      "No stable prior-turn seeding contract is published for this provider, so no control-request answer establishes that a seeded history is adopted. The matrix cell records this as an open probe; supplying it is T3.20's, together with the post-replay assertion that is the only admissible evidence a replay worked.",
  },
  cost_cap: {
    detectionSource: "static",
    failingConjuncts: ["decisive-at-consumption-granularity"],
    rationale:
      "Delivered by the launch-time `--max-budget-usd` flag, which the control-request channel cannot interrogate.",
  },
});

/** The per-driver tables, keyed by the same driver id the floor seam uses. */
export const CAPABILITY_DETECTION_TABLES: Readonly<
  Record<FlooredDriverName, DriverCapabilityDetectionTable>
> = Object.freeze({
  claude: CLAUDE_CAPABILITY_DETECTION_TABLE,
  codex: CODEX_CAPABILITY_DETECTION_TABLE,
});

// --------------------------------------------------------------------------
// Negative controls and the prohibited-name screen
// --------------------------------------------------------------------------

/**
 * The deliberately-unsupported name each driver's channel must still refuse.
 *
 * `Spec-005 §Capability discovery`: a probe is admissible only alongside a
 * negative control, because a probe surface that silently stopped refusing
 * reports every capability available. The Claude sentinel is the one the wire
 * reference's own first-party probes used, so a control answering here is a
 * change in the provider rather than in this daemon's choice of name.
 */
export const CAPABILITY_PROBE_NEGATIVE_CONTROLS: Readonly<Record<FlooredDriverName, string>> =
  Object.freeze({
    claude: "zzq_nonexistent_subtype",
    codex: "zzq/nonexistent_method",
  });

/**
 * Wire names no probe may issue under any flag's mechanism, screened at module
 * load and again at every dispatch.
 *
 * `mcp_set_servers` is the task's absolute (see the header). The two
 * session-establishing methods are here because a probe that started a thread
 * or a turn would break the never-started-session property the non-mutating
 * argument rests on, even though the seam's request shape gives it no content
 * to send.
 */
export const CAPABILITY_PROBE_PROHIBITED_WIRE_NAMES: readonly string[] = Object.freeze([
  "mcp_set_servers",
  "turn/start",
  "thread/start",
]);

// --------------------------------------------------------------------------
// The transport seam
// --------------------------------------------------------------------------

/** Which of a driver's two request surfaces a probe name belongs to. */
export type CapabilityProbeChannel = "control_request" | "client_request";

/** Each driver's ONE zero-turn probe channel — see the per-driver table docs. */
export const CAPABILITY_PROBE_CHANNELS: Readonly<
  Record<FlooredDriverName, CapabilityProbeChannel>
> = Object.freeze({
  claude: "control_request",
  codex: "client_request",
});

/**
 * One probe dispatch. Deliberately carries no message body, no turn identity,
 * and no payload: a billed turn is not merely forbidden here, it is
 * unrepresentable.
 */
export interface CapabilityProbeRequest {
  readonly driverName: FlooredDriverName;
  readonly channel: CapabilityProbeChannel;
  readonly probeName: string;
}

/**
 * The injected probe transport (the T3.23 `ProviderVersionHandshake` doctrine).
 * REQUIRED, with no default: a module-supplied default would let a caller probe
 * a build it never resolved. The implementer dispatches against the resolved
 * probe connection and owns the deadline; this module composes and adjudicates.
 *
 * Returns `unknown` because everything it yields is UNTRUSTED provider output.
 */
export type CapabilityProbeExchange = (request: CapabilityProbeRequest) => Promise<unknown>;

// --------------------------------------------------------------------------
// Failures
// --------------------------------------------------------------------------

/**
 * Base class for a failure of the PROBE SURFACE itself, as opposed to a probe
 * that answered and withdrew one flag.
 *
 * Deliberately carries no `code`: every failure here is a daemon-side or
 * provider-surface fault with no registered wire code, and inventing one would
 * mint an error contract this task is explicitly not permitted to mint. The
 * refresh scheduler discriminates on the class, not on a string.
 */
export abstract class CapabilityProbeError extends Error {}

/** The negative control was ANSWERED — the channel's refusals cannot be trusted. */
export class CapabilityProbeNegativeControlError extends CapabilityProbeError {
  readonly driverName: FlooredDriverName;
  readonly probeName: string;

  constructor(driverName: FlooredDriverName, probeName: string) {
    super(
      `capability probe negative control '${probeName}' was answered by driver '${driverName}'; refusing to report capabilities from a channel that does not refuse`,
    );
    this.name = "CapabilityProbeNegativeControlError";
    this.driverName = driverName;
    this.probeName = probeName;
  }
}

/** The transport rejected — no reading exists, so nothing is declared. */
export class CapabilityProbeTransportError extends CapabilityProbeError {
  readonly driverName: FlooredDriverName;
  readonly probeName: string;

  constructor(driverName: FlooredDriverName, probeName: string, options: { cause: unknown }) {
    super(
      `capability probe '${probeName}' transport failed for driver '${driverName}'`,
      // `cause` is provider- or transport-originated and is carried verbatim as
      // data; nothing interpolates it into a message.
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
 * Refuse a wire name no probe may issue, wherever it came from.
 *
 * Exported so the guard is reachable and testable on its own rather than only
 * through a doctored table: the table screen catches an authoring mistake, and
 * this catches a caller that reached the dispatcher some other way. The
 * prohibition is not a lint on this file — it is a property of the running
 * daemon, so it is enforced where the request is about to be made.
 */
export function assertProbeWireNameAdmissible(probeName: string): void {
  if (CAPABILITY_PROBE_PROHIBITED_WIRE_NAMES.includes(probeName)) {
    throw new CapabilityProbeProhibitedNameError(probeName);
  }
}

/** True for every failure of the probe surface — the refresh scheduler's leg discriminator. */
export function isCapabilityProbeError(value: unknown): value is CapabilityProbeError {
  return value instanceof CapabilityProbeError;
}

// --------------------------------------------------------------------------
// Reply classification
// --------------------------------------------------------------------------

/**
 * What one probe's answer says about the NAME it issued.
 *
 * `accepted` deliberately covers a handler's own typed refusal as well as a
 * success: the wire references record censused subtypes and accepted methods
 * that still refuse for contextual or parameter reasons, and neither refusal is
 * evidence the surface is missing. Only a NAME-level refusal withdraws, which is
 * what lets the probe run without composing a valid payload — and therefore
 * without performing any operation.
 */
type ProbeAnswer = "accepted" | "unknown-name" | "unrecognized";

/** The Claude dispatcher's verbatim name-level refusal prefix. */
const CLAUDE_UNSUPPORTED_SUBTYPE_PREFIX = "Unsupported control request subtype:";

/**
 * JSON-RPC codes the Codex app-server answers for a name its connection does
 * not accept. `-32600` is the measured one at the pin (its message enumerates
 * the accepted set); `-32601` is the standard method-not-found spelling and is
 * classified the same way so a future build that adopts it is not read as
 * acceptance.
 */
const CODEX_UNKNOWN_METHOD_CODES: readonly number[] = Object.freeze([-32600, -32601]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Classify one Claude `control_response`.
 *
 * Accepts either the full `{ type: "control_response", response: {...} }`
 * envelope or the inner response object, because the seam's implementer may
 * reasonably unwrap the transport frame before returning.
 */
export function classifyClaudeProbeReply(payload: unknown): ProbeAnswer {
  const envelope = asRecord(payload);
  if (envelope === undefined) {
    return "unrecognized";
  }
  const response = asRecord(envelope["response"]) ?? envelope;
  const subtype = response["subtype"];
  if (subtype === "success") {
    return "accepted";
  }
  if (subtype !== "error") {
    return "unrecognized";
  }
  const error = response["error"];
  if (typeof error !== "string") {
    // An error arm whose reason is not a string cannot be discriminated into a
    // name-level refusal, and reading it as acceptance would be optimistic.
    return "unrecognized";
  }
  return error.startsWith(CLAUDE_UNSUPPORTED_SUBTYPE_PREFIX) ? "unknown-name" : "accepted";
}

/**
 * Classify one Codex JSON-RPC reply.
 *
 * A `result` means the method dispatched. An error that is NOT an
 * unknown-method code (a `-32602` invalid-params, say) means the method exists
 * and this probe's deliberately payload-free request was refused by its schema
 * — which is exactly the outcome that keeps the probe non-mutating.
 */
export function classifyCodexProbeReply(payload: unknown): ProbeAnswer {
  const envelope = asRecord(payload);
  if (envelope === undefined) {
    return "unrecognized";
  }
  if ("result" in envelope) {
    return "accepted";
  }
  const error = asRecord(envelope["error"]);
  if (error === undefined) {
    return "unrecognized";
  }
  const code = error["code"];
  if (typeof code !== "number") {
    return "unrecognized";
  }
  return CODEX_UNKNOWN_METHOD_CODES.includes(code) ? "unknown-name" : "accepted";
}

const PROBE_REPLY_CLASSIFIERS: Readonly<
  Record<FlooredDriverName, (payload: unknown) => ProbeAnswer>
> = Object.freeze({
  claude: classifyClaudeProbeReply,
  codex: classifyCodexProbeReply,
});

// --------------------------------------------------------------------------
// Table self-check
// --------------------------------------------------------------------------

/** One reason a detection table is not admissible. */
export interface CapabilityDetectionTableViolation {
  readonly driverName: FlooredDriverName;
  readonly flag: DriverCapabilityFlag;
  readonly reason: string;
}

/**
 * Walk a driver's table and report every entry that is not admissible.
 *
 * The type system already forbids a `probed` entry with no probe and a `static`
 * entry with no failing conjunct. This is the RUNTIME half, and it exists for
 * the two properties the type cannot express: a probe name must not be empty,
 * and it must not be a prohibited wire name. The suite drives this function
 * against a deliberately-malformed table so the checker is proven non-vacuous
 * rather than trusted because it returned nothing.
 */
export function findCapabilityDetectionTableViolations(
  driverName: FlooredDriverName,
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
    const { probeName } = mechanism.probe;
    if (probeName.trim() === "") {
      violations.push({
        driverName,
        flag,
        reason: "a `probed` entry must declare a non-empty probe wire name",
      });
    }
    if (CAPABILITY_PROBE_PROHIBITED_WIRE_NAMES.includes(probeName)) {
      violations.push({
        driverName,
        flag,
        reason: `a probe may never issue the prohibited wire name '${probeName}'`,
      });
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

// --------------------------------------------------------------------------
// The reading
// --------------------------------------------------------------------------

/** One flag withdrawn by its own probe, with the disposition that withdrew it. */
export interface CapabilityProbeDiagnostic {
  readonly driverName: FlooredDriverName;
  readonly flag: DriverCapabilityFlag;
  readonly probeName: string;
  /**
   * `unknown-name` — the channel refused the name itself, so the build does not
   * carry the surface. `unrecognized-reply` — the answer could not be
   * classified, and an unclassifiable answer is never read as availability.
   */
  readonly disposition: "unknown-name" | "unrecognized-reply";
}

/**
 * One live detection reading for one driver.
 *
 * `detectionSource` is TOTAL over the flag set — that is what makes it usable
 * as `GetCapabilitiesResult.detectionSource` directly, and it is why the type
 * is a `Record` rather than a partial map. `withdrawnFlags` is separate from it
 * because provenance and value are different questions: a flag is `probed`
 * whether its probe confirmed or withdrew it.
 */
export interface CapabilityDetectionReading {
  readonly driverName: FlooredDriverName;
  readonly detectionSource: Readonly<Record<DriverCapabilityFlag, CapabilityDetectionSource>>;
  readonly withdrawnFlags: readonly DriverCapabilityFlag[];
  readonly diagnostics: readonly CapabilityProbeDiagnostic[];
}

/** What one detection read needs: the driver, and the transport to read over. */
export interface CapabilityDetectionReadRequest {
  readonly driverName: FlooredDriverName;
  readonly exchange: CapabilityProbeExchange;
}

/**
 * Read one driver's detection sources against the build behind `exchange`.
 *
 * ORDERING IS THE CONTRACT. The negative control runs FIRST and its answer is
 * disqualifying: a channel that answers a name that cannot exist would classify
 * every probe as `accepted`, so running the capability probes first and then
 * discovering the control answered would mean composing a report from readings
 * already known to be worthless. Failing before any capability probe is issued
 * also keeps the failure cheap and unambiguous.
 *
 * @throws CapabilityProbeNegativeControlError when the control is answered.
 * @throws CapabilityProbeTransportError when the transport rejects.
 * @throws CapabilityProbeProhibitedNameError when a prohibited name would be issued.
 */
export async function readCapabilityDetection(
  request: CapabilityDetectionReadRequest,
): Promise<CapabilityDetectionReading> {
  const { driverName, exchange } = request;
  const table = CAPABILITY_DETECTION_TABLES[driverName];
  const violations = findCapabilityDetectionTableViolations(driverName, table);
  if (violations.length > 0) {
    // A malformed table is a daemon wiring fault, not provider misbehaviour.
    throw new Error(
      `capability detection table for driver '${driverName}' is inadmissible: ${violations
        .map((violation) => `${violation.flag}: ${violation.reason}`)
        .join("; ")}`,
    );
  }

  const negativeControlName = CAPABILITY_PROBE_NEGATIVE_CONTROLS[driverName];
  const negativeControlAnswer = await dispatchProbe(driverName, negativeControlName, exchange);
  if (negativeControlAnswer !== "unknown-name") {
    throw new CapabilityProbeNegativeControlError(driverName, negativeControlName);
  }

  const detectionSource: Record<DriverCapabilityFlag, CapabilityDetectionSource> = {} as Record<
    DriverCapabilityFlag,
    CapabilityDetectionSource
  >;
  const withdrawnFlags: DriverCapabilityFlag[] = [];
  const diagnostics: CapabilityProbeDiagnostic[] = [];

  // Deterministic order, and one dispatch per DISTINCT probe name: two flags
  // sharing a mechanism must not double-issue it, and a re-issued name would
  // make the transport double's request count a poor proxy for what was probed.
  const answersByProbeName = new Map<string, ProbeAnswer>();
  for (const [flag, mechanism] of Object.entries(table) as [
    DriverCapabilityFlag,
    CapabilityDetectionMechanism,
  ][]) {
    detectionSource[flag] = mechanism.detectionSource;
    if (mechanism.detectionSource !== "probed") {
      continue;
    }
    const { probeName } = mechanism.probe;
    let answer = answersByProbeName.get(probeName);
    if (answer === undefined) {
      answer = await dispatchProbe(driverName, probeName, exchange);
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
  }

  return Object.freeze({
    driverName,
    detectionSource: Object.freeze(detectionSource),
    withdrawnFlags: Object.freeze(withdrawnFlags),
    diagnostics: Object.freeze(diagnostics),
  });
}

async function dispatchProbe(
  driverName: FlooredDriverName,
  probeName: string,
  exchange: CapabilityProbeExchange,
): Promise<ProbeAnswer> {
  // Screened at the dispatch and not only at the table, so a caller that
  // reaches this helper with a name from anywhere else is refused too.
  assertProbeWireNameAdmissible(probeName);
  let payload: unknown;
  try {
    payload = await exchange({
      driverName,
      channel: CAPABILITY_PROBE_CHANNELS[driverName],
      probeName,
    });
  } catch (cause) {
    throw new CapabilityProbeTransportError(driverName, probeName, { cause });
  }
  return PROBE_REPLY_CLASSIFIERS[driverName](payload);
}

/**
 * Intersect a driver's declared matrix with what the probes actually found.
 *
 * WITHDRAW-ONLY, and that direction is the whole rule: `declared && !withdrawn`.
 * A probe can take a flag away from a build that turns out not to carry the
 * surface; it can never hand one to a build whose driver code does not
 * implement it. Returns a FRESH record — the caller's matrix constant is
 * frozen and shared process-wide.
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
