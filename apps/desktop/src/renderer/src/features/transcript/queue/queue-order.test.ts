// The ordering rule, driven directly on the fold with no bridge, session or React: the
// snapshot's order, and the newer of two readings of one row.

import { describe, expect, it } from "vitest";

import { QueueItemSummarySchema, type QueueItemSummary } from "@ai-sidekicks/contracts";

import { QueueOrder } from "./queue-order.js";

const QUEUE_ITEM_A = "1a2b3c4d-5e6f-4071-8283-94a5b6c7d8e9";
const QUEUE_ITEM_B = "2b3c4d5e-6f70-4182-9394-a5b6c7d8e9f0";
const QUEUE_ITEM_C = "3c4d5e6f-7081-4293-84a5-b6c7d8e9f001";

/** One row of the registered shape, at one state and one `updatedAt`. */
function row(id: string, state: string, updatedAt: string): Record<string, unknown> {
  return {
    id,
    state,
    priority: 0,
    content: "Also run the linter",
    createdAt: "2026-09-02T09:00:00.000Z",
    updatedAt,
  };
}

/** The same row, through the registered parse the fold's callers perform. */
function parsedRow(id: string, state: string, updatedAt: string): QueueItemSummary {
  return QueueItemSummarySchema.parse(row(id, state, updatedAt));
}

describe("the snapshot never regresses a newer tail row", () => {
  it("rebuilds the snapshot's order and keeps the newer reading of a raced row", () => {
    // A tail update for B, then a snapshot of [A, B].
    const order = new QueueOrder();
    order.merge(parsedRow(QUEUE_ITEM_B, "admitted", "2026-09-02T09:00:02.000Z"));
    order.replaceWithSnapshot([
      parsedRow(QUEUE_ITEM_A, "queued", "2026-09-02T09:00:01.000Z"),
      parsedRow(QUEUE_ITEM_B, "queued", "2026-09-02T09:00:01.000Z"),
    ]);
    expect(order.items().map((item) => item.id)).toStrictEqual([QUEUE_ITEM_A, QUEUE_ITEM_B]);
    expect(order.items()[1]?.state).toBe("admitted");
  });

  it("keeps an admitted tail row against a queued snapshot row", () => {
    const order = new QueueOrder();
    order.merge(parsedRow(QUEUE_ITEM_A, "admitted", "2026-09-02T09:00:05.000Z"));
    order.replaceWithSnapshot([parsedRow(QUEUE_ITEM_A, "queued", "2026-09-02T09:00:04.000Z")]);
    expect(order.items()[0]?.state).toBe("admitted");
  });

  it("takes the snapshot's row when the snapshot is the newer reading", () => {
    // The rule is "newer wins", not "the tail always wins" — a snapshot taken after
    // the emission is the later reading and is what the list shows.
    const order = new QueueOrder();
    order.merge(parsedRow(QUEUE_ITEM_A, "queued", "2026-09-02T09:00:04.000Z"));
    order.replaceWithSnapshot([parsedRow(QUEUE_ITEM_A, "canceled", "2026-09-02T09:00:06.000Z")]);
    expect(order.items()[0]?.state).toBe("canceled");
  });

  it("appends tail-only ids after the snapshot's own order", () => {
    const order = new QueueOrder();
    order.merge(parsedRow(QUEUE_ITEM_C, "queued", "2026-09-02T09:00:02.000Z"));
    order.replaceWithSnapshot([
      parsedRow(QUEUE_ITEM_A, "queued", "2026-09-02T09:00:01.000Z"),
      parsedRow(QUEUE_ITEM_B, "queued", "2026-09-02T09:00:01.000Z"),
    ]);
    expect(order.items().map((item) => item.id)).toStrictEqual([
      QUEUE_ITEM_A,
      QUEUE_ITEM_B,
      QUEUE_ITEM_C,
    ]);
  });
});
