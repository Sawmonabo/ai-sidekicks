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
//
// AND THE READ SIDE OF THE SAME LIFECYCLE IS HERE, which is the half that was missing
// on both of its faces. `channel.list` was answered with the scenario's scripted reply
// verbatim for the whole playback, so a scenario whose script archives a channel at a
// tick reported it archived at tick ZERO — future state, exposed to every read before
// the beat — and the refresh that beat triggers then produced no transition, because
// the reply had not moved either. The same fixed answer swallowed the moves published
// above: a person archived a channel, the receipt settled, the frame landed, and the
// directory's re-read served the row's old state back. One fold answers both, because
// they are one question — what has this session's log actually said about this channel
// — and the scripted reply is its opening term rather than its whole answer.

import type { ChannelState, SessionEventType } from "@ai-sidekicks/contracts";

import { answerScriptedWrite } from "./fixture-scripted-write.js";
import { isWireRecord, readWireString } from "../../core/index.js";
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

/**
 * The state each `channel.*` transition puts a channel in.
 *
 * The key set is the census's own `channel.` root less the CREATION, which announces
 * a channel's existence rather than a move on one — derived rather than listed, so a
 * lifecycle kind the corpus registers later fails this file instead of being folded as
 * nothing. The value is the registered `ChannelState` the transition leaves behind,
 * which is why `channel.unmuted` reads `active`: the wire has no `unmuted` state, and
 * unmuting is a return to the ordinary one.
 *
 * Read off the EVENT rather than off the receipt the move answered with. The receipt
 * is what the scenario scripts and the event is what the session was told, and a
 * directory that folded receipts would answer a reader about a move no other reader of
 * that session saw.
 */
type ChannelLifecycleKind = Exclude<
  Extract<SessionEventType, `channel.${string}`>,
  "channel.created"
>;

const CHANNEL_STATE_BY_LIFECYCLE_KIND: Readonly<Record<ChannelLifecycleKind, ChannelState>> =
  Object.freeze({
    "channel.muted": "muted",
    "channel.unmuted": "active",
    "channel.archived": "archived",
  } satisfies Record<ChannelLifecycleKind, ChannelState>);

/**
 * The scripted directory, moved by every lifecycle frame this playback has delivered.
 *
 * The scripted reply is the state the directory OPENS in and the log is what has
 * happened to it since, so the answer is the second applied to the first — never the
 * first alone, which exposes state the script has not reached, and never the log
 * alone, which knows nothing about a channel no beat has moved.
 *
 * UNTYPED IN AND UNTYPED OUT, and it narrows rather than asserting. A scenario's reply
 * is authored by hand and reaches here before the call door has held it to the
 * registered shape, so a value that is not a directory is returned untouched for that
 * door to refuse — folding a state into a shape nothing recognised would replace a
 * legible contract failure with a mystery.
 */
export function foldChannelDirectoryOverLog(engine: ScenarioEngine, scripted: unknown): unknown {
  if (!isWireRecord(scripted)) {
    return scripted;
  }
  const channels: unknown = scripted["channels"];
  if (!Array.isArray(channels)) {
    return scripted;
  }
  const stateByChannelId = deliveredChannelStates(engine);
  if (stateByChannelId.size === 0) {
    return scripted;
  }
  return {
    ...scripted,
    channels: channels.map((channel: unknown) => {
      const channelId = isWireRecord(channel) ? readWireString(channel["id"]) : undefined;
      const delivered = channelId === undefined ? undefined : stateByChannelId.get(channelId);
      return delivered === undefined || !isWireRecord(channel)
        ? channel
        : { ...channel, state: delivered };
    }),
  };
}

/**
 * The state each channel is left in by the frames delivered so far.
 *
 * A walk in log order with a plain overwrite, because the log IS the order: the last
 * transition a channel received is the state it is in, and a fold that picked by kind
 * rather than by position would decide that an archived channel unmuted afterwards is
 * still archived — or the reverse — depending on which kind it happened to prefer.
 */
function deliveredChannelStates(engine: ScenarioEngine): ReadonlyMap<string, ChannelState> {
  const stateByChannelId = new Map<string, ChannelState>();
  for (const event of engine.deliveredEvents()) {
    const state = readLifecycleState(event.kind);
    const channelId = isWireRecord(event.payload)
      ? readWireString(event.payload["channelId"])
      : undefined;
    if (state === undefined || channelId === undefined) {
      continue;
    }
    stateByChannelId.set(channelId, state);
  }
  return stateByChannelId;
}

/** The state this kind announces, or `undefined` for any kind that announces none. */
function readLifecycleState(eventKind: string): ChannelState | undefined {
  return Object.hasOwn(CHANNEL_STATE_BY_LIFECYCLE_KIND, eventKind)
    ? CHANNEL_STATE_BY_LIFECYCLE_KIND[eventKind as ChannelLifecycleKind]
    : undefined;
}
