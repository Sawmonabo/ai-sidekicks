// What the collaboration scenario PLAYS: the session, its people, and its channels
// arriving on the stream.
//
// A beat is a stream frame and a reply is a read, and `collaboration.ts`'s header
// says which of this room's facts is which — the presence STATES are a reply and the
// presence pushes are beats, because the roster's whole discipline is that the read
// is the truth and the push is only a signal.
//
// Every `kind` below is a registered wire event type (`packages/contracts/src/event.ts`
// `SessionEventType`) CARRYING THE REGISTERED PAYLOAD, and `scenarios/wire-truth.ts`
// holds this file to both. Every subset but the session's own opening frame is DERIVED
// from the cast tables rather than written out — the memberships and the presence
// transitions from the roster, the channel-created frames and the one archival from the
// channel table — so the event and the read it is later answered by are two views of
// one row and cannot drift apart. The archival was the last one written by hand, and it
// said 340ms beside a table that already claimed the channel archived at zero.

import {
  COLLABORATION_CHANNELS,
  COLLABORATION_PARTICIPANTS,
  PARTICIPANT_YOU,
  RUNTIME_NODE_SCRIPT,
  SESSION_ID,
  type CollaborationParticipant,
} from "./identifiers.js";
import { collaborationRuntimeNodeBeats } from "./runtime-nodes.js";
import type { ConsoleScenario } from "../../scenario-runtime/index.js";

/**
 * The channels this script archives, with the tick each archival is due at.
 *
 * Pulled out rather than filtered inline so the archival beats can be numbered by
 * HOW MANY there are: the four subsets below share one contiguous line of log
 * positions, and a subset whose size is a filter's result cannot be counted by the
 * subset after it while it is being written.
 */
const COLLABORATION_ARCHIVALS: readonly { channelId: string; atMs: number }[] =
  COLLABORATION_CHANNELS.flatMap((channel) =>
    channel.archivedAtMs === undefined
      ? []
      : [{ channelId: channel.channelId, atMs: channel.archivedAtMs }],
  );

/** The people this script moves through a `presence.*` transition. Never the opener. */
const COLLABORATION_PRESENCE_MOVES: readonly Exclude<
  CollaborationParticipant,
  { presenceState: "online" }
>[] = COLLABORATION_PARTICIPANTS.filter(
  (participant): participant is Exclude<CollaborationParticipant, { presenceState: "online" }> =>
    participant.presenceState !== "online",
);

// WHERE EACH SUBSET STARTS IN THE LOG. `wire-truth/beat-order.ts` requires the whole
// script to be strictly contiguous from the session's first position, and these four
// subsets are derived from tables whose sizes are the tables' own business — so each
// opening position is COUNTED from the one in front of it rather than written down.
// The offsets were literals until the roster gained the opener's membership, at which
// point three of the four were silently one short and every beat after the new one
// read to the store as a duplicate.
const FIRST_MEMBERSHIP_SEQUENCE = 2;
const FIRST_CHANNEL_SEQUENCE = FIRST_MEMBERSHIP_SEQUENCE + COLLABORATION_PARTICIPANTS.length;
const FIRST_ARCHIVAL_SEQUENCE = FIRST_CHANNEL_SEQUENCE + COLLABORATION_CHANNELS.length;
const FIRST_PRESENCE_SEQUENCE = FIRST_ARCHIVAL_SEQUENCE + COLLABORATION_ARCHIVALS.length;

