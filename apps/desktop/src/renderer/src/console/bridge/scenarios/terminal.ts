// The terminal scenario — one shared shell changing hands.
//
// WHAT IT CAN SCRIPT, AND WHY IT IS MORE THAN THE BROWSER'S. The terminal's own
// renderer surface is unregistered (`Plan-023 §Console growth slate` row 3), but the
// lease is not: `pty.control_changed` is a registered event type with a closed
// five-member reason vocabulary, and the holder is a field on it. So the transitions
// this scenario scripts are wire-true today, and it is the terminal output — the
// bytes, the scrollback, the resize — that has no type to carry it and is absent
// here rather than invented.
//
// THE FIVE REASONS ARE THE POINT. `Spec-023 §Console Design (Meridian)` 8.8 requires
// every transition to render as a ledger line naming its reason, with the three
// automatic reasons kept distinct — the holder disconnected, the holder lost
// authorization, or the acquiring agent run left its running state. A fixture that
// scripted only `taken` and `released` would let a surface collapse the other three
// into one sentence and still look right, so all five appear below, in the order a
// session reaches them.
//
// The payload members are `Spec-006`'s own: a holder, the holder it replaced, and
// the reason. `holderParticipantId: null` is the free lease, and it is written as
// an explicit null rather than an omitted member because 8.8 makes an unheld lease
// an explicit state that reads differently from a suppressed one.

import type { ConsoleScenario } from "../scenario.js";

export const TERMINAL_SCENARIO_ID = "terminal";

const SESSION_ID = "session-terminal";

const HUMAN_PARTICIPANT_ID = "participant-you";
const SECOND_HUMAN_PARTICIPANT_ID = "participant-priya";

