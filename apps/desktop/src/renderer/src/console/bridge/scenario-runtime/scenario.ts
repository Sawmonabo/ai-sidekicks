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

import type { MembershipRole, RuntimeNodeRosterEntry } from "@ai-sidekicks/contracts";

import type {
  GrowthActivitySnapshot,
  GrowthInviteOutcome,
  GrowthPendingInvite,
} from "../growth-values/index.js";
import type { ConsoleSessionEvent } from "../../store/index.js";
import type { WireErrorEnvelope } from "../../core/index.js";

/** One scripted event and the tick it is due at, measured from scenario start. */
export interface ScenarioBeat {
  readonly atMs: number;
  readonly event: ConsoleSessionEvent;
}

/**
 * One reading of a session's runtime-node roster, and the tick it becomes current.
 *
 * A frame rather than a single roster, and rather than a scripted reply, because a
 * roster CHANGES: the registered `runtimenode.roster` read is the source of truth
 * for the rendered set and a `runtime_node.*` beat only says WHEN to re-read, so a
 * fixture whose roster could not move would answer every re-read with the same rows
 * and make the whole snapshot-plus-signal discipline untestable. Mirrors
 * {@link ScenarioBeat} deliberately — same `atMs` measured from scenario start,
 * same "data, never code" posture — so a reader who has understood one has
 * understood the other.
 *
 * `nodes` is the registered `RuntimeNodeRosterEntry` set verbatim, so a scenario
 * carries BOTH health axes the wire carries — the slot axis `state` and the
 * sweep-owned `healthState` / `lastHeartbeatAt` pair — and no collapsed scalar,
 * which the wire does not have either. Reconciling them is the client's render-time
 * concern and a fixture that pre-reconciled them would answer a question the
 * surface exists to ask.
 */
export interface ScenarioRuntimeNodeRosterFrame {
  readonly atMs: number;
  readonly nodes: readonly RuntimeNodeRosterEntry[];
}

/**
 * One reading of the session's live activity, and the tick it becomes current.
 *
 * A frame rather than a scripted reply, for {@link ScenarioRuntimeNodeRosterFrame}'s
 * reason applied to a faster-moving fact: composing STARTS and STOPS inside one
 * scenario, and a reply table keyed by call name answers every read with one fixed
 * value. A frame table is what lets a scenario show a person begin to type, a second
 * person join them, and the first one stop — which is the only way the indicator's
 * folding rule and its empty state are both reachable from one script.
 *
 * The two Awareness fields are carried TOGETHER because one read answers both, and
 * because a scenario that could move them independently would invite an author to
 * script an agent indicator that outlives the run it belongs to.
 */
export interface ScenarioActivityFrame {
  readonly atMs: number;
  readonly activity: GrowthActivitySnapshot;
}

/**
 * One invitation arriving on this window's deep link, and what confirming it does.
 *
 * THE OUTCOME IS SCRIPTED BESIDE THE INVITATION rather than in the reply table,
 * because it is the answer to an ACT and not to a read: nothing produces an outcome
 * until a person presses the one control that accepts, so a scenario states what
 * would happen if they did and the fixture holds it until they do.
 *
 * `onRetry` is separate and optional for the same reason it exists on the wire: a
 * retryable failure is followed by a SECOND attempt on the same reference, and a
 * scenario that could only state one outcome could never show one succeed. Absent, a
 * retry re-delivers whatever `onConfirm` states.
 *
 * The invitation carries an opaque reference and no token, which is
 * `Plan-023 §Invariants` I-023-5 made unrepresentable: a fixture cannot script a raw
 * token onto this surface because the shape has nowhere to put one.
 */
export interface ScenarioPendingInviteFrame {
  readonly atMs: number;
  readonly invite: GrowthPendingInvite;
  readonly onConfirm: GrowthInviteOutcome;
  readonly onRetry?: GrowthInviteOutcome;
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
  readonly refusal: WireErrorEnvelope;
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
 */
export interface ScenarioComputedReply extends ScenarioReplyBase {
  readonly resultFor: (request: unknown) => unknown;
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
  /** Wall-clock instant the frozen clock reports as "now" at tick zero. */
  readonly startedAtIso: string;
}
