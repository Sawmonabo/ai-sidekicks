// The message queue: each shape accepts what the composer sends and the pending rows
// draw, and refuses the cases the queue's rules name, the message bounds among them.
import { describe, expect, it } from "vitest";

import {
  DRIVER_WIRE_STEER_ATTACHMENTS_MAX,
  DRIVER_WIRE_STEER_CONTENT_MAX_LEN,
} from "../provider-driver.js";
import {
  QueueChangeRefusedDetailsSchema,
  QueueItemCancelRequestSchema,
  QueueItemCreateRequestSchema,
  QueueItemListResponseSchema,
  QueueItemStateSchema,
  QueueItemSummarySchema,
  QueueReorderRequestSchema,
} from "../run-queue.js";

const SESSION_ID = "0f2b4d5e-1111-4111-8111-111111111111";
const OTHER_SESSION_ID = "0f2b4d5e-2222-4222-8222-222222222222";
const QUEUE_ITEM_ID = "0f2b4d5e-4444-4444-8444-444444444444";
const OTHER_QUEUE_ITEM_ID = "0f2b4d5e-5555-4555-8555-555555555555";
const IDEMPOTENCY_KEY = "0f2b4d5e-9999-4999-8999-999999999999";
const ARTIFACT_ID = "0f2b4d5e-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TIMESTAMP = "2026-09-29T12:00:00.000Z";

describe("QueueItemState", () => {
  it("has no timed expiry: an old message is not-delivered, never expired", () => {
    expect(QueueItemStateSchema.safeParse("not_delivered").success).toBe(true);
    expect(QueueItemStateSchema.safeParse("expired").success).toBe(false);
  });
});

describe("run.queueCreate", () => {
  const send = {
    sessionId: SESSION_ID,
    clientIdempotencyKey: IDEMPOTENCY_KEY,
    content: "Use the staging database instead",
  };

  it("sends a message with its files, to this session or to another by `to`", () => {
    expect(
      QueueItemCreateRequestSchema.safeParse({ ...send, attachments: [ARTIFACT_ID] }).success,
    ).toBe(true);
    expect(QueueItemCreateRequestSchema.safeParse({ ...send, to: OTHER_SESSION_ID }).success).toBe(
      true,
    );
  });

  it("edits a waiting message in place by naming the item it replaces", () => {
    expect(
      QueueItemCreateRequestSchema.safeParse({ ...send, replacesQueueItemId: QUEUE_ITEM_ID })
        .success,
    ).toBe(true);
    expect(
      QueueItemCreateRequestSchema.safeParse({ ...send, replacesQueueItemId: "item-1" }).success,
    ).toBe(false);
  });

  it("refuses an untyped payload and a channel, which the send no longer carries", () => {
    expect(QueueItemCreateRequestSchema.safeParse({ ...send, payload: {} }).success).toBe(false);
    expect(
      QueueItemCreateRequestSchema.safeParse({ ...send, channelId: OTHER_SESSION_ID }).success,
    ).toBe(false);
  });

  it("refuses a message over the content bound and one past the file-count ceiling", () => {
    expect(
      QueueItemCreateRequestSchema.safeParse({
        ...send,
        content: "x".repeat(DRIVER_WIRE_STEER_CONTENT_MAX_LEN),
      }).success,
    ).toBe(true);
    expect(
      QueueItemCreateRequestSchema.safeParse({
        ...send,
        content: "x".repeat(DRIVER_WIRE_STEER_CONTENT_MAX_LEN + 1),
      }).success,
    ).toBe(false);
    const files = (count: number): string[] => Array.from({ length: count }, () => ARTIFACT_ID);
    expect(
      QueueItemCreateRequestSchema.safeParse({
        ...send,
        attachments: files(DRIVER_WIRE_STEER_ATTACHMENTS_MAX),
      }).success,
    ).toBe(true);
    expect(
      QueueItemCreateRequestSchema.safeParse({
        ...send,
        attachments: files(DRIVER_WIRE_STEER_ATTACHMENTS_MAX + 1),
      }).success,
    ).toBe(false);
  });

  it("refuses an empty message and a file that is not an artifact id", () => {
    expect(QueueItemCreateRequestSchema.safeParse({ ...send, content: "   " }).success).toBe(false);
    expect(
      QueueItemCreateRequestSchema.safeParse({ ...send, attachments: ["../../etc/passwd"] })
        .success,
    ).toBe(false);
  });

  it("refuses a send without its idempotency key", () => {
    const { clientIdempotencyKey: _omitted, ...withoutKey } = send;
    expect(QueueItemCreateRequestSchema.safeParse(withoutKey).success).toBe(false);
  });
});

describe("the pending rows", () => {
  const waiting = {
    id: QUEUE_ITEM_ID,
    state: "queued",
    priority: 0,
    content: "Also run the linter",
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };

  it("draws a waiting row from its own words, on the lead's queue or a child's", () => {
    expect(QueueItemSummarySchema.safeParse(waiting).success).toBe(true);
    expect(QueueItemSummarySchema.safeParse({ ...waiting, childHandle: "task-7" }).success).toBe(
      true,
    );
    const { content: _omitted, ...withoutWords } = waiting;
    expect(QueueItemSummarySchema.safeParse(withoutWords).success).toBe(false);
  });

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

describe("run.queueCancel and run.queueReorder", () => {
  it("removes a waiting message from a child's queue by its handle", () => {
    expect(
      QueueItemCancelRequestSchema.safeParse({ queueItemId: QUEUE_ITEM_ID, childHandle: "task-7" })
        .success,
    ).toBe(true);
  });

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

  it("names why a change to a waiting message was refused", () => {
    for (const reason of ["already_taken", "order_mismatch"]) {
      expect(QueueChangeRefusedDetailsSchema.safeParse({ reason }).success).toBe(true);
    }
    expect(QueueChangeRefusedDetailsSchema.safeParse({ reason: "expired" }).success).toBe(false);
  });
});
