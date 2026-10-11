// The message queue's cross-field rules: only a not-delivered row carries the daemon's reason, a
// new order names each waiting message once, and a send's files are artifact ids in their order.
import { describe, expect, it } from "vitest";

import {
  QueueItemCreateRequestSchema,
  QueueItemListResponseSchema,
  QueueItemSummarySchema,
  QueueReorderRequestSchema,
} from "../queue.js";

const SESSION_ID = "0f2b4d5e-1111-4111-8111-111111111111";
const QUEUE_ITEM_ID = "0f2b4d5e-4444-4444-8444-444444444444";
const OTHER_QUEUE_ITEM_ID = "0f2b4d5e-5555-4555-8555-555555555555";
const IDEMPOTENCY_KEY = "0f2b4d5e-9999-4999-8999-999999999999";
// Two distinct artifact ids, so an order assertion over the send's files can tell them apart.
const FIRST_ARTIFACT_ID = "0f2b4d5e-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SECOND_ARTIFACT_ID = "0f2b4d5e-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TIMESTAMP = "2026-09-29T12:00:00.000Z";

describe("the pending rows", () => {
  const waiting = {
    id: QUEUE_ITEM_ID,
    state: "queued",
    position: 0,
    content: "Also run the linter",
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };

  it("carries the daemon's reason on a not-delivered row, and only there", () => {
    const notDelivered = { ...waiting, state: "not_delivered", notDeliveredReason: "timed_out" };
    expect(QueueItemListResponseSchema.safeParse({ items: [notDelivered] }).success).toBe(true);
    const { notDeliveredReason: _omitted, ...withoutReason } = notDelivered;
    expect(QueueItemSummarySchema.safeParse(withoutReason).success).toBe(false);
    expect(
      QueueItemSummarySchema.safeParse({ ...waiting, notDeliveredReason: "failed" }).success,
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

describe("the files a send carries", () => {
  const sendCarrying = (attachments: readonly unknown[]): Record<string, unknown> => ({
    sessionId: SESSION_ID,
    clientIdempotencyKey: IDEMPOTENCY_KEY,
    content: "see the attached trace",
    attachments,
  });

  it("REFUSES a non-id element", () => {
    expect(() => QueueItemCreateRequestSchema.parse(sendCarrying([{ kind: "blob" }]))).toThrow();
    expect(() => QueueItemCreateRequestSchema.parse(sendCarrying([{}]))).toThrow();
    expect(() => QueueItemCreateRequestSchema.parse(sendCarrying([17]))).toThrow();
  });

  it("REFUSES a string that is not an artifact id", () => {
    // `ArtifactId` is an RFC 9562 UUID the daemon mints at manifest creation; a caller-supplied
    // id reaching a manifest lookup must not be a path or a store-key fragment, which a bare
    // `z.string()` element would admit.
    expect(() => QueueItemCreateRequestSchema.parse(sendCarrying(["../../etc/passwd"]))).toThrow();
    // A plausible-looking opaque handle is still refused: `artifact-1` is not an RFC 9562 UUID.
    expect(() => QueueItemCreateRequestSchema.parse(sendCarrying(["artifact-1"]))).toThrow(/uuid/i);
  });

  it("accepts the empty list and preserves declared order", () => {
    // Ordering is the daemon's delivery duty; the parse must only not reorder or drop, so the
    // round-trip pins the sequence.
    expect(QueueItemCreateRequestSchema.parse(sendCarrying([]))).toEqual(sendCarrying([]));
    const ordered = [SECOND_ARTIFACT_ID, FIRST_ARTIFACT_ID];
    expect(QueueItemCreateRequestSchema.parse(sendCarrying(ordered)).attachments).toEqual(ordered);
  });
});
