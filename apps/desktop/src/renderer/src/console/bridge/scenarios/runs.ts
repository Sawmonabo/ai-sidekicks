// The runs scenario: one run through the status vocabulary, and a queue behind it.
//
// It scripts the run-state subtypes the runs view reads — a block, an unblock, a
// pause, a resume, and a rewind — the rows most easily conflated, and a fixture that
// only ever showed `running` would let the conflation ship. Waiting is not pausing:
// `run.waiting_for_approval` and `run.paused` are separate beats for the same reason
// they are separate rows there.
//
// TWO STREAMS ARE FED FROM THE BEATS, not one. `bridge/session-event-streams.ts`
// routes a beat to a subscription by KIND: `run.subscribeState` carries the nine
// `run.${RunState}` transitions plus the forward, non-state `run.rolled_back`, and
// `run.subscribeQueue` carries the five `queue_item.*` kinds and nothing else. So a
// scenario scripting only run transitions leaves the queue subscriber silent for the
// life of the window, and the queue's live half — a row arriving, a row admitted, a
// row expiring — is unreachable. The queue SNAPSHOT stays a canned reply, because a
// snapshot is a read and not a stream: it is where the list starts, and the beats are
// what happens to it after.
//
// `scenarios/wire-truth.ts` holds the beats to the census
// (`SESSION_EVENT_CATEGORY_BY_TYPE`) and to the strict payload layer
// (`SessionEventSchema`), both in `packages/contracts/src/event.ts`. Three
// consequences: identifiers are the UUIDs the branded id types declare; a run
// REACHING a state is the event named for that state, carrying the registered
// `{sessionId, runId, runVersion, previousState, newState}` transition rather than a
// bare `{runId}`; and `agent.attached` carries `name`, not `displayName`.

import { DRIVER_CAPABILITY_FLAGS, type DriverCapabilityFlag } from "@ai-sidekicks/contracts";

import type { ConsoleScenario } from "../scenario.js";

// UUID v7 values whose leading bytes are this scenario's own start instant, so a reader
// scanning a rendered id can still tell one fixture apart from another.
const SESSION_ID = "019b7a22-2200-75e5-8510-ada11a5a44a5";
const PARTICIPANT_YOU = "019b7a22-2200-79a4-8110-cca0117a0410";
const AGENT_IMPLEMENTER = "019b7a22-2200-7a6e-8110-d1a4c1150401";
const RUN_ID = "019b7a22-2200-740e-8110-d1a4c1150411";

// `QueueItemId` is a branded UUID: a readable `queue-01` fails the registered parse,
// and the list reply being strict, that failure takes the WHOLE reply down.
const QUEUE_ITEM_ADMITTED = "019b7a22-2200-7c11-8110-d1a4c1150421";
const QUEUE_ITEM_WAITING = "019b7a22-2200-7c11-8120-d1a4c1150422";
const QUEUE_ITEM_EXPIRING = "019b7a22-2200-7c11-8130-d1a4c1150423";

/** The turn boundary the accepted rollback lands the run on. */
const REWIND_TARGET_POSITION = 4;

