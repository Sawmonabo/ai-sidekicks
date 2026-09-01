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
// -- A probe answers about a NAME, and only a NAME-LEVEL refusal withdraws --
//
// Both channels are read the same way, and the Codex side is where that is
// delicate: the app-server answers `-32600` for a name its `ClientRequest`
// enumeration does not carry AND for an accepted name whose payload does not
// deserialize, so the code alone decides nothing. The discriminator is the
// deserializer's own message
// (`docs/reference/provider-wire/codex.md §Refusal shapes on the client-request channel`):
// an unaccepted name answers an `unknown variant` message naming that variant
// and enumerating the accepted set, while an ACCEPTED method handed this
// probe's deliberately payload-free request answers a missing-field message and
// a capability-gated one answers a plain-prose reason. Reading `-32600` alone
// as a name refusal would withdraw `steer` and `session_goals` on every real
// read, because both of their methods take a thread identity a probe never
// composes.
//
// AMBIGUITY RESOLVES TOWARD `accepted`, and the direction is the point: because
// resolution is withdraw-only, a wrong `accepted` leaves the declared matrix
// exactly as the driver authored it, while a wrong `unknown-name` silently
// disables a capability the build actually carries.
//
// -- One flag may name SEVERAL wire names, and they are conjunctive --
//
// A capability whose consumers call more than one name is not decided by
// probing one of them. `session_goals` is the shipped case: the flag is
// consumed as durable per-thread goal operations, which this daemon's Codex
// driver delivers over `thread/goal/set` AND `thread/goal/clear`, so both are
// probed and a name-level refusal on EITHER withdraws the flag. Probing a
// subset would answer a coarser question than the flag is consumed at — the
// very conjunct that decides admissibility. Dedup still holds ACROSS flags: a
// name two flags share is dispatched once per read.
//
// -- A reading is bound to the BUILD it was read from --
//
// Every read request, every dispatch, and the reading itself carry
// `boundExecutablePath`: the resolved, symlink-dereferenced path the T3.23
// version handshake proved, threaded from that handshake's own product rather
// than re-resolved here. A capability report is a statement about one build, so
// "these capabilities and this version describe the same executable" is a
// property the composition sites CHECK rather than assume — which is exactly
// the case a second resolution could get wrong (a `PATH` change or an installer
// swap between the handshake and the probes).
//
// -- A successful read that withdrew something is still news --
//
// A read that SUCCEEDS while withdrawing a flag is the operator-interesting
// outcome: the surface answered, and the build turned out not to carry
// something its matrix declares. The reading carries those withdrawals as
// diagnostics, and the composition sites hand them to the driver diagnostic
// band (`emitCapabilityDetectionDiagnostics`) so a node whose provider quietly
// lost a capability is as visible as one whose refresh failed outright.
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

