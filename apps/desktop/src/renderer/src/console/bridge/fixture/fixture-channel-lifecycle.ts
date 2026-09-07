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
const CHANNEL_CREATED_EVENT_KIND = "channel.created";

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

/**
 * The state each `channel.*` frame leaves a channel in.
 *
 * The key set is the census's own `channel.` root, derived rather than listed, so a
 * lifecycle kind the corpus registers later fails this file instead of being folded as
 * nothing. The value is the registered `ChannelState` the frame leaves behind, which is
 * why `channel.unmuted` reads `active`: the wire has no `unmuted` state, and unmuting
 * is a return to the ordinary one. The CREATION is in the set for the same reason and
 * not as an exception to it — a channel that has just been created is in the ordinary
 * state, and reading its opening state off its own kind is what lets the walk below
 * treat a created row exactly as it treats a scripted one.
 *
 * Read off the EVENT rather than off the receipt the act answered with. The receipt is
 * what the scenario scripts and the event is what the session was told, and a directory
 * that folded receipts would answer a reader about an act no other reader of that
 * session saw.
 */
type ChannelLifecycleKind = Extract<SessionEventType, `channel.${string}`>;

const CHANNEL_STATE_BY_LIFECYCLE_KIND: Readonly<Record<ChannelLifecycleKind, ChannelState>> =
  Object.freeze({
    "channel.created": "active",
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
  const { stateByChannelId, creationsInLogOrder } = deliveredChannelDirectory(engine);
  if (stateByChannelId.size === 0) {
    return scripted;
  }
  const scriptedChannelIds = new Set(
    channels.map((channel: unknown) =>
      isWireRecord(channel) ? readWireString(channel["id"]) : undefined,
    ),
  );
  return {
    ...scripted,
    channels: [
      ...channels.map((channel: unknown) => {
        const channelId = isWireRecord(channel) ? readWireString(channel["id"]) : undefined;
        const delivered = channelId === undefined ? undefined : stateByChannelId.get(channelId);
        return delivered === undefined || !isWireRecord(channel)
          ? channel
          : { ...channel, state: delivered };
      }),
      // The rows the SCRIPT has none of, appended in the order the session was told
      // about them. The filter is what keeps a scenario that announces its own
      // channels — every shipped one does — from listing each of them twice: a row the
      // scripted reply already carries was moved above and must not arrive again.
      ...creationsInLogOrder
        .filter((creation) => !scriptedChannelIds.has(creation.channelId))
        .map((creation) => createdDirectoryRow(creation, stateByChannelId)),
    ],
  };
}

/** One channel this playback was told had been created, as the directory renders it. */
interface DeliveredChannelCreation {
  readonly channelId: string;
  readonly name: string | undefined;
  /**
   * How many people the log puts in the channel: its creator, or nobody it names.
   *
   * `ChannelListResponseChannel.participantCount` is required, so a created row has to
   * carry one, and the log supports exactly this much — the actor on the creation
   * envelope is in the channel they created, and no other membership of it has been
   * announced. A `direct` channel's second member is real and arrives on no wire this
   * fixture carries, so the count moves only when a directory read answers again.
   */
  readonly participantCount: number;
}

/** What the delivered log says about this session's channels. */
interface DeliveredChannelDirectory {
  readonly stateByChannelId: ReadonlyMap<string, ChannelState>;
  readonly creationsInLogOrder: readonly DeliveredChannelCreation[];
}

/**
 * The state each channel is left in by the frames delivered so far, and which of them
 * this playback was told had been created at all.
 *
 * ONE WALK, because both answers are the same reading of the same log and two walks
 * could disagree about which frames had landed. In log order with a plain overwrite,
 * because the log IS the order: the last frame a channel received is the state it is
 * in, and a fold that picked by kind rather than by position would decide that an
 * archived channel unmuted afterwards is still archived — or the reverse — depending on
 * which kind it happened to prefer. A creation is folded the same way, which is what
 * makes a channel created and then archived in one window read archived.
 *
 * THE CREATIONS ARE KEYED BY CHANNEL, not collected as a list, and that is not tidiness.
 * A scenario answers one call one way, so a room whose create receipt names a fixed
 * channel answers a second press with the same identity — and a list would then put two
 * rows for one channel in the directory, which is a shape no `channel.list` can send.
 * One key means one row; insertion order keeps it where the session first heard of it.
 */
function deliveredChannelDirectory(engine: ScenarioEngine): DeliveredChannelDirectory {
  const stateByChannelId = new Map<string, ChannelState>();
  const creationByChannelId = new Map<string, DeliveredChannelCreation>();
  for (const event of engine.deliveredEvents()) {
    const state = readLifecycleState(event.kind);
    const payload = isWireRecord(event.payload) ? event.payload : undefined;
    const channelId = payload === undefined ? undefined : readWireString(payload["channelId"]);
    if (state === undefined || channelId === undefined || payload === undefined) {
      continue;
    }
    stateByChannelId.set(channelId, state);
    if (event.kind === CHANNEL_CREATED_EVENT_KIND) {
      creationByChannelId.set(channelId, {
        channelId,
        name: readWireString(payload["name"]),
        participantCount: event.actorId === undefined ? 0 : 1,
      });
    }
  }
  return { stateByChannelId, creationsInLogOrder: [...creationByChannelId.values()] };
}

/**
 * One created channel as a directory row: `{id, name?, state, participantCount}`.
 *
 * The STATE comes from the walk rather than from the creation, so a channel created and
 * then moved reads where it ended up. The fallback is the state a creation announces —
 * unreachable, because the walk records one for every creation it collects, and named
 * rather than written as a literal so the two cannot disagree.
 */
function createdDirectoryRow(
  creation: DeliveredChannelCreation,
  stateByChannelId: ReadonlyMap<string, ChannelState>,
): Readonly<Record<string, unknown>> {
  return {
    id: creation.channelId,
    ...(creation.name === undefined ? {} : { name: creation.name }),
    state:
      stateByChannelId.get(creation.channelId) ??
      CHANNEL_STATE_BY_LIFECYCLE_KIND[CHANNEL_CREATED_EVENT_KIND],
    participantCount: creation.participantCount,
  };
}

/** The state this kind announces, or `undefined` for any kind that announces none. */
function readLifecycleState(eventKind: string): ChannelState | undefined {
  return Object.hasOwn(CHANNEL_STATE_BY_LIFECYCLE_KIND, eventKind)
    ? CHANNEL_STATE_BY_LIFECYCLE_KIND[eventKind as ChannelLifecycleKind]
    : undefined;
}
