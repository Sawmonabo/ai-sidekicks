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
// `SessionEventType`), because a scenario that scripted a type the daemon cannot
// emit would be a fixture teaching the console a shape it will never meet. There is
// deliberately NO invite beat: the invites read is unregistered on every transport,
// so the invite surfaces reach it through the growth port and render its refusal,
// and a scripted invite event would put data on screen the live console cannot get.

import type { ConsoleScenario } from "../scenario.js";

export const COLLABORATION_SCENARIO_ID = "collaboration";

const SESSION_ID = "session-collaboration";

export const COLLABORATION_SCENARIO: ConsoleScenario = {
  id: COLLABORATION_SCENARIO_ID,
  label: "A room with people in it",
  purpose:
    "A session with three participants and two channels — the roster, the channel list, and the members section are built against this one.",
  sessionId: SESSION_ID,
  participantIdsInJoinOrder: ["participant-you", "participant-priya", "participant-tomas"],
  startedAtIso: "2026-01-01T10:05:00.000Z",
  beats: [
    {
      atMs: 0,
      event: {
        sessionId: SESSION_ID,
        sequence: 1,
        kind: "session.created",
        occurredAt: "2026-01-01T10:05:00.000Z",
        actorParticipantId: "participant-you",
        payload: { title: "Relay sweep" },
      },
    },
    {
      atMs: 60,
      event: {
        sessionId: SESSION_ID,
        sequence: 2,
        kind: "membership.created",
        occurredAt: "2026-01-01T10:05:00.060Z",
        actorParticipantId: "participant-priya",
        payload: { role: "collaborator" },
      },
    },
    {
      atMs: 120,
      event: {
        sessionId: SESSION_ID,
        sequence: 3,
        kind: "membership.created",
        occurredAt: "2026-01-01T10:05:00.120Z",
        actorParticipantId: "participant-tomas",
        payload: { role: "observer" },
      },
    },
    {
      atMs: 200,
      event: {
        sessionId: SESSION_ID,
        sequence: 4,
        kind: "channel.created",
        occurredAt: "2026-01-01T10:05:00.200Z",
        actorParticipantId: "participant-you",
        payload: { channelId: "channel-main", name: "main" },
      },
    },
    {
      atMs: 260,
      event: {
        sessionId: SESSION_ID,
        sequence: 5,
        kind: "channel.created",
        occurredAt: "2026-01-01T10:05:00.260Z",
        actorParticipantId: "participant-priya",
        payload: { channelId: "channel-review", name: "review" },
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