/** One admissible probe: the wire name(s) issued, and why the answer decides. */
export interface CapabilityProbe {
  /**
   * The wire names this probe issues — control-request subtypes on the Claude
   * channel, client-request methods on the Codex one. They are the ONLY thing
   * sent; no payload is composed, which is why the classifier keys on the
   * dispatcher's own name-level refusal rather than on a handler's result.
   *
   * CONJUNCTIVE, and NON-EMPTY by construction. A flag whose consumers call
   * several names is decided by all of them: every name must classify
   * `accepted`, and a name-level refusal on any ONE withdraws the flag. The
   * tuple type makes the empty list — a `probed` entry that probes nothing, and
   * so can never withdraw — unrepresentable rather than merely checked.
   */
  readonly probeNames: readonly [string, ...string[]];
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
      probeNames: ["turn/steer"],
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
      "The enumeration establishes that `thread/fork` is accepted, not that `ThreadForkParams.lastTurnId` is present — the wire reference verifies that field at the 0.150.1 pin rather than at the 0.141.0 admission floor. The flag resolves from the matrix until a parameter-level probe exists, and the gap is closed at INVOCATION instead: a build that accepts the method and then refuses the boundary field is classified at `CodexLifecycleManager.rollbackTo`'s fork dispatch as `driver.capability_unsupported`, rather than surfacing as an opaque provider fault the caller would have to read a deserializer message to understand. That classification covers the refusing build only — one that instead IGNORES an unrecognized boundary field forks the whole thread and is answered by that same leg's turn-ledger check, which is a diagnostic and not a refusal.",
  },
  session_goals: {
    detectionSource: "probed",
    probe: {
      probeNames: ["thread/goal/set", "thread/goal/clear"],
      decisiveness:
        "The flag asserts durable per-thread goal operations exist on the wire, and these are the two methods its consumers call — the driver's `setSessionGoal` and `clearSessionGoal` legs. Both take the thread identity the driver already holds, so method acceptance is decisive at the consumed granularity; probing only the setter would leave a build that accepts goals it cannot clear reported as fully capable.",
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
  context_compaction: {
    detectionSource: "probed",
    probe: {
      probeNames: ["thread/compact/start"],
      decisiveness:
        "The flag asserts that participant-triggered compaction exists on the wire, and this is precisely the method its consumer — the driver's `compactContext` leg — calls. Unlike the sibling `rollback` entry, acceptance leaves NO parameter-level fact unestablished: the method's whole parameter set is the thread identity the driver already holds, so a build that accepts the method accepts every argument this driver will ever send it.",
    },
  },
  provider_commands: {
    detectionSource: "probed",
    probe: {
      probeNames: ["skills/list"],
      decisiveness:
        "The flag asserts that the provider publishes an enumerable command and skill surface, and this is the method the driver's `listProviderCommands` leg reads it through. Every parameter it takes is OPTIONAL, so — as with the compaction entry above — method acceptance is decisive at the granularity the flag is consumed at rather than leaving a required argument unprobed.",
    },
  },
  output_speed: {
    detectionSource: "static",
    failingConjuncts: ["decisive-at-consumption-granularity"],
    rationale:
      "FALSE on this driver, and a complete declaration rather than an unprobed gap. The failing conjunct here is DECISIVENESS and not zero-turn — deliberately a different conjunct from the sibling Claude entry. This driver DOES have a zero-turn channel bearing on the axis: the model catalog read, which carries a per-model service-tier list. It still cannot decide the flag, because a service tier is three free-form strings and reading one of them as an output-SPEED tier is a semantic judgment rather than a decidable read. The `false` rests on the two conjuncts the axis itself requires — no statically declarable level vocabulary and no declared-state read — and deliberately NOT on a census of the method root, which bounds availability from below and not above.",
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
 *
 * NO ENTRY IS CURRENTLY `probed`, AND THAT IS A FINDING RATHER THAN AN
 * OVERSIGHT. The one flag whose mechanism this channel could plausibly reach —
 * `interactive_requests` — names subtypes the provider RAISES; the pinned
 * build's inbound dispatcher refuses every one of them by name, exactly as it
 * refuses the negative control
 * (`docs/reference/provider-wire/claude.md §Direction: some censused subtypes are refused BY NAME on the inbound channel`),
 * so the channel's answer is decisive in the wrong direction. The channel
 * doctrine above is kept because it is what a future probeable subtype would be
 * admitted under, and the negative control is deliberately still declared for
 * this driver: it becomes live again the moment an entry here becomes `probed`.
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
    detectionSource: "static",
    failingConjuncts: ["decisive-at-consumption-granularity"],
    rationale:
      "The flag is consumed as the round trips the PROVIDER raises — `can_use_tool`, `elicitation`, `request_user_dialog` — and the control-request census is a census of the registry, not of the inbound dispatcher's accepted set. A first-party probe of the pinned build answers the identical name-level refusal for all three as for the negative control, so probing them would withdraw the flag on every read of a build that fully carries it. The channel therefore cannot decide a capability delivered by frames flowing the other way, in either direction.",
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
  context_compaction: {
    detectionSource: "static",
    failingConjuncts: ["zero-turn"],
    rationale:
      "The compaction this driver's leg dispatches is the provider's OWN command, and the only evidence that command exists on this build is its presence in the session-handshake command enumeration — which the provider emits as part of a turn-bearing exchange. Reading it therefore costs a turn, so the one conjunct that fails is zero-turn rather than decisiveness: the enumeration WOULD decide the flag, and is simply not free to obtain.",
  },
  provider_commands: {
    detectionSource: "static",
    failingConjuncts: ["zero-turn"],
    rationale:
      "The enumeration IS the capability here, and it rides that same turn-bearing session handshake. Same failing conjunct as the compaction entry above and for the same reason: the reading is decisive and simply not free.",
  },
  output_speed: {
    detectionSource: "static",
    failingConjuncts: ["zero-turn"],
    rationale:
      "TRUE on this driver. The declared speed state arrives on the same turn-bearing session handshake, so obtaining it costs a user-message request — which is exactly the conjunct that keeps this entry static, and exactly why the axis's value set is declared from this driver's own table rather than read from the provider: a vocabulary obtained by reading would contradict its own detection source.",
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
 *
 * DECLARED PER DRIVER, DISPATCHED ONLY WHERE IT VALIDATES SOMETHING. The entry
 * is total over the drivers so a table that becomes probeable is never left
 * without a control; the read issues it only when that driver's table declares
 * at least one probe. With no probes, no answer can withdraw anything, so a
 * control failure would refuse a report every one of whose flags is `static` —
 * costing an attach to validate a classification nothing performs.
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
  /**
   * The build this probe is a statement about: the resolved,
   * symlink-dereferenced executable path the version handshake proved, carried
   * through from that handshake's own reading rather than resolved again here.
   *
   * The seam's implementer dispatches against the connection it already holds
   * and does not re-resolve from this value; it is carried so that every
   * recorded request, and the reading composed from them, name the executable
   * whose capabilities are being reported.
   */
  readonly boundExecutablePath: string;
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
 * The Codex app-server's generic invalid-request code. Measured at the pin, it
 * answers BOTH a name the connection does not accept and an accepted name whose
 * payload does not deserialize, so the code alone classifies nothing — see
 * {@link classifyCodexProbeReply}.
 */
const CODEX_INVALID_REQUEST_CODE = -32600;

/**
 * The standard JSON-RPC method-not-found code. The pinned build does not emit
 * it for an unaccepted name, but it is unambiguous where it appears, so a
 * future build that adopts the standard spelling is not read as acceptance.
 */
const CODEX_METHOD_NOT_FOUND_CODE = -32601;

/**
 * The deserializer's unknown-variant message: the variant it refused, then the
 * enumeration of the ones it accepts.
 *
 * Anchored on the two literal fragments the pinned build emits rather than on
 * the whole message, because the request-shape preamble in front of them
 * (`Invalid request: `) is not part of what discriminates.
 */
const CODEX_UNKNOWN_VARIANT_PATTERN = /unknown variant `([^`]*)`, expected one of (.+)$/s;

/** Every backtick-quoted name in an unknown-variant enumeration tail. */
function parseEnumeratedWireNames(enumerationTail: string): readonly string[] {
  return [...enumerationTail.matchAll(/`([^`]*)`/g)].map((match) => match[1] ?? "");
}

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
 * Classify one Codex JSON-RPC reply about the name that was issued.
 *
 * A `result` means the method dispatched. `-32601` is the standard
 * method-not-found spelling and refuses the name outright. Every other code
 * means the method exists and something else refused — a schema refusal of this
 * probe's deliberately payload-free request is the ordinary case, and it is
 * exactly the outcome that keeps the probe non-mutating.
 *
 * `-32600` IS THE WHOLE DIFFICULTY, because the pinned build answers it for
 * both outcomes. It classifies `unknown-name` only when the message carries the
 * deserializer's own unknown-variant enumeration, that message names THIS
 * probe's name as the variant it refused, and this probe's name is absent from
 * the accepted set it enumerates. A `-32600` whose message carries no
 * enumeration (a capability-gated method, a missing-field refusal) classifies
 * `accepted`, and so does one whose enumeration CONTAINS the probed name —
 * which can only mean the refusal was about some other variant nested in the
 * request, never about the method itself.
 *
 * Every ambiguous arm resolves toward `accepted` deliberately: resolution is
 * withdraw-only, so a wrong `accepted` preserves the declared matrix while a
 * wrong `unknown-name` silently disables a capability the build carries.
 *
 * `probeName` is the name this reply is an answer to. The classifier is
 * exported for the suite, which drives it directly against measured payloads.
 */
export function classifyCodexProbeReply(payload: unknown, probeName: string): ProbeAnswer {
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
  if (code === CODEX_METHOD_NOT_FOUND_CODE) {
    return "unknown-name";
  }
  if (code !== CODEX_INVALID_REQUEST_CODE) {
    return "accepted";
  }
  const message = error["message"];
  if (typeof message !== "string") {
    return "accepted";
  }
  const unknownVariant = CODEX_UNKNOWN_VARIANT_PATTERN.exec(message);
  const refusedVariant = unknownVariant?.[1];
  const enumerationTail = unknownVariant?.[2];
  if (refusedVariant === undefined || enumerationTail === undefined) {
    return "accepted";
  }
  if (refusedVariant !== probeName) {
    return "accepted";
  }
  return parseEnumeratedWireNames(enumerationTail).includes(probeName)
    ? "accepted"
    : "unknown-name";
}

/**
 * Every classifier takes the name it is answering about, whether or not it
 * needs it: the Claude channel's refusal is already name-level by construction,
 * while the Codex one must compare the refused variant against what was issued.
 */
type ProbeReplyClassifier = (payload: unknown, probeName: string) => ProbeAnswer;

const PROBE_REPLY_CLASSIFIERS: Readonly<Record<FlooredDriverName, ProbeReplyClassifier>> =
  Object.freeze({
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
 * The type system already forbids a `probed` entry with no probe, a `static`
 * entry with no failing conjunct, and — through the non-empty tuple — a probe
 * that names no wire name. This is the RUNTIME half, and it exists for the
 * properties the type cannot express: EVERY name a probe declares must be
 * non-empty and must not be a prohibited wire name. The empty list is checked
 * here anyway, because the tuple type is only a compile-time guarantee and this
 * function is reachable with a table that came from somewhere else. The suite
 * drives it against deliberately-malformed tables so the checker is proven
 * non-vacuous rather than trusted because it returned nothing.
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
    const { probeNames } = mechanism.probe;
    if (probeNames.length === 0) {
      violations.push({
        driverName,
        flag,
        reason: "a `probed` entry must declare at least one probe wire name",
      });
    }
    // Every name is screened, not just the first: a conjunctive probe issues
    // all of them, so a prohibited name anywhere in the list would reach the
    // wire exactly as one in the first position would.
    for (const probeName of probeNames) {
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
  /**
   * The name that decided it. For a conjunctive probe this is the FIRST name
   * whose answer withdrew the flag, in the order the table declares — the
   * remaining names are not dispatched, because the flag is already withdrawn
   * and a probe issues nothing it does not need.
   */
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
  /**
   * The build this reading describes, carried through from the read request —
   * see {@link CapabilityDetectionReadRequest.boundExecutablePath}. A
   * composition site that also holds a version reading compares the two and
   * refuses a report assembled from two different executables.
   */
  readonly boundExecutablePath: string;
  readonly detectionSource: Readonly<Record<DriverCapabilityFlag, CapabilityDetectionSource>>;
  readonly withdrawnFlags: readonly DriverCapabilityFlag[];
  readonly diagnostics: readonly CapabilityProbeDiagnostic[];
}

/** What one detection read needs: the driver, the build, and the transport. */
export interface CapabilityDetectionReadRequest {
  readonly driverName: FlooredDriverName;
  /**
   * The resolved, symlink-dereferenced executable path the version handshake
   * proved — `SpawnedProviderVersionReading.resolvedExecutablePath`, threaded
   * from the same product that carried the version.
   *
   * REQUIRED, and never re-resolved by this module. A capability report is a
   * statement about one build, and a resolver consulted a second time can
   * legitimately answer differently (a `PATH` change, an installer swap); a
   * report composed from a version read off one executable and probes issued
   * against another would be wrong in a way nothing downstream could detect.
   */
  readonly boundExecutablePath: string;
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
 * IT RUNS ONLY WHERE IT VALIDATES SOMETHING. A driver whose table declares no
 * probe dispatches nothing at all, control included: with no probe to
 * misclassify, the control could only turn a report of entirely `static` flags
 * into a refused attach.
 *
 * @throws CapabilityProbeNegativeControlError when the control is answered.
 * @throws CapabilityProbeTransportError when the transport rejects.
 * @throws CapabilityProbeProhibitedNameError when a prohibited name would be issued.
 */
export async function readCapabilityDetection(
  request: CapabilityDetectionReadRequest,
): Promise<CapabilityDetectionReading> {
  const { driverName, boundExecutablePath, exchange } = request;
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

  const tableEntries = Object.entries(table) as [
    DriverCapabilityFlag,
    CapabilityDetectionMechanism,
  ][];
  const declaresProbe = tableEntries.some(
    ([, mechanism]) => mechanism.detectionSource === "probed",
  );

  if (declaresProbe) {
    const negativeControlName = CAPABILITY_PROBE_NEGATIVE_CONTROLS[driverName];
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

  // Deterministic order, and one dispatch per DISTINCT probe name: two flags
  // sharing a name must not double-issue it, and a re-issued name would make
  // the transport double's request count a poor proxy for what was probed.
  const answersByProbeName = new Map<string, ProbeAnswer>();
  for (const [flag, mechanism] of tableEntries) {
    detectionSource[flag] = mechanism.detectionSource;
    if (mechanism.detectionSource !== "probed") {
      continue;
    }
    // Conjunctive: every declared name must classify `accepted`, and the FIRST
    // that does not settles the flag. The remaining names of that flag are not
    // dispatched — the flag is already withdrawn, and a probe issues nothing it
    // does not need. A name another flag also declares is still dispatched when
    // that flag's turn comes.
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
  driverName: FlooredDriverName,
  probeName: string,
  boundExecutablePath: string,
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
      boundExecutablePath,
    });
  } catch (cause) {
    throw new CapabilityProbeTransportError(driverName, probeName, { cause });
  }
  return PROBE_REPLY_CLASSIFIERS[driverName](payload, probeName);
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
