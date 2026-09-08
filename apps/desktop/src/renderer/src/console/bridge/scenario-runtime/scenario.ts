// A scenario: the script the fixture bridge plays, held as DATA.
//
// `Spec-023 §Console Design (Meridian)` §The fixture bridge: "the fixture bridge
// serves scripted scenarios over async generators with a frozen clock … the fixture
// clock is the only clock the renderer reads in fixture mode."
//
// A scenario is therefore DATA, not code: an ordered script of events with the
// millisecond each is due, plus canned replies for request/response calls. That
// matters for two reasons beyond tidiness — a data scenario can be asserted against
// (the screenshot tier pins a frame by advancing to an exact tick), and a scenario
// that cannot reach the network or the clock cannot accidentally become flaky.
//
// WHAT IS NOT HERE. The engine that plays one, which is `scenario-engine.ts`. The
// two were one file until it grew past the ~400-line rule `apps/desktop/AGENTS.md`
// sets, and the seam that growth was crossing is exactly this one — WHAT a scenario
// is, against HOW it is played. The split is load-bearing rather than tidy: a seat
// board, the scenario manifest, and the architecture tier that holds every scenario
// to the wire's own truth all DESCRIBE scenarios and play none, so they stop here
// and never reach the engine's teardown rules or its held-reply queue.
//
// AND THE FRAME FAMILIES ARE NOT HERE EITHER, for the same rule one level down. What
// a reader opens this file for is the scenario's SHAPE — who is in it, what it
// answers, what it plays — and each family of tick-scheduled readings carries a page
// of its own reasoning in front of that. `scenario-frames.ts` holds the roster, the
// activity, the shell condition and the transport outage; `scenario-pending-invites.ts`
// holds the three deep-link tables, which are the one family that is not about the
// session on screen at all. Both are read by the fixture namespace that resolves them
// and re-exported from this directory's door beside the shape below.

import type { MembershipRole, UpdateState } from "@ai-sidekicks/contracts";

// Type-only, and into a subtree the console ABSORBS rather than one that mounts into
// it — `.dependency-cruiser.mjs`'s `console-not-plan-subtree` names the three absorbed
// families as the deliberate exception. The alias is `RuntimeNodeAttachRequest` minus
// its session id, derived from the shipped contract by construction, so restating its
// shape here would be a second spelling of one wire fact.
import type { RuntimeNodeAttachDraft } from "../../../runtime-node-attach/index.js";
import type { ConsoleSessionEvent } from "../../store/index.js";
import type { WireErrorEnvelope } from "../../core/index.js";
import type {
  ScenarioActivityFrame,
  ScenarioRuntimeNodeRosterFrame,
  ScenarioShellStatusFrame,
  ScenarioTransportOutage,
} from "./scenario-frames.js";
import type {
  ScenarioPendingInviteAttemptFrame,
  ScenarioPendingInviteFrame,
  ScenarioPendingInviteRefusedFrame,
} from "./scenario-pending-invites.js";
import type { ScriptedSignInCeremony } from "../web-authn/ceremony-outcome.js";

/** One scripted event and the tick it is due at, measured from scenario start. */
export interface ScenarioBeat {
  readonly atMs: number;
  readonly event: ConsoleSessionEvent;
}

/** What every canned reply carries, whichever way it settles. */
interface ScenarioReplyBase {
  /** The daemon method or control-plane procedure name, verbatim. */
  readonly call: string;
  /**
   * Simulated latency, so a loading state is reachable in the fixture.
   *
   * Measured in scenario time, which only the caller moves: the reply stays
   * pending until the engine has been advanced this far past the call. It bounds
   * BOTH arms — a refusal a real transport takes 400 ms to deliver is a loading
   * state before it is an error, and a fixture that refused instantly would let a
   * surface ship without ever rendering that half.
   */
  readonly afterMs?: number;
}

