// The message queue's cross-field rules: only a not-delivered row carries the daemon's reason,
// and a new order names each waiting message once.
import { describe, expect, it } from "vitest";

import {
  QueueItemListResponseSchema,
  QueueItemSummarySchema,
  QueueReorderRequestSchema,
} from "../run-queue.js";

const SESSION_ID = "0f2b4d5e-1111-4111-8111-111111111111";
const QUEUE_ITEM_ID = "0f2b4d5e-4444-4444-8444-444444444444";
const OTHER_QUEUE_ITEM_ID = "0f2b4d5e-5555-4555-8555-555555555555";
const TIMESTAMP = "2026-09-29T12:00:00.000Z";

describe("the pending rows", () => {
  const waiting = {
    id: QUEUE_ITEM_ID,
    state: "queued",
    priority: 0,
    content: "Also run the linter",
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };

  it("carries the daemon's reason on a not-delivered row, and only there", () => {
    const notDelivered = {
      ...waiting,
      state: "not_delivered",
      notDeliveredReason: "The agent did not pick it up in time.",
    };
    expect(QueueItemListResponseSchema.safeParse({ items: [notDelivered] }).success).toBe(true);
    const { notDeliveredReason: _omitted, ...withoutReason } = notDelivered;
    expect(QueueItemSummarySchema.safeParse(withoutReason).success).toBe(false);
    expect(
      QueueItemSummarySchema.safeParse({ ...waiting, notDeliveredReason: "stale" }).success,
    ).toBe(false);
  });
});

describe("run.queueReorder", () => {
  it("takes the full new order, each waiting message once", () => {
    const reorder = {
      sessionId: SESSION_ID,
      queueItemIds: [OTHER_QUEUE_ITEM_ID, QUEUE_ITEM_ID],
    };
    expect(QueueReorderRequestSchema.safeParse(reorder).success).toBe(true);
    expect(
      QueueReorderRequestSchema.safeParse({
        ...reorder,
        queueItemIds: [QUEUE_ITEM_ID, QUEUE_ITEM_ID],
      }).success,
    ).toBe(false);
    expect(QueueReorderRequestSchema.safeParse({ ...reorder, queueItemIds: [] }).success).toBe(
      false,
    );
  });
});