/** Every frame this room puts on the stream, in the order the clock releases them. */
export const COLLABORATION_BEATS: ConsoleScenario["beats"] = [
  {
    atMs: 0,
    event: {
      id: "019b7904-8ce0-7ea1-8110-cca0117a0401",
      sessionId: SESSION_ID,
      sequence: 1,
      kind: "session.created",
      occurredAt: "2026-01-01T10:05:00.000Z",
      actorId: PARTICIPANT_YOU,
      payload: { sessionId: SESSION_ID, config: {}, metadata: {} },
    },
  },
  // EVERY person in the room, the opener included and first: `session.create` emits
  // the creator's `membership.created` immediately after `session.created`, so a room
  // whose owner had no such beat was a room the membership fold could not name. The
  // filter that used to sit here selected the rows carrying a membership id, which was
  // the same claim written as a narrowing — and it silently stopped being a narrowing
  // of anything the moment the opener gained one.
  ...COLLABORATION_PARTICIPANTS.map((participant, joinIndex) => ({
    atMs: participant.joinedAtMs,
    event: {
      id: participant.membershipEventId,
      sessionId: SESSION_ID,
      sequence: FIRST_MEMBERSHIP_SEQUENCE + joinIndex,
      kind: "membership.created",
      occurredAt: participant.joinedAtIso,
      actorId: participant.participantId,
      payload: {
        membershipId: participant.membershipId,
        participantId: participant.participantId,
        role: participant.role,
        identityHandle: participant.identityHandle,
      },
    },
  })),
  ...COLLABORATION_CHANNELS.map((channel, channelIndex) => ({
    atMs: 200 + channelIndex * 40,
    event: {
      id: channel.eventId,
      sessionId: SESSION_ID,
      sequence: FIRST_CHANNEL_SEQUENCE + channelIndex,
      kind: "channel.created",
      occurredAt: `2026-01-01T10:05:00.${String(200 + channelIndex * 40)}Z`,
      actorId: PARTICIPANT_YOU,
      // The registered shape, verbatim: `{channelId, name?}`. A channel's state
      // and its participant count reach the console from `channel.list`, never
      // from the creation event, so neither is carried here — and an unnamed
      // channel OMITS the member rather than carrying it undefined, because
      // `name?` is an absent member on this wire and never a present empty one.
      payload:
        channel.name === undefined
          ? { channelId: channel.channelId }
          : { channelId: channel.channelId, name: channel.name },
    },
  })),
  // The archivals, derived from the channel table's own tick rather than written
  // beside it. One row declares one today; the shape is a map so a second archived
  // channel needs no edit here, and so the beat cannot claim a tick the row denies.
  ...COLLABORATION_ARCHIVALS.map((archival, archivalIndex) => ({
    atMs: archival.atMs,
    event: {
      id: `019b7904-8ce0-7ea1-8180-cca0117a04${String(8 + archivalIndex).padStart(2, "0")}`,
      sessionId: SESSION_ID,
      sequence: FIRST_ARCHIVAL_SEQUENCE + archivalIndex,
      kind: "channel.archived",
      occurredAt: `2026-01-01T10:05:00.${String(archival.atMs)}Z`,
      actorId: PARTICIPANT_YOU,
      // One of the four kinds `collaboration/channels/channel-model.ts` re-reads on, so
      // this beat is what proves the directory refreshes from a signal rather
      // than from a timer. The census registers no payload variant for it, so the
      // payload carries the channel the event is about and invents nothing else.
      payload: { sessionId: SESSION_ID, channelId: archival.channelId },
    },
  })),
  ...COLLABORATION_PRESENCE_MOVES.map((participant, presenceIndex) => ({
    atMs: 380 + presenceIndex * 20,
    event: {
      id: participant.presenceEventId,
      sessionId: SESSION_ID,
      sequence: FIRST_PRESENCE_SEQUENCE + presenceIndex,
      kind: `presence.${participant.presenceState}` as const,
      occurredAt: participant.lastSeenIso,
      actorId: participant.participantId,
      // Opaque BY CONTRACT. The roster treats every presence push as a change
      // signal and answers it with a fresh `presence.read`, so this payload is
      // never decoded by anything — which is exactly why it carries the two
      // identifiers the envelope is about and no third member.
      payload: { sessionId: SESSION_ID, participantId: participant.participantId },
    },
  })),
  // The machines number their own frames from the position this script declares, and
  // the two meet nowhere else — so what holds them together is the beat-order walk in
  // `wire-truth/beat-order.ts`, which reads a mismatch as the log gap it would be and
  // fails every shipped scenario over it. That is a stronger check than a constant
  // compared here, because it is run over the whole script rather than over one seam.
  ...collaborationRuntimeNodeBeats(RUNTIME_NODE_SCRIPT),
];