export const RUNS_SCENARIO: ConsoleScenario = {
  id: "runs",
  label: "Run states",
  purpose:
    "One run moving through block, unblock, pause, resume, and rewind beside a queue whose rows arrive, are admitted, and expire — the vocabulary the runs pane must render without inventing a state.",
  sessionId: SESSION_ID,
  participantIdsInJoinOrder: [PARTICIPANT_YOU, AGENT_IMPLEMENTER],
  // The person watching the run, stated rather than inferred. Absent, the fixture
  // refuses the caller-identity read and every control resolving a role from it renders
  // as though the role had been checked and found absent.
  viewingParticipantId: PARTICIPANT_YOU,
  // The membership each PERSON in the roster holds. The two agents in the join order
  // take no entry: an agent is attached rather than admitted, so it holds no
  // membership and the fixture does not claim to know one. Without this, the viewer's
  // identity read succeeds into a roster carrying no role and every owner- and
  // collaborator-gated control renders closed for a reason nothing checked.
  membershipRoleByParticipantId: { [PARTICIPANT_YOU]: "owner" },
  startedAtIso: "2026-01-01T16:00:00.000Z",
  beats: [
    {
      atMs: 0,
      event: {
        id: "019b7a22-2200-7e00-8110-e5e0c2250001",
        sessionId: SESSION_ID,
        sequence: 1,
        kind: "session.created",
        occurredAt: "2026-01-01T16:00:00.000Z",
        actorId: PARTICIPANT_YOU,
        // The registered shape, verbatim: a session's display name reaches the console
        // from the session read, and this payload's `.strict()` schema rejects a title.
        payload: { sessionId: SESSION_ID, config: {}, metadata: {} },
      },
    },
    {
      atMs: 40,
      event: {
        id: "019b7a22-2200-7e00-8110-e5e0c2250002",
        sessionId: SESSION_ID,
        sequence: 2,
        kind: "agent.attached",
        occurredAt: "2026-01-01T16:00:00.040Z",
        actorId: PARTICIPANT_YOU, // The person who attached it, not the agent.
        payload: {
          sessionId: SESSION_ID,
          agentId: AGENT_IMPLEMENTER,
          name: "Implementer",
          driverName: "claude",
          modelId: "claude-sonnet-5",
          state: "ready",
          actor: PARTICIPANT_YOU,
        },
      },
    },
    {
      atMs: 100,
      event: {
        id: "019b7a22-2200-7e00-8110-e5e0c2250003",
        sessionId: SESSION_ID,
        sequence: 3,
        kind: "run.queued",
        occurredAt: "2026-01-01T16:00:00.100Z",
        actorId: PARTICIPANT_YOU,
        payload: {
          sessionId: SESSION_ID,
          runId: RUN_ID,
          runVersion: 1,
          newState: "queued",
          agentId: AGENT_IMPLEMENTER,
        },
      },
    },
    {
      atMs: 130,
      event: {
        id: "019b7a22-2200-7e00-8110-e5e0c2250004",
        sessionId: SESSION_ID,
        sequence: 4,
        // The queue's first row. `Spec-006 §Queue Events` registers the payload as
        // `{sessionId, queueItemId, channelId?, state}` — the ITEM's state, not the run's.
        kind: "queue_item.created",
        occurredAt: "2026-01-01T16:00:00.130Z",
        actorId: PARTICIPANT_YOU,
        payload: { sessionId: SESSION_ID, queueItemId: QUEUE_ITEM_ADMITTED, state: "queued" },
      },
    },
    {
      atMs: 160,
      event: {
        id: "019b7a22-2200-7e00-8110-e5e0c2250005",
        sessionId: SESSION_ID,
        sequence: 5,
        kind: "run.starting",
        occurredAt: "2026-01-01T16:00:00.160Z",
        payload: {
          sessionId: SESSION_ID,
          runId: RUN_ID,
          runVersion: 2,
          previousState: "queued",
          newState: "starting",
        },
      },
    },
    {
      atMs: 190,
      event: {
        id: "019b7a22-2200-7e00-8110-e5e0c2250006",
        sessionId: SESSION_ID,
        sequence: 6,
        // The head item is taken. A queue row is durable and never deleted — drained but
        // still a row — so this is a state change, never a removal.
        kind: "queue_item.admitted",
        occurredAt: "2026-01-01T16:00:00.190Z",
        payload: { sessionId: SESSION_ID, queueItemId: QUEUE_ITEM_ADMITTED, state: "admitted" },
      },
    },
    {
      atMs: 230,
      event: {
        id: "019b7a22-2200-7e00-8110-e5e0c2250007",
        sessionId: SESSION_ID,
        sequence: 7,
        kind: "run.running",
        occurredAt: "2026-01-01T16:00:00.230Z",
        payload: {
          sessionId: SESSION_ID,
          runId: RUN_ID,
          runVersion: 3,
          previousState: "starting",
          newState: "running",
        },
      },
    },
    {
      atMs: 300,
      event: {
        id: "019b7a22-2200-7e00-8110-e5e0c2250008",
        sessionId: SESSION_ID,
        sequence: 8,
        kind: "run.waiting_for_approval",
        occurredAt: "2026-01-01T16:00:00.300Z",
        payload: {
          sessionId: SESSION_ID,
          runId: RUN_ID,
          runVersion: 4,
          previousState: "running",
          newState: "waiting_for_approval",
        },
      },
    },
    {
      atMs: 410,
      event: {
        id: "019b7a22-2200-7e00-8110-e5e0c2250009",
        sessionId: SESSION_ID,
        sequence: 9,
        // A second row lands while the run is blocked — the ordinary way a queue
        // grows: the person kept typing.
        kind: "queue_item.created",
        occurredAt: "2026-01-01T16:00:00.410Z",
        actorId: PARTICIPANT_YOU,
        payload: { sessionId: SESSION_ID, queueItemId: QUEUE_ITEM_WAITING, state: "queued" },
      },
    },
    {
      atMs: 520,
      event: {
        id: "019b7a22-2200-7e00-8110-e5e0c2250010",
        sessionId: SESSION_ID,
        sequence: 10,
        // The unblock is the run reaching `running` again: the census has no separate
        // unblock verb, and inventing one would name a wire nobody serves.
        kind: "run.running",
        occurredAt: "2026-01-01T16:00:00.520Z",
        actorId: PARTICIPANT_YOU,
        payload: {
          sessionId: SESSION_ID,
          runId: RUN_ID,
          runVersion: 5,
          previousState: "waiting_for_approval",
          newState: "running",
        },
      },
    },
    {
      atMs: 640,
      event: {
        id: "019b7a22-2200-7e00-8110-e5e0c2250011",
        sessionId: SESSION_ID,
        sequence: 11,
        kind: "queue_item.created",
        occurredAt: "2026-01-01T16:00:00.640Z",
        actorId: PARTICIPANT_YOU,
        payload: { sessionId: SESSION_ID, queueItemId: QUEUE_ITEM_EXPIRING, state: "queued" },
      },
    },
    {
      atMs: 700,
      event: {
        id: "019b7a22-2200-7e00-8110-e5e0c2250012",
        sessionId: SESSION_ID,
        sequence: 12,
        kind: "run.paused",
        occurredAt: "2026-01-01T16:00:00.700Z",
        actorId: PARTICIPANT_YOU,
        payload: {
          sessionId: SESSION_ID,
          runId: RUN_ID,
          runVersion: 6,
          previousState: "running",
          newState: "paused",
        },
      },
    },
    {
      atMs: 820,
      event: {
        id: "019b7a22-2200-7e00-8110-e5e0c2250013",
        sessionId: SESSION_ID,
        sequence: 13,
        // The third row ages out while the run is paused. `expired` is a wire state,
        // never a reading the console derives from a clock of its own.
        kind: "queue_item.expired",
        occurredAt: "2026-01-01T16:00:00.820Z",
        payload: { sessionId: SESSION_ID, queueItemId: QUEUE_ITEM_EXPIRING, state: "expired" },
      },
    },
    {
      atMs: 880,
      event: {
        id: "019b7a22-2200-7e00-8110-e5e0c2250014",
        sessionId: SESSION_ID,
        sequence: 14,
        // The resume, likewise: a resumed run is a run that is `running`. The pause
        // above and this beat are transitions into two different states, which keeps
        // them distinguishable without a verb the wire does not have.
        kind: "run.running",
        occurredAt: "2026-01-01T16:00:00.880Z",
        actorId: PARTICIPANT_YOU,
        payload: {
          sessionId: SESSION_ID,
          runId: RUN_ID,
          runVersion: 7,
          previousState: "paused",
          newState: "running",
        },
      },
    },
    {
      atMs: 980,
      event: {
        id: "019b7a22-2200-7e00-8110-e5e0c2250015",
        sessionId: SESSION_ID,
        sequence: 15,
        // The rewind: the second arm of the `run.subscribeState` stream, FORWARD and
        // NON-STATE. Its registered payload (`Spec-006 §Run Lifecycle (run_lifecycle)`:
        // `{sessionId, runId, runVersion, channelId?, targetPosition}`) carries no
        // `previousState` / `newState`, because a rollback is not a transition and a
        // consumer that fabricated one would corrupt the stream others replay. The
        // version still advances, so a stale comparand's next guarded control refuses.
        kind: "run.rolled_back",
        occurredAt: "2026-01-01T16:00:00.980Z",
        actorId: PARTICIPANT_YOU,
        payload: {
          sessionId: SESSION_ID,
          runId: RUN_ID,
          runVersion: 8,
          targetPosition: REWIND_TARGET_POSITION,
        },
      },
    },
  ],
  replies: [
    {
      call: "agent.list",
      result: {
        agents: [
          {
            agentId: AGENT_IMPLEMENTER,
            name: "Implementer",
            driverName: "claude",
            modelId: "claude-sonnet-5",
            config: {},
            // The four-state agent lifecycle. A paused or blocked run is a RUN state,
            // read from the run, never folded into the agent row.
            state: "ready",
            createdAt: "2026-01-01T16:00:00.040Z",
          },
        ],
      },
    },
    {
      call: "run.queueList",
      // Canonical order, FIFO within the target scheduling scope, and the same three
      // items the `queue_item.*` beats above describe. NO RUN-BINDING MEMBER: the
      // design asks the row to say which run it is bound to, and the registered
      // `QueueItemSummary` — `{ id, state, priority, channelId?, createdAt,
      // updatedAt }`, parsed `.strict()` — carries no run member at all. A scripted
      // `targetRunId` fails that parse and takes the WHOLE reply down with it, so the
      // surface would refuse where the scenario meant to show a queue.
      result: {
        items: [
          {
            id: QUEUE_ITEM_ADMITTED,
            state: "admitted",
            priority: 0,
            createdAt: "2026-01-01T16:00:00.130Z",
            updatedAt: "2026-01-01T16:00:00.190Z",
          },
          {
            id: QUEUE_ITEM_WAITING,
            state: "queued",
            priority: 0,
            createdAt: "2026-01-01T16:00:00.410Z",
            updatedAt: "2026-01-01T16:00:00.410Z",
          },
          {
            id: QUEUE_ITEM_EXPIRING,
            state: "queued",
            priority: 0,
            createdAt: "2026-01-01T16:00:00.640Z",
            updatedAt: "2026-01-01T16:00:00.640Z",
          },
        ],
      },
    },
    {
      // The queue's one mutation. `QueueItemCancelResponse` is `.strict()` and its
      // `state` is narrowed to the literal `"canceled"` — the single terminal a cancel
      // can reach — so the reply confirms the request and states nothing else. The
      // row's own state changes when the TAIL says the daemon changed it, never
      // because a surface read this reply and moved the row itself. The scripted
      // latency makes the control's in-flight half — disabled, not re-firable — real.
      call: "run.queueCancel",
      afterMs: 150,
      result: { queueItemId: QUEUE_ITEM_WAITING, state: "canceled" },
    },
    {
      // What the two driver-gated run controls read their gate from. The console
      // offers a gated control only when EVERY reported driver declares its flag, so
      // one report declaring `steer` and `rollback` is what makes the offered arm of
      // both reachable. The record is derived from the shipped closed set rather than
      // hand-listed: a hand-written list would go stale the day the set grows, and it
      // would go stale silently — as a reply that stops parsing.
      call: "driver.listCapabilities",
      result: {
        drivers: [
          {
            driverName: "claude",
            capabilities: {
              flags: declaredFlags(["steer", "rollback", "resume", "interactive_requests"]),
              contractVersion: "1.0",
            },
          },
        ],
      },
    },
  ],
};

/**
 * One driver's capability record: the named flags true, every other flag false.
 *
 * `false` and not absent. `DriverCapabilities.flags` is a total record over
 * `DRIVER_CAPABILITY_FLAGS` parsed `.strict()` — the structural form of the rule that a
 * driver cannot silently omit a capability. An omitted flag fails the parse and takes
 * the whole reply down, leaving both gated controls absent for a reason nothing reports.
 */
function declaredFlags(
  declared: readonly DriverCapabilityFlag[],
): Record<DriverCapabilityFlag, boolean> {
  const asserted = new Set<DriverCapabilityFlag>(declared);
  return Object.fromEntries(
    DRIVER_CAPABILITY_FLAGS.map((flag) => [flag, asserted.has(flag)]),
  ) as Record<DriverCapabilityFlag, boolean>;
}
