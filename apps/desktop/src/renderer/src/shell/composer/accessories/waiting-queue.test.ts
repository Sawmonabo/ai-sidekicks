// The shelf's question, and the four answers that are all "no longer waiting".
//
// The claim that would rot silently is the one the shelf's whole contract rests on:
// a row the daemon has stopped calling `queued` leaves the shelf. It used to leave by
// being deleted from a private fold; it now leaves by not surviving this predicate,
// and the row itself is still in the reading the runs pane renders.

import { describe, expect, it } from "vitest";
import type { QueueItemSummary } from "@ai-sidekicks/contracts";

import { fixtureQueueItemId, queueRow } from "./queue-rows.test-support.js";
import { waitingQueueRows } from "./waiting-queue.js";

const WAITING_FIRST = fixtureQueueItemId("1a2b3c4d-5e6f-4071-8283-94a5b6c7d8e9");
const WAITING_SECOND = fixtureQueueItemId("2b3c4d5e-6f70-4182-9394-a5b6c7d8e9f0");
const ADMITTED = fixtureQueueItemId("3c4d5e6f-7081-4293-84a5-b6c7d8e9f001");
const SUPERSEDED = fixtureQueueItemId("4d5e6f70-8192-43a4-95b6-c7d8e9f00112");
const CANCELED = fixtureQueueItemId("5e6f7081-92a3-44b5-86c7-d8e9f0011223");
const EXPIRED = fixtureQueueItemId("6f708192-a3b4-45c6-97d8-e9f001122334");

/** One row in one state, through the zone's own builder over the registered shape. */
function rowInState(
  id: QueueItemSummary["id"],
  state: QueueItemSummary["state"],
): QueueItemSummary {
  return queueRow(id, state);
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
      rowInState(EXPIRED, "expired"),
    ];
    expect(waitingQueueRows(rows).map((row) => row.id)).toStrictEqual([WAITING_FIRST]);
  });

  it("negative control: the rows it drops are still in the list it was given", () => {
    // The pane beside the composer renders them. A fold that deleted them would take
    // them off both surfaces, which is what two separate folds were there to avoid.
    const rows = [rowInState(WAITING_FIRST, "queued"), rowInState(CANCELED, "canceled")];
    waitingQueueRows(rows);
    expect(rows.map((row) => row.id)).toStrictEqual([WAITING_FIRST, CANCELED]);
  });
});
