// The runs scenario: one run through the status vocabulary, and a queue behind it.
//
// It scripts the run-state subtypes the runs view reads — a block, an unblock, a
// pause, and a resume — because those are the four rows most easily conflated, and
// a fixture that only ever showed `running` would let the conflation ship. Waiting
// is not pausing: `run.blocked` and `run.paused` are separate beats here for the
// same reason they are separate rows there.
//
// The queue snapshot is a canned reply rather than a beat, because the queue is a
// read and not a stream of session events. Its rows carry the closed five-value
// item state verbatim — an admitted head that can no longer be taken back, and two
// still waiting that can.

import type { ConsoleScenario } from "../scenario.js";

const SESSION_ID = "session-runs";

export const RUNS_SCENARIO: ConsoleScenario = {
  id: "runs",
  label: "Run states",
  purpose:
    "One run moving through block, unblock, pause, and resume beside a queue carrying a run-bound row — the vocabulary the runs pane must render without inventing a state.",
  sessionId: SESSION_ID,
  participantIdsInJoinOrder: ["participant-you", "agent-implementer"],
  startedAtIso: "2026-01-01T16:00:00.000Z",
  beats: [
    {
      atMs: 0,
      event: {
        sessionId: SESSION_ID,
        sequence: 1,
        kind: "session.created",
        occurredAt: "2026-01-01T16:00:00.000Z",
        actorParticipantId: "participant-you",
        payload: { title: "Run status" },
      },
    },
    {
      atMs: 40,
      event: {
        sessionId: SESSION_ID,
        sequence: 2,
        kind: "agent.attached",
        occurredAt: "2026-01-01T16:00:00.040Z",
        actorParticipantId: "agent-implementer",
        payload: { agentId: "agent-implementer", displayName: "Implementer" },
      },
    },
    {
      atMs: 100,
      event: {
        sessionId: SESSION_ID,
        sequence: 3,
        kind: "run.queued",
        occurredAt: "2026-01-01T16:00:00.100Z",
        actorParticipantId: "agent-implementer",
        payload: { runId: "run-10", agentId: "agent-implementer" },
      },
    },
    {
      atMs: 160,
      event: {
        sessionId: SESSION_ID,
        sequence: 4,
        kind: "run.started",
        occurredAt: "2026-01-01T16:00:00.160Z",
        actorParticipantId: "agent-implementer",
        payload: { runId: "run-10" },
      },
    },
    {
      atMs: 300,
      event: {
        sessionId: SESSION_ID,
        sequence: 5,
        kind: "run.blocked",
        occurredAt: "2026-01-01T16:00:00.300Z",
        actorParticipantId: "agent-implementer",
        payload: { runId: "run-10", state: "waiting_for_approval" },
      },
    },
    {
      atMs: 520,
      event: {
        sessionId: SESSION_ID,
        sequence: 6,
        kind: "run.unblocked",
        occurredAt: "2026-01-01T16:00:00.520Z",
        actorParticipantId: "participant-you",
        payload: { runId: "run-10", state: "running" },
      },
    },
    {
      atMs: 700,
      event: {
        sessionId: SESSION_ID,
        sequence: 7,
        kind: "run.paused",
        occurredAt: "2026-01-01T16:00:00.700Z",
        actorParticipantId: "participant-you",
        payload: { runId: "run-10" },
      },
    },
    {
      atMs: 880,
      event: {
        sessionId: SESSION_ID,
        sequence: 8,
        kind: "run.resumed",
        occurredAt: "2026-01-01T16:00:00.880Z",
        actorParticipantId: "participant-you",
        payload: { runId: "run-10" },
      },
    },
  ],
  replies: [
    {
      call: "session.list",
      result: { sessions: [{ sessionId: SESSION_ID, title: "Run status", state: "active" }] },
    },
    {
      call: "agent.list",
      result: {
        agents: [{ agentId: "agent-implementer", displayName: "Implementer", state: "running" }],
      },
    },
    {
      call: "run.queueList",
      // Canonical order, FIFO within the target scheduling scope. The ids are
      // canonical UUIDs because `QueueItemIdSchema` is a BRANDED UUID: a readable
      // `queue-01` fails the registered parse, and because the list schema is
      // strict that failure takes the whole reply down rather than one row.
      //
      // NO RUN-BINDING MEMBER. The design asks the queue row to say which run it is
      // bound to, and the registered `QueueItemSummary` — `{ id, state, priority,
      // channelId?, createdAt, updatedAt }`, parsed `.strict()` — carries no run
      // member at all. A scripted `targetRunId` therefore fails the registered
      // parse and takes the WHOLE reply down with it, so the surface renders a
      // refusal where the scenario meant to show a queue. The binding arrives when
      // the wire grows the member; until then this reply is what the daemon can
      // actually send.
      result: {
        items: [
          {
            id: "5a7c1e20-3b4d-4e5f-8a90-1b2c3d4e5f60",
            state: "admitted",
            priority: 0,
            createdAt: "2026-01-01T16:00:00.090Z",
            updatedAt: "2026-01-01T16:00:00.160Z",
          },
          {
            id: "5a7c1e20-3b4d-4e5f-8a90-1b2c3d4e5f61",
            state: "queued",
            priority: 0,
            createdAt: "2026-01-01T16:00:00.410Z",
            updatedAt: "2026-01-01T16:00:00.410Z",
          },
          {
            id: "5a7c1e20-3b4d-4e5f-8a90-1b2c3d4e5f62",
            state: "queued",
            priority: 0,
            createdAt: "2026-01-01T16:00:00.640Z",
            updatedAt: "2026-01-01T16:00:00.640Z",
          },
        ],
      },
    },
  ],
};
