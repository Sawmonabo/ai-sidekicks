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
// reaches `window.sidekicks.controlPlane.call` and `window.sidekicks.daemon
// .subscribe` directly. That works under the preload and cannot work under the
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
// TWO BRAND CASTS, AND WHY THEY ARE HERE. `CpProcedure` and `DaemonEvent` are
// `never`-shaped Plan-007/Plan-008 brands that no string literal is assignable to,
// so every caller in this repository casts — the three shipped Tier-1 components
// and `collaboration/wire-access.ts` each carry one. This module is the `bridge/`
// family's single copy, and it narrows rather than erases: the procedure NAME and
// the event NAME stay `string` (the genuinely untypeable half) while the request and
// the response are pinned to the contracts package's own types. When the brands
// narrow, the casts here and the family copy one level up are the sites that change.

import type {
  RuntimeNodeEventName,
  RuntimeNodeRosterRequest,
  RuntimeNodeRosterResponse,
  SessionId,
  SidekicksBridge,
  Unsubscribe,
} from "@ai-sidekicks/contracts";

import { normalizeWireRejection } from "../../../../shared/wire-errors.js";
import { refuse, type ConsoleRefusal } from "../core/index.js";
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
 * The codes this seam's own refusals carry.
 *
 * Both are FIXTURE facts: the scenario named no roster, or it names a different
 * session. A live refusal carries the wire's own code instead — rule 9 renders the
 * refuser's code verbatim, and paraphrasing a typed daemon refusal into a
 * console-scoped code would replace the one string a person pastes into a search.
 * That is why `ConsoleRefusal.code` stays a `string` on the outcome and this closed
 * set describes only what this module itself can raise.
 */
export const RUNTIME_NODE_ROSTER_REFUSAL_CODES: readonly [
  "roster-unscripted",
  "session-not-played",
] = ["roster-unscripted", "session-not-played"];

/** One refusal code this seam raises. Derived, so the vocabulary is declared once. */
export type RuntimeNodeRosterRefusalCode = (typeof RUNTIME_NODE_ROSTER_REFUSAL_CODES)[number];

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
 * `ConsoleRefusal` widened with the discriminant, on the growth port's own pattern:
 * `isConsoleRefusal` answers true for it and the refusal primitives take it by
 * spread, so a surface renders this beside any other refusal without translating.
 */
export interface RuntimeNodeRefused extends ConsoleRefusal {
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
 * Read the roster over the registered control-plane procedure. The live arm.
 *
 * The rejection is converted rather than propagated, and the wire's own code
 * survives the conversion: `normalizeWireRejection` rebuilds a `{code, message}`
 * envelope as an `Error` whose `name` IS the wire code, so a typed
 * `runtimenode.*` refusal reaches the surface as that code and not as a
 * console-scoped paraphrase. Anything else keeps its own error name, which is a
 * true statement about what failed rather than a guess.
 */
export async function readRuntimeNodeRosterOverControlPlane(
  sidekicks: SidekicksBridge,
  request: RuntimeNodeRosterRequest,
): Promise<RuntimeNodeRosterOutcome> {
  const callProcedure = sidekicks.controlPlane.call as unknown as (
    procedure: string,
    input: RuntimeNodeRosterRequest,
  ) => Promise<RuntimeNodeRosterResponse>;
  try {
    const value = await callProcedure(RUNTIME_NODE_ROSTER_PROCEDURE, request);
    return { status: "served", value };
  } catch (rejection: unknown) {
    const normalized = normalizeWireRejection(rejection);
    return refusedByWire(normalized.name, normalized.message);
  }
}

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

/**
 * Subscribe to the presence transitions of one session, over `daemon.subscribe`.
 *
 * ONE subscription per registered name, because the wire takes one name per call
 * and there is no stream that projects the family. The returned handle releases
 * every one of them, so a caller cannot half-detach.
 *
 * THE SESSION FILTER FAILS OPEN, deliberately. `daemon.subscribe` carries no
 * session parameter, so the filter has to run at the delivery boundary — and the
 * only thing this module may read off an `unknown` is a member the contract
 * declares. The lifecycle payloads carry `sessionId`, and the fixture delivers the
 * beat envelope, which carries it too; so a delivery that NAMES a different session
 * is dropped, and one that names none is delivered. That direction is the safe one:
 * an extra signal costs one coalesced re-read, while a dropped signal leaves the
 * roster silently stale, which is the failure a live roster exists to prevent.
 */
export function subscribeRuntimeNodePresence(
  sidekicks: SidekicksBridge,
  sessionId: SessionId,
  onPresenceChange: () => void,
): RuntimeNodePresenceSubscription {
  const subscribeToEvent = sidekicks.daemon.subscribe as unknown as (
    eventName: string,
    handler: (payload: unknown) => void,
  ) => Unsubscribe;
  const taken: Unsubscribe[] = [];
  const releaseAll = (): void => {
    for (const unsubscribe of taken.splice(0, taken.length)) {
      unsubscribe();
    }
  };
  for (const eventName of RUNTIME_NODE_PRESENCE_EVENT_NAMES) {
    try {
      taken.push(
        subscribeToEvent(eventName, (payload: unknown) => {
          if (namesAnotherSession(payload, sessionId)) {
            return;
          }
          onPresenceChange();
        }),
      );
    } catch (rejection: unknown) {
      // ALL OR NOTHING. A subscription that covered three of the five registered
      // names would deliver some transitions and drop others, which reads as a
      // roster that updates sometimes — the hardest kind of staleness to notice.
      // So the ones already taken are released and the whole attempt refuses,
      // carrying the thrower's own name and sentence rather than a paraphrase.
      releaseAll();
      const normalized = normalizeWireRejection(rejection);
      return refusedByWire(normalized.name, normalized.message);
    }
  }
  return { status: "subscribed", unsubscribe: releaseAll };
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

/** Does a delivered payload name a session other than the subscribed one? */
function namesAnotherSession(delivered: unknown, sessionId: SessionId): boolean {
  if (typeof delivered !== "object" || delivered === null) {
    return false;
  }
  const { sessionId: deliveredSessionId } = delivered as { readonly sessionId?: unknown };
  return typeof deliveredSessionId === "string" && deliveredSessionId !== sessionId;
}

/**
 * The refusal the FIXTURE arm raises, held to this seam's own closed vocabulary.
 *
 * Two doors rather than one widened builder, on the growth port's pattern: the two
 * refusals are reached from opposite sides. This one's code is a fact about the
 * scenario and belongs to a set declared here, so passing a wire code through it is
 * a compile error rather than a convention.
 */
function refusedByScenario(code: RuntimeNodeRosterRefusalCode, detail: string): RuntimeNodeRefused {
  return buildRuntimeNodeRefusal(code, detail);
}

/**
 * The refusal the LIVE arm raises, carrying the refuser's own code verbatim.
 *
 * `code` is deliberately a `string`: it is whatever the daemon or the transport
 * called the failure, and narrowing it to a set this module declares would mean
 * paraphrasing a typed refusal into a vocabulary the wire has never heard of.
 */
function refusedByWire(code: string, detail: string): RuntimeNodeRefused {
  return buildRuntimeNodeRefusal(code, detail);
}

/** The one construction both doors share, so `origin` is never forgotten. */
function buildRuntimeNodeRefusal(code: string, detail: string): RuntimeNodeRefused {
  return { ...refuse(RUNTIME_NODE_ROSTER_REFUSAL_ORIGIN, code, detail), status: "refused" };
}
