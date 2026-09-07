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
// holds this file to both. Two of the three subsets are DERIVED from the cast tables
// rather than written out — the memberships from the roster and the channel-created
// frames from the channel table — so the event and the read it is later answered by
// are two views of one row and cannot drift apart.

import {
  CHANNEL_HANDOFF,
  COLLABORATION_CHANNELS,
  COLLABORATION_PARTICIPANTS,
  PARTICIPANT_YOU,
  RUNTIME_NODE_SCRIPT,
  SESSION_ID,
  type CollaborationParticipant,
} from "./collaboration.identifiers.js";
import { collaborationRuntimeNodeBeats } from "./collaboration-runtime-nodes.js";
import type { ConsoleScenario } from "../scenario-runtime/index.js";

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
  ...COLLABORATION_PARTICIPANTS.filter(
    (participant): participant is Extract<CollaborationParticipant, { membershipId: string }> =>
      participant.membershipId !== undefined,
  ).map((participant, joinIndex) => ({
    atMs: participant.joinedAtMs ?? 0,
    event: {
      id: participant.membershipEventId,
      sessionId: SESSION_ID,
      sequence: 2 + joinIndex,
      kind: "membership.created",
      occurredAt: participant.joinedAtIso ?? "2026-01-01T10:05:00.000Z",
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
      sequence: 5 + channelIndex,
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
  {
    atMs: 340,
    event: {
      id: "019b7904-8ce0-7ea1-8180-cca0117a0408",
      sessionId: SESSION_ID,
      sequence: 9,
      kind: "channel.archived",
      occurredAt: "2026-01-01T10:05:00.340Z",
      actorId: PARTICIPANT_YOU,
      // One of the four kinds `collaboration/channels/channel-model.ts` re-reads on, so
      // this beat is what proves the directory refreshes from a signal rather
      // than from a timer. The census registers no payload variant for it, so the
      // payload carries the channel the event is about and invents nothing else.
      payload: { sessionId: SESSION_ID, channelId: CHANNEL_HANDOFF },
    },
  },
  ...COLLABORATION_PARTICIPANTS.filter(
    (participant): participant is Exclude<CollaborationParticipant, { presenceState: "online" }> =>
      participant.presenceState !== "online",
  ).map((participant, presenceIndex) => ({
    atMs: 380 + presenceIndex * 20,
    event: {
      id: participant.presenceEventId,
      sessionId: SESSION_ID,
      sequence: 10 + presenceIndex,
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
  ...collaborationRuntimeNodeBeats(RUNTIME_NODE_SCRIPT),
];