/** A canned reply that answers with a value. */
export interface ScenarioResolvingReply extends ScenarioReplyBase {
  readonly result: unknown;
  readonly refusal?: never;
  readonly resultFor?: never;
}

/**
 * The refusal shape a scenario scripts: the wire envelope plus its structured context.
 *
 * `WireErrorEnvelope` is `{code, message}` and closes there, which is right for the
 * shape every renderer catch arm matches on and WRONG for what a daemon actually
 * sends on the refusals that name something: `pty.control_held_by_other` carries the
 * holder, and a rate-limited refusal carries its retry bound. `core/wire-rejection.ts`
 * reads both positions the corpus registers — `data.fields` on a JSON-RPC envelope and
 * `details` on a flat one — so a fixture that could only script `{code, message}` left
 * every extension-reading surface unreachable from any scenario.
 *
 * The member is OPTIONAL and typed as the flat position, so a scenario that scripts a
 * bare envelope is unchanged and one that scripts context reaches the same reader a
 * live rejection reaches. It is deliberately not a second extension vocabulary:
 * `core/refusal-extensions.ts` remains the one closed registry of what may be read
 * out of it, and a member no reader is registered for is simply not read.
 */
export type ScenarioRefusalEnvelope = WireErrorEnvelope & {
  readonly details?: Readonly<Record<string, unknown>>;
};

/**
 * A canned reply that REFUSES, with the shape the wire refuses in.
 *
 * Without this arm no scenario could reach a refusal at all: the fixture's own
 * `FixtureBridgeError` names something the FIXTURE could not do, so every typed
 * daemon refusal a surface has to render — an artifact too large, an ingest at
 * capacity, a terminal permission denied, a control already held by someone else —
 * was unreachable, and the console's refusal renderings could only ever be driven
 * from the growth port's one typed absence.
 *
 * `WireErrorEnvelope` is not a second refusal vocabulary minted here. It is declared
 * in `src/shared/wire-errors.ts` and reached through `core/index.js`, which is the
 * console's one home for the wire's `{code, message}` shape and for
 * `normalizeWireRejection` — what every renderer catch arm already turns a rejection
 * into. `src/shared/` sits on no rung of the console's family DAG, so taking the
 * shape from `core` is what keeps one reading of it above that floor rather than one
 * per family. A fixture refusing in any other shape would train a surface against a
 * value the live bridge never sends.
 */
export interface ScenarioRejectingReply extends ScenarioReplyBase {
  readonly refusal: ScenarioRefusalEnvelope;
  readonly result?: never;
  readonly resultFor?: never;
}

/**
 * A canned reply the scenario COMPUTES from the request the caller actually sent.
 *
 * `replyFor` matches on the method NAME, which is right for a session-scoped read and
 * wrong for an entity-scoped one: a session holding two repo mounts asked
 * `repo.mountRead` twice and got the same mount back both times, so the second mount
 * and every state only it carried were unreachable — in the fixture and in every
 * capture taken from it — while the surfaces above read as though both had answered.
 *
 * Returning `undefined` means the scenario scripts no answer for THAT request and
 * settles exactly as an unscripted method does: refused by name, never resolved with
 * an absence, which renders as a claim about the session nothing checked.
 *
 * A COMPUTATION, NEVER A SECOND SCRIPT — no state, no mutation, called once per
 * settled reply, so a scenario stays replayable tick-for-tick on the frozen clock.
 * The request is typed `unknown` and is READ rather than destructured: this seam
 * reports settlements and throws none, so an exception raised in here leaves past
 * every refusal arm as itself.
 *
 * Which is also how a computed reply REFUSES. Returning `undefined` says the scenario
 * scripts no answer for that request, and settles as an unscripted call does; throwing
 * a `WireErrorEnvelope` says the daemon this scenario stands for would have refused,
 * and reaches the caller in exactly the shape the `refusal` arm reaches it in. The two
 * are different facts — an authoring gap and a scripted refusal — and a computed reply
 * that holds an entity table has both to report.
 *
 * AND IT IS HANDED THE INSTANT IT SETTLES AT, which is what lets a room answer a read
 * about a lifetime. A ledger row that expires forty seconds in was a fixed `pending`
 * for the life of the window: every re-read past the expiry answered the state the
 * scenario had at tick zero, so the one thing that room was written to show — an
 * invitation ageing out — was unreachable from it. The instant comes off the engine's
 * own frozen clock, so it is the SAME timeline the beats are due on rather than a
 * second one a reply could drift from, and a computation that ignores it settles
 * exactly where it always did.
 */
