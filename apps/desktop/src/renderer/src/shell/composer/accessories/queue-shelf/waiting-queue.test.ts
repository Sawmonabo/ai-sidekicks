// The shelf's question, and the four answers that are all "not waiting".
//
// The claim that would rot silently is the one the shelf's whole contract rests on: a row
// the daemon has stopped calling `queued` leaves the shelf by not surviving this
// predicate, and the row itself is still in the reading the transcript's pending rows render.

import { describe, expect, it } from "vitest";
import type { QueueItemSummary } from "@ai-sidekicks/contracts";

import { readQueueItemId } from "../../../../console/bridge/index.js";
import { waitingQueueRows } from "./waiting-queue.js";

/** A queue-item id the wire admits, or a loud failure. */
function fixtureQueueItemId(value: string): QueueItemSummary["id"] {
  const queueItemId = readQueueItemId(value);
  if (queueItemId === undefined) {
    throw new Error(`this fixture names a queue-item id the wire would refuse: ${value}`);
  }
  return queueItemId;
}

const WAITING_FIRST = fixtureQueueItemId("1a2b3c4d-5e6f-4071-8283-94a5b6c7d8e9");
const WAITING_SECOND = fixtureQueueItemId("2b3c4d5e-6f70-4182-9394-a5b6c7d8e9f0");
const ADMITTED = fixtureQueueItemId("3c4d5e6f-7081-4293-84a5-b6c7d8e9f001");
const SUPERSEDED = fixtureQueueItemId("4d5e6f70-8192-43a4-95b6-c7d8e9f00112");
const CANCELED = fixtureQueueItemId("5e6f7081-92a3-44b5-86c7-d8e9f0011223");
const NOT_DELIVERED = fixtureQueueItemId("6f708192-a3b4-45c6-97d8-e9f001122334");

/** One row in one state, over the registered shape. */
function rowInState(
  id: QueueItemSummary["id"],
  state: QueueItemSummary["state"],
): QueueItemSummary {
  return {
    id,
    state,
    priority: 0,
    createdAt: "2026-09-02T09:00:00.000Z",
    updatedAt: "2026-09-02T09:00:00.000Z",
  };
}

describe("waitingQueueRows", () => {
  it("keeps the queued rows in the reading's own order", () => {
    const rows = [rowInState(WAITING_FIRST, "queued"), rowInState(WAITING_SECOND, "queued")];
    expect(waitingQueueRows(rows).map((row) => row.id)).toStrictEqual([
      WAITING_FIRST,
      WAITING_SECOND,
    ]);
  });

  it("drops every state that says the item is no longer waiting", () => {
    const rows = [
      rowInState(WAITING_FIRST, "queued"),
      rowInState(ADMITTED, "admitted"),
      rowInState(SUPERSEDED, "superseded"),
      rowInState(CANCELED, "canceled"),
      rowInState(NOT_DELIVERED, "not_delivered"),
    ];
    expect(waitingQueueRows(rows).map((row) => row.id)).toStrictEqual([WAITING_FIRST]);
  });

  it("negative control: the rows it drops are still in the list it was given", () => {
    // The transcript's pending rows render them. A fold that deleted them would take them
    // off both surfaces.
    const rows = [rowInState(WAITING_FIRST, "queued"), rowInState(CANCELED, "canceled")];
    waitingQueueRows(rows);
    expect(rows.map((row) => row.id)).toStrictEqual([WAITING_FIRST, CANCELED]);
  });
});
