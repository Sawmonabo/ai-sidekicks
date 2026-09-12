// The read side of the channel lifecycle: what `channel.list` answers once frames have
// landed.
//
// A MODULE BESIDE THE ACTS RATHER THAN INSIDE THEM. `channel-lifecycle.ts` is
// what a person's press DOES — the receipt and the frame it publishes — and this is what
// every reader of that session then sees. They are two jobs over one plane, and the fold
// is the longer of them.
//
// WHY THERE IS A FOLD AT ALL. `channel.list` was answered with the scenario's scripted
// reply verbatim for the whole playback, so a scenario whose script archives a channel at
// a tick reported it archived at tick ZERO — future state, exposed to every read before
// the beat — and the refresh that beat triggers then produced no transition, because the
// reply had not moved either. The same fixed answer swallowed a served act: a person
// archived a channel, the receipt settled, the frame landed, and the re-read served the
// row's old state back. One fold answers both, because they are one question — what has
// this session's log actually said about this channel — and the scripted reply is its
// opening term rather than its whole answer.
//
// AND THE PARTICIPANT COUNT COMES FROM THE ACT, BECAUSE THE LOG CANNOT CARRY IT.
// `channel.created` is registered as exactly `{channelId, name?}`, so a walk over the log
// establishes that a channel exists and can fill in no count for it, while
// `ChannelListResponseChannel.participantCount` is required. So the lifecycle records what
// its own create put there and hands it here; a creation this fixture did not perform — an
// authored beat — takes the same figure, which is the one person driving this runtime.

import type { ChannelState, SessionEventType } from "@ai-sidekicks/contracts";

import {
  CHANNEL_CREATED_EVENT_KIND,
  CREATED_CHANNEL_PARTICIPANT_COUNT,
} from "./channel-lifecycle.js";
import {
  isWireRecord,
  payloadContradictsSession,
  payloadNamesSession,
  readWireString,
} from "../../../core/index.js";
import type { ScenarioEngine } from "../../scenario/runtime/index.js";

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
   * How many people are in the channel.
   *
   * The act's own answer where this fixture performed the create, and the same figure for
   * a creation that arrived as an authored beat, which carries no count at all.
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
 *
 * AND EVERY FRAME IS HELD TO ITS OWN ENVELOPE'S SESSION BEFORE IT MOVES A ROW. A
 * transition is keyed by `channelId` alone, so a frame delivered on this session whose
 * payload names another one used to move this session's channel on the strength of a
 * claim about somebody else's. The rule is
 * `core/wire-session-attribution.ts`'s and {@link statesThisSession} states which of its
 * two arms each kind warrants and why.
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
    if (!statesThisSession(event.kind, payload, event.sessionId)) {
      continue;
    }
    stateByChannelId.set(channelId, state);
    if (event.kind === CHANNEL_CREATED_EVENT_KIND) {
      creationByChannelId.set(channelId, {
        channelId,
        name: readWireString(payload["name"]),
        participantCount: CREATED_CHANNEL_PARTICIPANT_COUNT,
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

/**
 * Whether one channel frame's PAYLOAD may be read as this session's.
 *
 * TWO ARMS, AND THE ASYMMETRY IS THE CONTRACT'S rather than this module's.
 *
 * The three TRANSITIONS take the required arm. The wire gives `channel.muted`,
 * `channel.unmuted` and `channel.archived` a `{sessionId, channelId}` payload, and both
 * producers write it — the beats a scenario authors by hand and the frames
 * `channel-lifecycle.ts` publishes from a served act — so a transition that omits
 * the member is malformed rather than terse, and one that names another session is a
 * frame no daemon emits. Either way it moves no row here: the whole of the fixture's
 * subject-scoping discipline is that a reading about one session is never composed from a
 * claim about a different one.
 *
 * `channel.created` takes the contradiction arm. It is the one kind here the corpus
 * registers a payload variant for, and that variant is exactly `{channelId, name?}` with
 * no `sessionId` in it at all — so requiring one would refuse every creation the fixture
 * itself publishes, and only a PRESENT member naming somewhere else is refused.
 *
 * A REFUSED FRAME YIELDS NO ROW AND NOTHING ELSE, which is the disposition that
 * projection gives the same contradiction. This fold is recomputed on every
 * `channel.list` read, so a report raised from inside it would fire once per read of a
 * scenario that carries one bad beat rather than once per defect — and the fixture's own
 * home for "this scenario contradicts the shipped wire contract" is the wire-truth walk
 * in `scenario/wire-truth/`, which reads each scenario once and names the beat.
 */
function statesThisSession(
  eventKind: string,
  payload: Readonly<Record<string, unknown>>,
  envelopeSessionId: string,
): boolean {
  return eventKind === CHANNEL_CREATED_EVENT_KIND
    ? !payloadContradictsSession(payload, envelopeSessionId)
    : payloadNamesSession(payload, envelopeSessionId);
}

/** The state this kind announces, or `undefined` for any kind that announces none. */
function readLifecycleState(eventKind: string): ChannelState | undefined {
  return Object.hasOwn(CHANNEL_STATE_BY_LIFECYCLE_KIND, eventKind)
    ? CHANNEL_STATE_BY_LIFECYCLE_KIND[eventKind as ChannelLifecycleKind]
    : undefined;
}
