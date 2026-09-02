// The runs scenario: one run through the status vocabulary, and a queue behind it.
//
// It scripts the run-state subtypes the runs view reads — a block, an unblock, a
// pause, and a resume — because those are the four rows most easily conflated, and
// a fixture that only ever showed `running` would let the conflation ship. Waiting
// is not pausing: `run.waiting_for_approval` and `run.paused` are separate beats
// here for the same reason they are separate rows there.
//
// The queue snapshot is a canned reply rather than a beat, because the queue is a
// read and not a stream of session events. Its rows carry the closed five-value
// item state verbatim — an admitted head that can no longer be taken back, and two
// still waiting that can.
//
// `scenarios/wire-truth.ts` holds the beats below to the census
// (`SESSION_EVENT_CATEGORY_BY_TYPE`) and to the strict payload layer
// (`SessionEventSchema`), both in `packages/contracts/src/event.ts`. Two
// consequences a reader will notice: the identifiers are the UUIDs the branded id
// types declare, and a run REACHING a state is the event named for that state —
// `run.waiting_for_approval`, `run.running`, `run.paused` — because the census
// registers one type per run state and no separate block, unblock, or resume verb.

import type { ConsoleScenario } from "../scenario.js";

// UUID v7 values whose leading bytes are this scenario's own start instant, so a
// reader scanning a rendered id can still tell one fixture apart from another.
const SESSION_ID = "019b7a22-2200-75e5-8510-ada11a5a44a5";
const PARTICIPANT_YOU = "019b7a22-2200-79a4-8110-cca0117a0410";
const AGENT_IMPLEMENTER = "019b7a22-2200-7a6e-8110-d1a4c1150401";
const RUN_ID = "019b7a22-2200-740e-8110-d1a4c1150411";

export const RUNS_SCENARIO: ConsoleScenario = {
  id: "runs",
  label: "Run states",
  purpose:
    "One run moving through block, unblock, pause, and resume beside a queue carrying a run-bound row — the vocabulary the runs pane must render without inventing a state.",
  sessionId: SESSION_ID,
  participantIdsInJoinOrder: [PARTICIPANT_YOU, AGENT_IMPLEMENTER],
  startedAtIso: "2026-01-01T16:00:00.000Z",
  beats: [
    {
      atMs: 0,
      event: {
        sessionId: SESSION_ID,
        sequence: 1,
        kind: "session.created",
        occurredAt: "2026-01-01T16:00:00.000Z",
        actorParticipantId: PARTICIPANT_YOU,
        // The registered shape, verbatim. A session's display name reaches the
        // console from the session read; the creation event carries no title, and
        // its `.strict()` payload rejects one.
        payload: { sessionId: SESSION_ID, config: {}, metadata: {} },
      },
    },
    {
      atMs: 40,
      event: {
        sessionId: SESSION_ID,
        sequence: 2,
        kind: "agent.attached",
        occurredAt: "2026-01-01T16:00:00.040Z",
        actorParticipantId: AGENT_IMPLEMENTER,
        payload: { agentId: AGENT_IMPLEMENTER, displayName: "Implementer" },
      },
    },
    {
      atMs: 100,
      event: {
        sessionId: SESSION_ID,
        sequence: 3,
        kind: "run.queued",
        occurredAt: "2026-01-01T16:00:00.100Z",
        actorParticipantId: AGENT_IMPLEMENTER,
        payload: { runId: RUN_ID, agentId: AGENT_IMPLEMENTER },
      },
    },
    {
      atMs: 160,
      event: {
        sessionId: SESSION_ID,
        sequence: 4,
        kind: "run.starting",
        occurredAt: "2026-01-01T16:00:00.160Z",
        actorParticipantId: AGENT_IMPLEMENTER,
        payload: { runId: RUN_ID },
      },
    },
    {
      atMs: 300,
      event: {
        sessionId: SESSION_ID,
        sequence: 5,
        kind: "run.waiting_for_approval",
        occurredAt: "2026-01-01T16:00:00.300Z",
        actorParticipantId: AGENT_IMPLEMENTER,
        payload: { runId: RUN_ID },
      },
    },
    {
      atMs: 520,
      event: {
        sessionId: SESSION_ID,
        sequence: 6,
        // The unblock is the run reaching `running` again — the census has no
        // separate unblock verb, and inventing one would name a wire nobody serves.
        kind: "run.running",
        occurredAt: "2026-01-01T16:00:00.520Z",
        actorParticipantId: PARTICIPANT_YOU,
        payload: { runId: RUN_ID },
      },
    },
    {
      atMs: 700,
      event: {
        sessionId: SESSION_ID,
        sequence: 7,
        kind: "run.paused",
        occurredAt: "2026-01-01T16:00:00.700Z",
        actorParticipantId: PARTICIPANT_YOU,
        payload: { runId: RUN_ID },
      },
    },
    {
      atMs: 880,
      event: {
        sessionId: SESSION_ID,
        sequence: 8,
        // The resume, likewise: a resumed run is a run that is `running`. The pause
        // above and this beat are two transitions into two different states, which
        // is what keeps them distinguishable without a verb the wire does not have.
        kind: "run.running",
        occurredAt: "2026-01-01T16:00:00.880Z",
        actorParticipantId: PARTICIPANT_YOU,
        payload: { runId: RUN_ID },
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
        agents: [{ agentId: AGENT_IMPLEMENTER, displayName: "Implementer", state: "running" }],
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
