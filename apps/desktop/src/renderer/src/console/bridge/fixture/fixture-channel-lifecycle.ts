// The four channel lifecycle acts, and the frame each one puts on the session feed.
//
// WHAT WAS MISSING, AND WHY IT MATTERED. A lifecycle act answered with the state the
// daemon put the channel in, and that was the whole of it: the fixture published
// nothing, so the four `channel.*` events the directory re-reads on could only ever
// arrive from an authored beat — a frame on a frozen clock, written before anybody
// pressed anything. Against a daemon the answer and the event are two halves of one
// act: the receipt settles the CALL and the event is what tells every other reader of
// that session, this window's own directory read included, that the row has moved. A
// fixture with only the first half trains a console on a wire whose second half never
// fires, so the re-read path the whole subject-scoped overlay is built around was
// exercised by nothing at all.
//
// THE IDENTITY IS DERIVED FROM THE RECEIPT AND NEVER FROM THE REQUEST. What was asked
// for and what happened are different facts, and the receipt is the one the daemon
// asserted — a scenario that answers a mute of one channel with a receipt naming
// another is scripting a daemon that moved that other channel, and the frame this
// publishes says so. Deriving from the request would make the fixture agree with the
// caller about something the caller does not decide.
//
// ONLY A SERVED ACT PUBLISHES. A refusal moved nothing, and a scenario that scripts no
// answer has not said anything happened, so both arms return the outcome untouched.
//
// AND THE CREATE IS THE FOURTH, WHICH IT ONCE WAS NOT. The three moves share one
// receipt shape and one registered payload — `{sessionId, channelId}`, the shape
// `collaboration/beats.ts`'s own `channel.archived` beat carries — so one derivation
// serves all three, and a create was left out because its own payload is a different
// shape. What that cost was the whole act: a served create returned its receipt, the
// form reported success and reset, and the channel appeared in no directory anywhere,
// because the scripted `channel.list` reply has no row for a channel nobody had created
// when the script was written and the only path that could add one is a lifecycle
// frame. So the create publishes too, on the registered `{channelId, name?}` — the
// identity off the RECEIPT like the three moves, and the NAME off the REQUEST because
// that is the only place a name exists at all: no receipt on this wire carries one.
//
// NOTHING HERE HOLDS A CLOCK OR A FEED. The frame goes onto the engine's own session
// stream through `appendEvent`, which is where every other delivery into a console
// store goes, so a late subscriber is replayed it and a subscribed one is handed it
// now. A namespace that emitted onto a feed of its own would be a second delivery path
// into stores the engine already owns.
//
// AND THE READ SIDE OF THE SAME LIFECYCLE IS `fixture-channel-directory.ts`, which folds
// the scripted `channel.list` reply over what this session's log has actually said. What
// stays here is the half that ACTS; what this hands that fold is the one fact the log
// cannot carry — how many people are in a channel this fixture was asked to create.
//
// WHICH IS WHY THE CREATE IS REMEMBERED. `channel.created` is registered as exactly
// `{channelId, name?}`, so a walk over the log knows a channel exists and knows nothing
// about who is in it. The REQUEST knows: a `direct` channel names its two humans and a
// `general` one names none, because a general channel takes the session's own
// membership. So the create records the membership it can defend at the moment it has
// the request, and the fold reads that rather than counting the creation's author —
// which reported one member for every channel anybody creates and zero for a scenario
// that declares no viewer, neither of which is a fact about a channel.

import { answerScriptedWrite } from "./fixture-scripted-answer.js";
import { fixtureSessionMembershipCount } from "./fixture-session-snapshot.js";
import type {
  GrowthChannelCreateReceipt,
  GrowthChannelLifecycleReceipt,
} from "../growth-values/index.js";
import type { GrowthOperationSignatures } from "../growth-signatures/index.js";
import type { GrowthOutcome, GrowthPort } from "../growth-port/index.js";
import type { ScenarioEngine } from "../scenario-runtime/index.js";

/** The three lifecycle verbs this stands in for, and the frame each one publishes. */
const CHANNEL_LIFECYCLE_MOVES = {
  channelMute: { call: "channel.mute", eventKind: "channel.muted" },
  channelUnmute: { call: "channel.unmute", eventKind: "channel.unmuted" },
  channelArchive: { call: "channel.archive", eventKind: "channel.archived" },
} as const;

/** One of the three. Derived, so the table above is the set's only declaration. */
type ChannelLifecycleMoveId = keyof typeof CHANNEL_LIFECYCLE_MOVES;

/**
 * The call a create is scripted under.
 *
 * Named here beside the act rather than spelled where the guard next door raises its
 * refusal, so the string has one home: `fixture-collaboration-reads.ts` scopes the
 * create to the session being played and has to name the same call this method
 * consults, and two literals would drift the day the method string moves.
 */
export const CHANNEL_CREATE_CALL = "channel.create";

/** The kind a creation announces itself under, and the state it leaves behind. */
export const CHANNEL_CREATED_EVENT_KIND = "channel.created";

/**
 * The identifier prefix an appended channel frame wears.
 *
 * UUID-shaped like every scripted event id, and from a range no scenario in the tree
 * writes, so a frame this fixture appended is distinguishable from one an author wrote
 * without either of them having to know about the other.
 */
const APPENDED_CHANNEL_EVENT_ID_PREFIX = "019bf1c7-0000-7000-8000-";

/**
 * The fixture's stand-in for the daemon's channel lifecycle.
 *
 * A class with private fields for `FixturePendingInvites`' reason: the three verbs
 * share one engine, one identifier line, and one rule about when a frame is published,
 * and three free helpers would each have to re-derive that rule from the scenario.
 */
