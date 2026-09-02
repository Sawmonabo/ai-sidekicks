// The collaboration scenario — skeleton.
//
// A session that has PEOPLE and CHANNELS in it, which is the one thing neither
// substrate scenario supplies: `first-run` has a single participant and no
// structure, and `flagship` is about four agents working at once. The roster, the
// channel list, and the members section are built against this one.
//
// The join order is load-bearing for the same reason it is in `flagship.ts`:
// `Spec-023 §Console Design (Meridian)` rule 2 allocates participant hues by
// join-log order, so this array is what the hue allocator consumes and what a
// screenshot baseline of the roster depends on.
//
// Every `kind` below is a registered wire event type (`packages/contracts/src/event.ts`
// `SessionEventType`) CARRYING THE REGISTERED PAYLOAD, and `scenarios/wire-truth.ts`
// holds this file to both. A fixture that scripted a type the daemon cannot emit —
// or a payload its `.strict()` schema rejects — would teach the console a shape it
// will never meet, and every screenshot and end-to-end result taken against it
// would look like a pass. Two consequences a reader meets first, the same two
// `flagship.ts` records: the identifiers are the branded UUIDs the strict layer
// declares, and `session.created` carries `{sessionId, config, metadata}` rather
// than a title — a session's display name reaches the console from the session
// read, never from the creation event. The roles are the wire's four
// (`MembershipRole` in `packages/contracts/src/session.ts`), which is the same
// closed set `collaboration/members-model.ts` reads.
//
// There is deliberately NO invite beat: the invites read is unregistered on every
// transport, so the invite surfaces reach it through the growth port and render its
// refusal, and a scripted invite event would put data on screen the live console
// cannot get.

import type { ConsoleScenario } from "../scenario.js";

export const COLLABORATION_SCENARIO_ID = "collaboration";

// Wire identifiers, spelled as the wire spells them — UUID v7 values whose leading
// bytes are this scenario's own start instant, so a rendered id still tells one
// fixture apart from another.
const SESSION_ID = "019b7904-8ce0-75e5-8510-ada11a5a33a5";
const PARTICIPANT_YOU = "019b7904-8ce0-79a4-8110-cca0117a0330";
const PARTICIPANT_PRIYA = "019b7904-8ce0-79a4-8120-cca0117a0340";
const PARTICIPANT_TOMAS = "019b7904-8ce0-79a4-8130-cca0117a0350";
const MEMBERSHIP_PRIYA = "019b7904-8ce0-7e3b-8110-cca0117a0360";
const MEMBERSHIP_TOMAS = "019b7904-8ce0-7e3b-8120-cca0117a0370";
const CHANNEL_MAIN = "019b7904-8ce0-7c11-8110-cca0117a0380";
const CHANNEL_REVIEW = "019b7904-8ce0-7c11-8120-cca0117a0390";

export const COLLABORATION_SCENARIO: ConsoleScenario = {
  id: COLLABORATION_SCENARIO_ID,
  label: "A room with people in it",
  purpose:
    "A session with three participants and two channels — the roster, the channel list, and the members section are built against this one.",
  sessionId: SESSION_ID,
  participantIdsInJoinOrder: [PARTICIPANT_YOU, PARTICIPANT_PRIYA, PARTICIPANT_TOMAS],
  startedAtIso: "2026-01-01T10:05:00.000Z",
  beats: [
    {
      atMs: 0,
      event: {
        sessionId: SESSION_ID,
        sequence: 1,
        kind: "session.created",
        occurredAt: "2026-01-01T10:05:00.000Z",
        actorParticipantId: PARTICIPANT_YOU,
        payload: { sessionId: SESSION_ID, config: {}, metadata: {} },
      },
    },
    {
      atMs: 60,
      event: {
        sessionId: SESSION_ID,
        sequence: 2,
        kind: "membership.created",
        occurredAt: "2026-01-01T10:05:00.060Z",
        actorParticipantId: PARTICIPANT_PRIYA,
        payload: {
          membershipId: MEMBERSHIP_PRIYA,
          participantId: PARTICIPANT_PRIYA,
          role: "collaborator",
          identityHandle: "priya",
        },
      },
    },
    {
      atMs: 120,
      event: {
        sessionId: SESSION_ID,
        sequence: 3,
        kind: "membership.created",
        occurredAt: "2026-01-01T10:05:00.120Z",
        actorParticipantId: PARTICIPANT_TOMAS,
        // `viewer` is the wire's read-only role. There is no `observer` on this
        // wire, and the members model refuses one, so a fixture that played it
        // would be scripting a role no session can hold.
        payload: {
          membershipId: MEMBERSHIP_TOMAS,
          participantId: PARTICIPANT_TOMAS,
          role: "viewer",
          identityHandle: "tomas",
        },
      },
    },
    {
      atMs: 200,
      event: {
        sessionId: SESSION_ID,
        sequence: 4,
        kind: "channel.created",
        occurredAt: "2026-01-01T10:05:00.200Z",
        actorParticipantId: PARTICIPANT_YOU,
        payload: { channelId: CHANNEL_MAIN, name: "main" },
      },
    },
    {
      atMs: 260,
      event: {
        sessionId: SESSION_ID,
        sequence: 5,
        kind: "channel.created",
        occurredAt: "2026-01-01T10:05:00.260Z",
        actorParticipantId: PARTICIPANT_PRIYA,
        payload: { channelId: CHANNEL_REVIEW, name: "review" },
      },
    },
  ],
  replies: [
    {
      call: "session.list",
      result: {
        sessions: [{ sessionId: SESSION_ID, title: "Relay sweep", state: "active" }],
      },
    },
    { call: "agent.list", result: { agents: [] } },
  ],
};