export const TERMINAL_SCENARIO: ConsoleScenario = {
  id: TERMINAL_SCENARIO_ID,
  label: "Lease changing hands",
  purpose:
    "The session's one shared shell moving between two people and an agent run, reaching all five transition reasons. The output stream is absent until the terminal pane's renderer surface is registered.",
  sessionId: SESSION_ID,
  participantIdsInJoinOrder: [HUMAN_PARTICIPANT_ID, SECOND_HUMAN_PARTICIPANT_ID, "agent-builder"],
  startedAtIso: "2026-01-01T16:40:00.000Z",
  beats: [
    {
      atMs: 0,
      event: {
        sessionId: SESSION_ID,
        sequence: 1,
        kind: "session.created",
        occurredAt: "2026-01-01T16:40:00.000Z",
        actorParticipantId: HUMAN_PARTICIPANT_ID,
        payload: { title: "Pair on the migration" },
      },
    },
    {
      atMs: 60,
      event: {
        sessionId: SESSION_ID,
        sequence: 2,
        kind: "participant.joined",
        occurredAt: "2026-01-01T16:40:00.060Z",
        actorParticipantId: SECOND_HUMAN_PARTICIPANT_ID,
        payload: { displayName: "Priya" },
      },
    },
    {
      atMs: 140,
      event: {
        sessionId: SESSION_ID,
        sequence: 3,
        kind: "agent.attached",
        occurredAt: "2026-01-01T16:40:00.140Z",
        actorParticipantId: "agent-builder",
        payload: { agentId: "agent-builder", displayName: "Builder" },
      },
    },
    {
      atMs: 400,
      event: {
        sessionId: SESSION_ID,
        sequence: 4,
        kind: "pty.control_changed",
        occurredAt: "2026-01-01T16:40:00.400Z",
        actorParticipantId: HUMAN_PARTICIPANT_ID,
        payload: {
          sessionId: SESSION_ID,
          holderParticipantId: HUMAN_PARTICIPANT_ID,
          previousHolderParticipantId: null,
          reason: "taken",
        },
      },
    },
    {
      atMs: 900,
      event: {
        sessionId: SESSION_ID,
        sequence: 5,
        kind: "pty.control_changed",
        occurredAt: "2026-01-01T16:40:00.900Z",
        actorParticipantId: HUMAN_PARTICIPANT_ID,
        payload: {
          sessionId: SESSION_ID,
          holderParticipantId: null,
          previousHolderParticipantId: HUMAN_PARTICIPANT_ID,
          reason: "released",
        },
      },
    },
    {
      atMs: 1200,
      event: {
        sessionId: SESSION_ID,
        sequence: 6,
        kind: "pty.control_changed",
        occurredAt: "2026-01-01T16:40:01.200Z",
        actorParticipantId: SECOND_HUMAN_PARTICIPANT_ID,
        payload: {
          sessionId: SESSION_ID,
          holderParticipantId: SECOND_HUMAN_PARTICIPANT_ID,
          previousHolderParticipantId: null,
          reason: "taken",
        },
      },
    },
    {
      atMs: 1800,
      event: {
        sessionId: SESSION_ID,
        sequence: 7,
        kind: "pty.control_changed",
        occurredAt: "2026-01-01T16:40:01.800Z",
        actorParticipantId: SECOND_HUMAN_PARTICIPANT_ID,
        payload: {
          sessionId: SESSION_ID,
          holderParticipantId: null,
          previousHolderParticipantId: SECOND_HUMAN_PARTICIPANT_ID,
          reason: "auto_released_disconnect",
        },
      },
    },
    {
      atMs: 2300,
      event: {
        sessionId: SESSION_ID,
        sequence: 8,
        kind: "pty.control_changed",
        occurredAt: "2026-01-01T16:40:02.300Z",
        actorParticipantId: HUMAN_PARTICIPANT_ID,
        payload: {
          sessionId: SESSION_ID,
          holderParticipantId: HUMAN_PARTICIPANT_ID,
          previousHolderParticipantId: null,
          reason: "taken",
        },
      },
    },
    {
      atMs: 2700,
      event: {
        sessionId: SESSION_ID,
        sequence: 9,
        kind: "pty.control_changed",
        occurredAt: "2026-01-01T16:40:02.700Z",
        actorParticipantId: HUMAN_PARTICIPANT_ID,
        payload: {
          sessionId: SESSION_ID,
          holderParticipantId: null,
          previousHolderParticipantId: HUMAN_PARTICIPANT_ID,
          reason: "auto_released_authorization_lost",
        },
      },
    },
    {
      atMs: 3100,
      event: {
        sessionId: SESSION_ID,
        sequence: 10,
        kind: "pty.control_changed",
        occurredAt: "2026-01-01T16:40:03.100Z",
        actorParticipantId: SECOND_HUMAN_PARTICIPANT_ID,
        payload: {
          sessionId: SESSION_ID,
          holderParticipantId: SECOND_HUMAN_PARTICIPANT_ID,
          previousHolderParticipantId: null,
          reason: "taken",
        },
      },
    },
    {
      atMs: 3600,
      event: {
        sessionId: SESSION_ID,
        sequence: 11,
        kind: "pty.control_changed",
        occurredAt: "2026-01-01T16:40:03.600Z",
        actorParticipantId: SECOND_HUMAN_PARTICIPANT_ID,
        payload: {
          sessionId: SESSION_ID,
          holderParticipantId: null,
          previousHolderParticipantId: SECOND_HUMAN_PARTICIPANT_ID,
          reason: "auto_released_run_idle",
        },
      },
    },
  ],
  // The two the frame's opening reads make, matching `first-run.ts`. The lease
  // methods are deliberately unscripted: a reply for `session.takeControl` would
  // script a claim no surface can make yet, and the holder the surface renders
  // comes off the beats above rather than off a call.
  replies: [
    { call: "session.list", result: { sessions: [{ sessionId: SESSION_ID }] } },
    { call: "agent.list", result: { agents: [{ agentId: "agent-builder" }] } },
  ],
};
