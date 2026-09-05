// The runtime-node roster seam: one registered read and one registered subscription.
//
// Both wires already exist. `runtimenode.roster` is the runtime-node namespace's
// only `query` and is control-plane tRPC ONLY — a daemon knows itself and nothing
// about its peers, so the reconciled roster is control-plane-owned cross-node
// coordination state — and the `runtime_node.*` lifecycle events are seven
// registered names in the session-event census. Neither is growth: no slate row is
// owed for either, and `growth-port.ts` refuses wires the corpus has NOT registered.
//
// WHY THE SEAM EXISTS AT ALL. The shipped `runtime-node-attach/NodeRoster.tsx`
// reaches the installed preload bridge's control-plane call and daemon subscribe
// namespaces directly. That works under the preload and cannot work under the
// fixture — the console resolves a `ConsoleBridge`, the shipped component reads the
// installed one, and the two are different objects — so the roster was the one
// settings surface with no reading in a fixture build. Putting the pair on
// `ConsoleBridge` is what makes a console-owned roster substitutable, and it is why
// the console's "no `window.sidekicks` outside the bridge" rule can be kept by
// STRUCTURE rather than by a guard that renders an absence.
//
// WHAT EACH BRIDGE DOES WITH THE PAIR
//
//   • The READ differs. The live bridge forwards it to `controlPlane.call` with the
//     registered procedure name; the fixture answers it from the scenario, which
//     carries the roster as data rather than as a scripted reply so that a reading
//     can CHANGE as the frozen clock advances (`scenario.ts`'s roster frames).
//   • The SUBSCRIPTION does not. Both bridges route it through their own
//     `daemon.subscribe`, because the fixture's `daemon.subscribe` already delivers
//     scenario beats routed by the registered event name — so one implementation
//     serves both and there is no second copy of the rule about which names a
//     presence subscription carries.
//
// THE READ NEVER REJECTS. It answers a `RuntimeNodeRosterOutcome`, which is the
// console's own two-arm shape: a served reply, or a refusal carrying the code the
// refuser used. `Spec-023 §Console Design (Meridian)` rule 9 renders a refusal's own
// code and sentence verbatim, and a promise that rejects would make every caller
// invent one in a `catch`. The refused arm IS a `ConsoleRefusal`, so a surface
// spreads it straight into the refusal primitives.
//
// WHERE THE TWO ARMS LIVE. This module holds the seam's VOCABULARY — the registered
// procedure name, the event census the presence set is derived from, the refusal
// codes, the outcome types — plus the FIXTURE read, which is scenario-driven and
// touches no transport. The two LIVE arms are `runtime-node-roster-transport.ts`
// beside it: they speak to a real `SidekicksBridge`, they carry the Plan-007 /
// Plan-008 brand casts, and they are driven by their own suite. One vocabulary, two
// arms, and neither arm can invent a name the other does not know.

import type {
  RuntimeNodeEventName,
  RuntimeNodeRosterRequest,
  RuntimeNodeRosterResponse,
  SessionId,
  Unsubscribe,
} from "@ai-sidekicks/contracts";

import { refuse, type WireRefusal } from "../core/index.js";
import type { ScenarioEngine } from "./scenario-engine.js";
import type { ScenarioRuntimeNodeRosterFrame } from "./scenario.js";

/**
 * The registered control-plane procedure that reads a session's node roster.
 *
 * Spelled verbatim, once. The name lives in the `runtimenode.*` METHOD namespace,
 * which deliberately carries no separator — distinct from the `runtime_node.*` EVENT
 * names below, whose underscore is part of the wire string.
 */
export const RUNTIME_NODE_ROSTER_PROCEDURE = "runtimenode.roster";

/** The subsystem name every refusal this seam raises carries. */
export const RUNTIME_NODE_ROSTER_REFUSAL_ORIGIN = "runtime-node-roster";

/**
 * Which axis a registered `runtime_node.*` name announces.
 *
 * Read off the payload contract rather than chosen here. Five of the seven names
 * carry the FULL lifecycle base — `{sessionId?, nodeId, previousState?, newState,
 * actor?}` — so each one announces a `NodeState` transition, which is exactly what
 * moves a roster row. The two capability names carry the REDUCED base, which has no
 * `previousState` / `newState` at all: a capability declaration is not a node-state
 * transition, and the registered shape says so by leaving both members off.
 */
type RuntimeNodeEventAxis = "state-transition" | "capability";

/**
 * Every registered `runtime_node.*` name, keyed rather than listed.
 *
 * `satisfies Record<RuntimeNodeEventName, …>` makes the table total in BOTH
 * directions against the contract: a newly registered eighth name is a missing-key
 * error here until it is classified, and a name this table invents is an excess-key
 * error. The import stays TYPE-ONLY — the renderer's initial-bundle budget is
 * enforced, and a value import of the census would pull the taxonomy module and its
 * schemas into the console — so the runtime cross-check against the exported name
 * set lives in the co-located test, which is not bundled.
 */
