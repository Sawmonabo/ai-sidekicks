// The three channel lifecycle moves, and the frame each one puts on the session feed.
//
// WHAT WAS MISSING, AND WHY IT MATTERED. A lifecycle move answered with the state the
// daemon put the channel in, and that was the whole of it: the fixture published
// nothing, so the four `channel.*` events the directory re-reads on could only ever
// arrive from an authored beat — a frame on a frozen clock, written before anybody
// pressed anything. Against a daemon the answer and the event are two halves of one
// move: the receipt settles the CALL and the event is what tells every other reader of
// that session, this window's own directory read included, that the row has moved. A
// fixture with only the first half trains a console on a wire whose second half never
// fires, so the re-read path the whole subject-scoped overlay is built around was
// exercised by nothing at all.
//
// THE EVENT IS DERIVED FROM THE RECEIPT AND NEVER FROM THE REQUEST. What was asked for
// and what happened are different facts, and the receipt is the one the daemon
// asserted — a scenario that answers a mute of one channel with a receipt naming
// another is scripting a daemon that moved that other channel, and the frame this
// publishes says so. Deriving from the request would make the fixture agree with the
// caller about something the caller does not decide.
//
// ONLY A SERVED MOVE PUBLISHES. A refusal moved nothing, and a scenario that scripts no
// answer has not said anything happened, so both arms return the outcome untouched.
//
// THE THREE MOVES AND NOT THE CREATE. These three share one receipt shape and one
// registered payload — `{sessionId, channelId}`, the shape `collaboration.beats.ts`'s
// own `channel.archived` beat carries — so one derivation serves all three. A create is
// a different act: its `channel.created` payload carries the NAME, which lives on the
// request rather than on the receipt, and a row that did not exist before is not a
// transition on one that did. It is deliberately not folded in here.
//
// NOTHING HERE HOLDS A CLOCK OR A FEED. The frame goes onto the engine's own session
// stream through `appendEvent`, which is where every other delivery into a console
// store goes, so a late subscriber is replayed it and a subscribed one is handed it
// now. A namespace that emitted onto a feed of its own would be a second delivery path
// into stores the engine already owns.

import { answerScriptedWrite } from "./fixture-scripted-write.js";
import type { GrowthChannelLifecycleReceipt } from "../growth-values/index.js";
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

  /** Answer one move from the script, and publish what it says the daemon did. */
  async #move(
    moveId: ChannelLifecycleMoveId,
    request: unknown,
  ): Promise<GrowthOutcome<GrowthChannelLifecycleReceipt>> {
    const move = CHANNEL_LIFECYCLE_MOVES[moveId];
    const outcome = await answerScriptedWrite(this.#engine, move.call, moveId, request);
    if (outcome.status === "served") {
      this.#publishTransition(move.eventKind, outcome.value.channelId);
    }
    return outcome;
  }

  /**
   * Put one lifecycle transition on this session's stream.
   *
   * The payload carries the session and the channel the envelope is about and invents
   * nothing else, because the census registers no payload variant for these four kinds
   * — the same restraint `collaboration.beats.ts` states for the beat it writes by
   * hand. The actor is the scenario's own viewer where it declares one and absent
   * otherwise, which the envelope composer renders as the system arm rather than as a
   * participant this fixture chose.
   */
  #publishTransition(eventKind: string, channelId: string): void {
    const { sessionId, viewingParticipantId } = this.#engine.scenario;
    this.#appendedFrameCount += 1;
    this.#engine.appendEvent({
      id: `${APPENDED_CHANNEL_EVENT_ID_PREFIX}${String(this.#appendedFrameCount).padStart(12, "0")}`,
      sessionId,
      kind: eventKind,
      occurredAt: new Date(this.#engine.clock.now()).toISOString(),
      ...(viewingParticipantId === undefined ? {} : { actorId: viewingParticipantId }),
      payload: { sessionId, channelId },
    });
  }
}
