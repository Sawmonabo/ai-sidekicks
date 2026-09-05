// The queue rows two suites in this zone build, and the one place their brand is read.
//
// `QueueItemSummary.id` is branded, so a row assembled from a literal cannot be
// typed as one without a reading of the wire's own admission — and the reading is
// the bridge family's, where every schema in this package lives. Written once here
// because the shelf's suite and the waiting-queue predicate's suite both need it,
// and two copies would let the two disagree about which ids and which members the
// wire admits while both stayed green.

import type { QueueItemSummary } from "@ai-sidekicks/contracts";

import { readQueueItemId } from "../../../console/bridge/index.js";

/**
 * A queue-item id the wire admits, or a loud failure.
 *
 * A literal asserted into the brand would let a row these cases treat as
 * wire-shaped carry a value the daemon would refuse; the bridge family's reader
 * answers the brand and keeps the parse at the wire's edge.
 */
export function fixtureQueueItemId(value: string): QueueItemSummary["id"] {
  const queueItemId = readQueueItemId(value);
  if (queueItemId === undefined) {
    throw new Error(`this fixture names a queue-item id the wire would refuse: ${value}`);
  }
  return queueItemId;
}

/**
 * One row in the state a case wants, as the registered shape declares it.
 *
 * A typed literal rather than a parse of an untyped one: the annotation is the
 * stronger claim — a member the wire does not carry, or a `state` outside the
 * registered union, fails `typecheck` here rather than at the moment a case runs —
 * and these are surfaces' suites, which read a reply the bridge family parsed.
 */
export function queueRow(
  id: QueueItemSummary["id"],
  state: QueueItemSummary["state"],
): QueueItemSummary {
  return {
    id,
    state,
    priority: 0,
    createdAt: "2026-09-02T09:00:00.000Z",
    updatedAt: "2026-09-02T09:00:00.000Z",
  } satisfies QueueItemSummary;
}