export class FixtureChannelLifecycle {
  readonly #engine: ScenarioEngine;
  readonly #membershipByCreatedChannelId = new Map<string, number>();
  #appendedFrameCount = 0;

  public constructor(engine: ScenarioEngine) {
    this.#engine = engine;
  }

  /** The three lifecycle operations, ready to spread into the served port. */
  public operations(): Pick<GrowthPort, ChannelLifecycleMoveId> {
    return {
      channelMute: async (request) => await this.#move("channelMute", request),
      channelUnmute: async (request) => await this.#move("channelUnmute", request),
      channelArchive: async (request) => await this.#move("channelArchive", request),
    };
  }

  /**
   * How many people are in each channel this fixture was asked to create.
   *
   * The one fact the directory fold cannot read off the log, handed over as a map rather
   * than as a row so the fold keeps composing the row and this keeps deciding the
   * membership. A channel absent from it is one no create of this fixture's produced —
   * an authored `channel.created` beat, say — and the fold answers that from the
   * session's own membership, which is all such a frame supports.
   */
  public get membershipByCreatedChannelId(): ReadonlyMap<string, number> {
    return this.#membershipByCreatedChannelId;
  }

  /**
   * Answer a create from the script, and announce the channel it says was created.
   *
   * Reached by name rather than spread with the three above, because the create is the
   * one act of the four whose request carries a session — so the module that owns the
   * session guard calls this one directly, and the guard stays out of a module this
   * one is imported by.
   */
  public async createChannel(
    request: GrowthOperationSignatures["channelCreate"]["request"],
  ): Promise<GrowthOutcome<GrowthChannelCreateReceipt>> {
    const outcome = await answerScriptedWrite(
      this.#engine,
      CHANNEL_CREATE_CALL,
      "channelCreate",
      request,
    );
    if (outcome.status === "served") {
      // The membership is recorded BEFORE the frame, and off the request rather than off
      // the frame, because the frame cannot carry it: the registered payload is
      // `{channelId, name?}` and nothing else. See the header for why remembering it is
      // the only honest source.
      this.#membershipByCreatedChannelId.set(
        outcome.value.channelId,
        this.#membershipOfCreated(request),
      );
      // The registered `{channelId, name?}` and nothing beside it — the state and the
      // participant count reach a reader from `channel.list`, never from the creation
      // event, and an unnamed channel OMITS the member rather than carrying it
      // undefined, because `name?` is an absent member on this wire and never a
      // present empty one. Both are `collaboration/beats.ts`'s own statement about the
      // beat it writes by hand.
      this.#appendFrame(CHANNEL_CREATED_EVENT_KIND, {
        channelId: outcome.value.channelId,
        ...(request.name === undefined ? {} : { name: request.name }),
      });
    }
    return outcome;
  }

  /**
   * How many people one create request puts in the channel it asks for.
   *
   * TWO ARMS, AND THEY ARE THE WIRE'S OWN COUPLING. A `direct` channel IS its member
   * pair — the request carries exactly the two humans it is between and the daemon
   * refuses any other number — so the pair is the membership, counted rather than
   * assumed at two, which is what keeps this reading the request instead of restating a
   * rule. Every other channel takes the session's own membership, counted through
   * `fixture-session-snapshot.ts` so the act and the directory fold answer "who is in
   * this session" the same way, agents excluded.
   */
  #membershipOfCreated(request: GrowthOperationSignatures["channelCreate"]["request"]): number {
    if (request.kind === "direct" && request.memberPair !== undefined) {
      return request.memberPair.length;
    }
    return fixtureSessionMembershipCount(this.#engine.scenario, request.sessionId);
  }

  /** Answer one move from the script, and publish what it says the daemon did. */
  async #move(
    moveId: ChannelLifecycleMoveId,
    request: unknown,
  ): Promise<GrowthOutcome<GrowthChannelLifecycleReceipt>> {
    const move = CHANNEL_LIFECYCLE_MOVES[moveId];
    const outcome = await answerScriptedWrite(this.#engine, move.call, moveId, request);
    if (outcome.status === "served") {
      // The payload carries the session and the channel the envelope is about and
      // invents nothing else, because the census registers no payload variant for
      // these three kinds — the same restraint `collaboration/beats.ts` states for the
      // archival beat it writes by hand.
      this.#appendFrame(move.eventKind, {
        sessionId: this.#engine.scenario.sessionId,
        channelId: outcome.value.channelId,
      });
    }
    return outcome;
  }

  /**
   * Put one channel frame on this session's stream.
   *
   * The identifier line is here rather than in each caller, so the four acts number
   * their frames from one counter and none of them can reuse a position — which
   * `store/sequence-reconciler.ts` would drop as a duplicate. The actor is the
   * scenario's own viewer where it declares one and absent otherwise, which the
   * envelope composer renders as the system arm rather than as a participant this
   * fixture chose. The PAYLOAD is the caller's, because the four kinds do not share
   * one: a transition names the session and the channel, a creation names the channel
   * and what it was called.
   */
  #appendFrame(eventKind: string, payload: Readonly<Record<string, unknown>>): void {
    const { sessionId, viewingParticipantId } = this.#engine.scenario;
    this.#appendedFrameCount += 1;
    this.#engine.appendEvent({
      id: `${APPENDED_CHANNEL_EVENT_ID_PREFIX}${String(this.#appendedFrameCount).padStart(12, "0")}`,
      sessionId,
      kind: eventKind,
      occurredAt: new Date(this.#engine.clock.now()).toISOString(),
      ...(viewingParticipantId === undefined ? {} : { actorId: viewingParticipantId }),
      payload,
    });
  }
}
