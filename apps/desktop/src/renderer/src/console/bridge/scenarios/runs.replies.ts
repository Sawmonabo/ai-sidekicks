// What the runs scenario ANSWERS, as opposed to what it plays.
//
// A reply is a read and a beat is a stream frame, and the fixture serves them through
// different seams: a call is looked up here by method and answered once, while a beat
// is routed to a subscription by kind and arrives on the frozen clock. Splitting them
// is the file's own seam — `runs.ts`'s header already states it about the queue, whose
// snapshot "is where the list starts, and the beats are what happens to it after".

import { DRIVER_CAPABILITY_FLAGS, type DriverCapabilityFlag } from "@ai-sidekicks/contracts";

import type { ScenarioReply } from "../scenario-runtime/scenario.js";
import {
  AGENT_IMPLEMENTER,
  QUEUE_ITEM_ADMITTED,
  QUEUE_ITEM_EXPIRING,
  QUEUE_ITEM_WAITING,
} from "./runs.identifiers.js";

/** Every call the runs scenario answers, and what it answers with. */
export const RUNS_REPLIES: readonly ScenarioReply[] = [
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
];

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
