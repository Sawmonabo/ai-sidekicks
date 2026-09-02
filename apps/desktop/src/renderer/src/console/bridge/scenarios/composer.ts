// The composer scenario: a session addressed to something, with a message pending.
//
// It exists so the composer's zones have a session to be addressed WITHIN. Two
// people and two agents, so a target is a real choice rather than the only one, and
// the newest run is `waiting_for_input` — the state in which a person's next
// sentence is the thing the session is blocked on, which is the moment the composer
// matters most.
//
// The beats carry wire-verbatim event kinds and nothing else. A scenario is data,
// so an invented kind here would be an invented kind everywhere it is projected.
// `scenarios/wire-truth.ts` holds this file to the census
// (`SESSION_EVENT_CATEGORY_BY_TYPE`) and to the strict payload layer
// (`SessionEventSchema`), both in `packages/contracts/src/event.ts`, which is why
// the identifiers below are the UUIDs the branded id types declare, `session.created`
// carries `{sessionId, config, metadata}` rather than a title, a person joining is
// `membership.created` rather than a `participant.*` type the census does not carry,
// and a run reaching a state is the event named for that state.

import type { ConsoleScenario } from "../scenario.js";

// UUID v7 values whose leading bytes are this scenario's own start instant, so a
// reader scanning a rendered id can still tell one fixture apart from another.
const SESSION_ID = "019b7a11-1100-75e5-8510-ada11a5a33a5";
const PARTICIPANT_YOU = "019b7a11-1100-79a4-8110-cca0117a0310";
const PARTICIPANT_PRIYA = "019b7a11-1100-79a4-8120-cca0117a0320";
const MEMBERSHIP_PRIYA = "019b7a11-1100-7e3b-8110-cca0117a0330";
const AGENT_IMPLEMENTER = "019b7a11-1100-7a6e-8110-d1a4c1150301";
const AGENT_REVIEWER = "019b7a11-1100-7a6e-8120-d1a4c1150302";
const RUN_ID = "019b7a11-1100-740e-8110-d1a4c1150311";

export const COMPOSER_SCENARIO: ConsoleScenario = {
  id: "composer",
  label: "Awaiting a reply",
  purpose:
    "A session whose newest run is blocked on a person's next message — the state the composer's target, posture, and send resolution are read against.",
  sessionId: SESSION_ID,
  participantIdsInJoinOrder: [
    PARTICIPANT_YOU,
    PARTICIPANT_PRIYA,
    AGENT_IMPLEMENTER,
    AGENT_REVIEWER,
  ],
  startedAtIso: "2026-01-01T11:05:00.000Z",
  beats: [
    {
      atMs: 0,
      event: {
        sessionId: SESSION_ID,
        sequence: 1,
        kind: "session.created",
        occurredAt: "2026-01-01T11:05:00.000Z",
        actorParticipantId: PARTICIPANT_YOU,
        // The registered shape, verbatim. A session's display name reaches the
        // console from the session read; the creation event carries no title, and
        // its `.strict()` payload rejects one.
        payload: { sessionId: SESSION_ID, config: {}, metadata: {} },
      },
    },
    {
      atMs: 60,
      event: {
        sessionId: SESSION_ID,
        sequence: 2,
        // A person joining a session is a membership event: `participant.*` is not
        // in the census at all.
        kind: "membership.created",
        occurredAt: "2026-01-01T11:05:00.060Z",
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
        kind: "agent.attached",
        occurredAt: "2026-01-01T11:05:00.120Z",
        actorParticipantId: AGENT_IMPLEMENTER,
        payload: { agentId: AGENT_IMPLEMENTER, displayName: "Implementer" },
      },
    },
    {
      atMs: 180,
      event: {
        sessionId: SESSION_ID,
        sequence: 4,
        kind: "agent.attached",
        occurredAt: "2026-01-01T11:05:00.180Z",
        actorParticipantId: AGENT_REVIEWER,
        payload: { agentId: AGENT_REVIEWER, displayName: "Reviewer" },
      },
    },
    {
      atMs: 260,
      event: {
        sessionId: SESSION_ID,
        sequence: 5,
        kind: "run.queued",
        occurredAt: "2026-01-01T11:05:00.260Z",
        actorParticipantId: AGENT_IMPLEMENTER,
        payload: { runId: RUN_ID, agentId: AGENT_IMPLEMENTER },
      },
    },
    {
      atMs: 320,
      event: {
        sessionId: SESSION_ID,
        sequence: 6,
        kind: "run.starting",
        occurredAt: "2026-01-01T11:05:00.320Z",
        actorParticipantId: AGENT_IMPLEMENTER,
        payload: { runId: RUN_ID },
      },
    },
    {
      atMs: 480,
      event: {
        sessionId: SESSION_ID,
        sequence: 7,
        // Waiting is not pausing: this run is blocked on someone, and the composer
        // is where that someone answers.
        kind: "run.waiting_for_input",
        occurredAt: "2026-01-01T11:05:00.480Z",
        actorParticipantId: AGENT_IMPLEMENTER,
        payload: { runId: RUN_ID },
      },
    },
  ],
  replies: [
    {
      call: "session.list",
      result: {
        sessions: [{ sessionId: SESSION_ID, title: "Composer addressing", state: "active" }],
      },
    },
    {
      call: "agent.list",
      result: {
        agents: [
          { agentId: AGENT_IMPLEMENTER, displayName: "Implementer", state: "waiting_for_input" },
          { agentId: AGENT_REVIEWER, displayName: "Reviewer", state: "idle" },
        ],
      },
    },
  ],
};