const RUNTIME_NODE_EVENT_AXIS_BY_NAME = {
  "runtime_node.registered": "state-transition",
  "runtime_node.online": "state-transition",
  "runtime_node.degraded": "state-transition",
  "runtime_node.offline": "state-transition",
  "runtime_node.revoked": "state-transition",
  "runtime_node.capability_declared": "capability",
  "runtime_node.capability_updated": "capability",
} as const satisfies Record<RuntimeNodeEventName, RuntimeNodeEventAxis>;

/**
 * The registered event names a presence subscription carries.
 *
 * All five state-transition names, including the two with no V1 producer. Two
 * reasons, and the second is the concrete one: `runtime_node.degraded` and
 * `runtime_node.revoked` are census members whose durable producers are V1.1-gated,
 * so subscribing to them costs one no-op subscription today and needs no console
 * change the day a producer lands — and the settings scenario already scripts a
 * `runtime_node.degraded` beat, which a subscription that skipped the name would
 * silently drop, leaving the roster stale exactly where the surface exists to show a
 * change.
 *
 * Derived from the table rather than written again, so the two cannot disagree.
 * `Object.keys` of the keyed record, narrowed the way `bridge-shape.ts` narrows its
 * namespace table: the keys of a record annotated `Record<RuntimeNodeEventName, …>`
 * ARE that union, and the filter then reads the table by key rather than
 * destructuring a widened entry pair, so the classification stays type-checked.
 */
export const RUNTIME_NODE_PRESENCE_EVENT_NAMES: readonly RuntimeNodeEventName[] = (
  Object.keys(RUNTIME_NODE_EVENT_AXIS_BY_NAME) as RuntimeNodeEventName[]
).filter((eventName) => RUNTIME_NODE_EVENT_AXIS_BY_NAME[eventName] === "state-transition");

/**
 * The codes the FIXTURE arm raises. Both are facts about the scenario.
 *
 * Kept apart from the wire arm's set below rather than pooled with it, because each
 * set is TOTAL for the arm that raises it and the two arms are driven by different
 * suites: pooled, neither census could claim every code it declares is reachable, and
 * a code nothing raises is exactly the drift a census exists to catch.
 */
export const RUNTIME_NODE_ROSTER_SCENARIO_REFUSAL_CODES: readonly [
  "roster-unscripted",
  "session-not-played",
] = ["roster-unscripted", "session-not-played"];

/**
 * The codes the LIVE arms fall back to, and only fall back to.
 *
 * A LAST RESORT, never a displacement. A live rejection that names a code of its own
 * — a carried refusal, a JSON-RPC `data.type`, a flat `{code, message}` envelope —
 * keeps it verbatim, because rule 9 renders the refuser's code and paraphrasing a
 * typed daemon refusal into a console-scoped one would replace the one string a
 * person pastes into a search. These three are what a rejection that named nothing
 * gets, plus the one failure the wire cannot name because the wire believes it
 * succeeded: a reply this console cannot read.
 */
export const RUNTIME_NODE_ROSTER_WIRE_REFUSAL_CODES: readonly [
  "roster-read-failed",
  "roster-reply-unreadable",
  "presence-subscribe-failed",
] = ["roster-read-failed", "roster-reply-unreadable", "presence-subscribe-failed"];

/** The roster read answered, with the registered reply verbatim. */
export interface RuntimeNodeRosterServed {
  readonly status: "served";
  readonly value: RuntimeNodeRosterResponse;
}

/**
 * Either half of this seam declined to answer, and this says why.
 *
 * ONE refusal shape for both, because a surface renders them the same way and two
 * structurally identical types would be two vocabularies to keep in step. A
 * `WireRefusal` widened with the discriminant, on the growth port's own pattern:
 * `isConsoleRefusal` answers true for it and the refusal primitives take it by
 * spread, so a surface renders this beside any other refusal without translating.
 *
 * `WireRefusal` rather than the bare `ConsoleRefusal` it extends, because the live
 * arms answer through the console's rejection normalizer and a rate-limited read
 * carries a `retry` bound the surface may render. Declaring the narrower supertype
 * would have kept the member on the object and hidden it from every reader — a hint
 * present on the wire and unreachable in the types, which is the one shape worse than
 * not carrying it.
 */
export interface RuntimeNodeRefused extends WireRefusal {
  readonly status: "refused";
}

/** What the roster read answers. Total; both arms render something. */
export type RuntimeNodeRosterOutcome = RuntimeNodeRosterServed | RuntimeNodeRefused;

/** Read one session's runtime-node roster. Never rejects. */
export type RuntimeNodeRosterRead = (
  request: RuntimeNodeRosterRequest,
) => Promise<RuntimeNodeRosterOutcome>;

/** A live presence subscription, and the handle that releases it. */
export interface RuntimeNodePresenceSubscribed {
  readonly status: "subscribed";
  readonly unsubscribe: Unsubscribe;
}