export interface ScenarioComputedReply extends ScenarioReplyBase {
  readonly resultFor: (request: unknown, settledAtMilliseconds: number) => unknown;
  readonly result?: never;
  readonly refusal?: never;
}

/**
 * A canned reply for one request/response call the scenario expects.
 *
 * Exactly one of `result` / `refusal` / `resultFor`, enforced by the `?: never`
 * member on each arm rather than by independent optionals — the arm-union idiom the
 * corpus already uses for `AgentAttachRequest` in
 * `docs/architecture/contracts/api-payload-contracts.md`. Independent optionals would
 * admit two at once (a reply that resolves AND refuses) and none at all (a reply that
 * settles no way), which are the two shapes nothing can serve.
 */
export type ScenarioReply = ScenarioResolvingReply | ScenarioRejectingReply | ScenarioComputedReply;

export interface ConsoleScenario {
  readonly id: string;
  /** Shown in the fixture picker. Short; a name, not a sentence. */
  readonly label: string;
  /** What this scenario is for, so a reader knows which to reach for. */
  readonly purpose: string;
  readonly sessionId: string;
  /** Participants in join order — the hue allocator's input (rule 2). */
  readonly participantIdsInJoinOrder: readonly string[];
  /**
   * Which of those participants this window IS, where the scenario states one.
   *
   * OPTIONAL, and the optionality is the point: join order is who opened the session
   * and who followed, on any machine, so reading its head as "me" is a fabrication —
   * and a surface handed a fabricated identity renders a role gate as though it had
   * been checked. A scenario that does not say leaves this absent and the fixture
   * refuses the caller-identity read, which is the honest "not checked" answer.
   *
   * When present it must be a member of `participantIdsInJoinOrder`: an identity
   * outside the roster is a viewer of some other session, and every surface that
   * resolves a role would look it up and find nothing. `scenarios/wire-truth.ts`
   * holds every scenario to that, the substrate's own two included.
   */
  readonly viewingParticipantId?: string;
  /**
   * The membership role each MEMBER of the roster holds, keyed by participant id.
   *
   * The fact `viewingParticipantId` is useless without. An identity read answers
   * WHICH entry of the roster this window is; every role-gated control then resolves
   * the role by looking that id up in the session's participant projection
   * (`store/selectors.ts`'s `membershipRoleOf`) — so a scenario that states a viewer
   * and no roles serves a successful identity read into a roster that holds nothing,
   * and every owner- and collaborator-gated control renders closed for a reason
   * nothing checked. That is indistinguishable, on screen, from a member who simply
   * has no elevated role.
   *
   * NOT A SECOND COPY OF THE ROSTER. `participantIdsInJoinOrder` stays the sole home
   * of the ORDER, which is what the hue allocator consumes; this is a different fact
   * about the same people, and `scenarios/wire-truth.ts` holds every key in it to
   * that list. Keyed rather than ordered for exactly that reason — an ordered second
   * list would be the order declared twice.
   *
   * PARTIAL ON PURPOSE, and the partiality carries meaning. A scenario's join order
   * holds everything that gets a hue, agents included, and an agent is attached
   * rather than admitted: it holds no membership and no role. So the members of the
   * session are exactly the keys here, and an id in the join order with no entry is
   * something the fixture does not claim to know the membership of.
   *
   * `MembershipRole` is the contract's, imported: it is the union
   * `MembershipRoleSchema` parses on the way back out, so a role stated here and a
   * role read there cannot be two vocabularies.
   */
  readonly membershipRoleByParticipantId?: Readonly<Record<string, MembershipRole>>;
  readonly beats: readonly ScenarioBeat[];
  readonly replies: readonly ScenarioReply[];
  /**
   * The session's runtime-node roster as it reads over scenario time.
   *
   * OPTIONAL, and the optionality is the answer rather than a gap: a scenario that
   * names no roster has not been asked, so the read refuses with the "not checked"
   * absence instead of resolving with an empty set. Those are different facts — "no
   * machine is attached" is a session state a surface draws, and "nobody asked" is
   * not — and a fixture that conflated them would train the roster to render an
   * empty table for a read that never happened.
   *
   * It is a scenario member rather than a `replies` row because the reply table is
   * keyed by call name and answers each call with one fixed value, which cannot
   * express a roster that moves. A scenario needing latency or a scripted daemon
   * refusal for some other call still uses `replies`; this member is the one read
   * whose ANSWER is a function of the clock.
   */
  readonly runtimeNodeRoster?: readonly ScenarioRuntimeNodeRosterFrame[];
  /**
   * The declaration a local runtime node would make about itself, where the scenario
   * states one.
   *
   * OPTIONAL, and the absence is the honest answer rather than a gap: the attach
   * declaration is a machine's claim about its own identity, contract version, health
   * and capabilities, and `Spec-023 §Trust Stance` puts its composition in the main
   * process, off the node registry — never in a renderer, which may not vouch for a
   * machine on its own word. A scenario that names none leaves the attach control
   * unmountable and the surface says so, which is exactly what a window with no such
   * registry behind it should say.
   *
   * Here rather than in a `replies` row because a reply is what the daemon ANSWERS and
   * this is what the caller SENDS — the reply table is keyed by call name and would
   * have to hold a request under the name of a mutation.
   */
  readonly runtimeNodeAttachDraft?: RuntimeNodeAttachDraft;
  /**
   * What the shell's updater reports, where the scenario states one.
   *
   * OPTIONAL, and the default is the one the fixture answered before this member
   * existed: a bare `idle` carrying no last-check instant. That default is load-
   * bearing rather than incidental — `UpdateState`'s `idle` arm carries an optional
   * `lastCheckedAt`, and a fixture that supplied one on every scenario would make
   * the never-checked arm unreachable in the deck, which is the arm a fresh install
   * is actually in.
   *
   * The updater is a SHELL surface rather than a daemon one, so it is a scenario
   * member and not a `replies` row: the reply table is keyed by daemon method or
   * control-plane procedure name, and `update.getState` is neither.
   */
  readonly updaterState?: UpdateState;
  /**
   * When this window's transport is lost and when it comes back, in scenario time.
   *
   * The fixture's half of the console's one transport-reconnect signal
   * (`bridge/transport/transport-reconnect.ts`): a scenario that names an outage
   * drives the signal through `unreachable` and back, and every reading wired to it
   * re-reads on the returning edge. A scenario that names none never reports a
   * reconnect, which is the honest reading of a window whose wire never went away.
   */
  readonly transportOutages?: readonly ScenarioTransportOutage[];
  /**
   * The session's live activity as it reads over scenario time.
   *
   * OPTIONAL, and the optionality is the answer rather than a gap — the roster
   * member's reading, applied here: a scenario that names no activity has not been
   * asked, so the read refuses with the "not checked" absence instead of resolving
   * with two empty lists. A scenario that DOES name activity and states a frame with
   * both lists empty has been asked and answered, and the indicators render nothing,
   * which is their ordinary state.
   */
  readonly activity?: readonly ScenarioActivityFrame[];
  /**
   * Invitations arriving on this window's deep link, and what accepting each does.
   *
   * OPTIONAL on the same rule, and load-bearing in the other direction too: the
   * confirmation is a whole-surface takeover, so a scenario that scripted one by
   * default would put a dialog in front of every screenshot of every other surface.
   */
  readonly pendingInvites?: readonly ScenarioPendingInviteFrame[];
  /**
   * Deep links whose preview could not be put, each with what a retry on it yields.
   *
   * A SECOND TABLE RATHER THAN A UNION MEMBER OF THE FIRST, because the two are keyed
   * on different handles and a fixture that merged them would have to guess which
   * kind a string names. Optional on the same rule as the invitations beside them.
   */
  readonly pendingInviteAttempts?: readonly ScenarioPendingInviteAttemptFrame[];
  /**
   * Deep links the control plane REFUSED, each with the code and sentence it sent.
   *
   * A THIRD TABLE, and the one with no handle at all: a refused preview mints neither
   * a reference nor an attempt, so it belongs in neither table beside it and a fixture
   * building deliveries out of those two could reach the feed's terminal arm from no
   * scenario at all. Optional on the same rule as its two neighbours.
   */
  readonly pendingInviteRefusals?: readonly ScenarioPendingInviteRefusedFrame[];
  /**
   * The host this scenario's node answers its control plane on.
   *
   * OPTIONAL on the roster member's rule, and the two states are different facts a
   * surface draws differently: a scenario that names a host lets the invite create
   * path reveal the link a person would actually send, and one that names none
   * leaves the host read refusing, which is what a console that has not been told
   * its own control plane renders.
   *
   * A BARE HOST, never a URL and never a scheme. `Spec-002 §Invite Delivery` fixes
   * the link's form, so the scenario states the one fact the wire would supply and
   * the composition stays in the one module that owns it — a scenario carrying a
   * whole link could spell the path differently from the console that renders it.
   */
  readonly controlPlaneHost?: string;
  /**
   * The shell's own condition as it reads over scenario time.
   *
   * OPTIONAL on {@link runtimeNodeRoster}'s reasoning, and the optionality carries
   * the same meaning: a scenario that names no frames has not been asked, so the
   * subscription refuses with the "not checked" absence instead of opening a stream
   * that would report a connected shell nobody scripted. It is a scenario member
   * rather than a `replies` row for that module's other reason — the reply table
   * answers one call with one fixed value, and this is a feed.
   */
  readonly shellStatus?: readonly ScenarioShellStatusFrame[];
  /**
   * What this host's WebAuthn ceremony answers, where the scenario states it.
   *
   * OPTIONAL on the `runtimeNodeRoster` reading: a scenario that says nothing has
   * not been asked, so the fixture refuses the ceremony exactly as it refuses every
   * other native capability it cannot stand in for, and the sign-in surface renders
   * the "not checked" absence. That is the honest state of a build with no ceremony,
   * and it is also the state the shipped Tier-1 preload is in.
   *
   * A SCENARIO MEMBER RATHER THAN A `replies` ROW because `reply-walk.ts` admits a
   * reply keyed only on a registered daemon method or a growth operation id, and the
   * ceremony is neither — it is a preload-bridge namespace the contract already
   * declares. It is also a fact about the HOST rather than about the session: which
   * authenticator this machine has, whether it does PRF, and whether the OS keystore
   * will hold what the ceremony mints.
   *
   * The type excludes this console's own `unavailable` arm, so a scenario cannot
   * script "there is no ceremony here" as though a host had answered it — that arm
   * is a reading the adapter makes when nothing answered at all. It carries a
   * SEQUENCE of assertion answers rather than one, for the reason its own declaration
   * states: the device grant's settlement arrives as a second assertion.
   */
  readonly signInCeremony?: ScriptedSignInCeremony;
  /** Wall-clock instant the frozen clock reports as "now" at tick zero. */
  readonly startedAtIso: string;
}