/**
 * What subscribing answers: a live subscription, or the refusal that says why not.
 *
 * A RETURNED refusal rather than a throw, and rather than a silent no-op handle,
 * because both of the alternatives are failures the console has already named. A
 * throw is what `frame/session-lifecycle.ts` calls "a crash inside a mount effect
 * rather than a refusal a surface can render" — and it is reachable, since the
 * preload's Tier-1 `daemon.subscribe` throws synchronously. A no-op handle is
 * worse: the surface would believe it is live, never re-read, and go quietly stale,
 * which is the one failure a live roster exists to prevent.
 */
export type RuntimeNodePresenceSubscription = RuntimeNodePresenceSubscribed | RuntimeNodeRefused;

/**
 * Subscribe to one session's runtime-node presence transitions.
 *
 * The handler takes NO payload, and the absence is the contract rather than a
 * simplification: a push is a change SIGNAL answered with a fresh read, so the
 * surface holds no second copy of the roster and cannot drift from it. It is also
 * the only honest shape — `DaemonEventPayload<E>` resolves to `unknown` under the
 * live bridge, and a typed payload here would be a fiction.
 */
export type RuntimeNodePresenceSubscribe = (
  sessionId: SessionId,
  onPresenceChange: () => void,
) => RuntimeNodePresenceSubscription;

/**
 * Read the roster from the scenario the fixture is playing. The fixture arm.
 *
 * Three answers, and the two refusals are different facts a surface draws
 * differently. A scenario that names no roster has not been asked — the honest
 * "not checked" absence, which is what a fixture build of a page whose data nobody
 * scripted must show. A request naming a session this scenario is not playing takes
 * the same refusal rather than this session's nodes: a roster is a fact about ONE
 * session's attachments, and lending another session's machines to it would be a
 * fabrication the surface would render as confidently as a reading.
 *
 * An EMPTY node set is NOT one of those: the registered response admits an empty
 * array — a session with no attachments yet — so a scenario that names a roster
 * with no rows has been asked and answered, and the surface draws its empty state.
 */
export function readRuntimeNodeRosterFromScenario(
  engine: ScenarioEngine,
  request: RuntimeNodeRosterRequest,
): RuntimeNodeRosterOutcome {
  const { scenario } = engine;
  if (request.sessionId !== scenario.sessionId) {
    return refusedByScenario(
      "session-not-played",
      `Not checked — scenario "${scenario.id}" plays session ${scenario.sessionId} and holds no roster for the session this read names.`,
    );
  }
  const frames = scenario.runtimeNodeRoster;
  const current = frames === undefined ? undefined : frameDueAt(frames, engine.progress.elapsedMs);
  if (current === undefined) {
    return refusedByScenario(
      "roster-unscripted",
      `Not checked — scenario "${scenario.id}" names no runtime-node roster at this tick. Add one to the scenario rather than letting the surface render an empty roster for a read that was never answered.`,
    );
  }
  // Copied out rather than handed over: `RuntimeNodeRosterResponse.nodes` is a
  // mutable array on the wire type, and a caller that sorted it in place would be
  // reordering the scenario itself for every later read in the window.
  return { status: "served", value: { nodes: [...current.nodes] } };
}

/** The roster reading current at `elapsedMs`, or `undefined` before the first. */
function frameDueAt(
  frames: readonly ScenarioRuntimeNodeRosterFrame[],
  elapsedMs: number,
): ScenarioRuntimeNodeRosterFrame | undefined {
  // Last wins rather than first: frames are readings of one roster over scenario
  // time, so the newest one that has fallen due is the current one.
  return frames.reduce<ScenarioRuntimeNodeRosterFrame | undefined>(
    (current, frame) => (frame.atMs <= elapsedMs ? frame : current),
    undefined,
  );
}

/**
 * The refusal the FIXTURE arm raises, held to this seam's own closed vocabulary.
 *
 * Two doors rather than one widened builder, on the growth port's pattern: the two
 * refusals are reached from opposite sides. This one's code is a fact about the
 * scenario and belongs to a set declared here, so passing a wire code through it is
 * a compile error rather than a convention.
 */
function refusedByScenario(
  code: (typeof RUNTIME_NODE_ROSTER_SCENARIO_REFUSAL_CODES)[number],
  detail: string,
): RuntimeNodeRefused {
  return runtimeNodeRefusal(code, detail);
}

/**
 * The one construction every door in this seam goes through, so `origin` is never
 * forgotten and no arm invents a second subsystem name for the same read.
 *
 * `code` is deliberately a `string` rather than the closed set: the transport module
 * beside this one also builds a refusal from a code the WIRE chose, and narrowing
 * here would mean paraphrasing a typed daemon refusal into a vocabulary this console
 * declared. Which codes this module ITSELF may choose is stated by the two closed
 * sets above and enforced where they are consumed.
 */
export function runtimeNodeRefusal(code: string, detail: string): RuntimeNodeRefused {
  return { ...refuse(RUNTIME_NODE_ROSTER_REFUSAL_ORIGIN, code, detail), status: "refused" };
}
