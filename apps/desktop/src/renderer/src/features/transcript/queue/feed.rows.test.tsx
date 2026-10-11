// What the feed does with the rows themselves: one cancel, one retry in the row's own words, and
// the order the list is kept in.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { bridgeWrapper } from "#test/helpers/app/frame-fixtures.js";
import { settleScheduledRead } from "#test/helpers/scheduled-read.js";
import type { QueueFeed } from "./reading.js";
import {
  QUEUE_ITEM_A,
  QUEUE_ITEM_B,
  QUEUE_ITEM_ID,
  QueueFeedProbe,
  SESSION_ID,
  openFeed,
  queueFeedBridge,
  queueRow,
} from "./feed.test-support.js";
import { crossMacrotaskBoundary } from "#test/helpers/macrotask-boundary.js";

describe("a queued item is canceled once", () => {
  it("issues one mutation for two synchronous presses on one row", async () => {
    const { latest, canceledItemIds } = await openFeed();
    const { cancelItem } = latest();
    // Both presses inside one act, which is the frame a person double-pressing
    // produces: the second reads a control the render has not redrawn yet.
    act(() => {
      void cancelItem(QUEUE_ITEM_ID);
      void cancelItem(QUEUE_ITEM_ID);
    });
    expect(canceledItemIds).toStrictEqual([QUEUE_ITEM_ID]);
  });

  it("two rows pressed once each are two mutations", async () => {
    // Without this the case above would pass over a chokepoint that dispatched nothing. The
    // latch is per id.
    const { latest, canceledItemIds } = await openFeed();
    act(() => {
      void latest().cancelItem(QUEUE_ITEM_A);
      void latest().cancelItem(QUEUE_ITEM_B);
    });
    expect(canceledItemIds).toStrictEqual([QUEUE_ITEM_A, QUEUE_ITEM_B]);
  });

  it("takes the row's cancel again once the first has settled", async () => {
    const { latest, canceledItemIds } = await openFeed();
    await act(async () => {
      void latest().cancelItem(QUEUE_ITEM_ID);
      await crossMacrotaskBoundary();
    });
    expect(latest().pendingCancelIds.has(QUEUE_ITEM_ID)).toBe(false);
    act(() => {
      void latest().cancelItem(QUEUE_ITEM_ID);
    });
    expect(canceledItemIds).toStrictEqual([QUEUE_ITEM_ID, QUEUE_ITEM_ID]);
  });
});

describe("a not-delivered item is retried once", () => {
  // Mutations: a fresh key per press queues the message twice; leaving out the replaced id sends a
  // new message beside the failed one, which stays not delivered.
  it("replaces the row's message in its own words, keyed by its id, for two presses", async () => {
    const failed = queueRow(QUEUE_ITEM_ID, "not_delivered", "2026-09-02T09:00:00.000Z");
    const { latest, retryRequests } = await openFeed([failed]);
    act(() => {
      void latest().retryItem(QUEUE_ITEM_ID);
      void latest().retryItem(QUEUE_ITEM_ID);
    });
    expect(retryRequests).toStrictEqual([
      {
        sessionId: SESSION_ID,
        clientIdempotencyKey: QUEUE_ITEM_ID,
        content: failed.content,
        replacesQueueItemId: QUEUE_ITEM_ID,
      },
    ]);
  });
});

describe("the ordering rule holds through the hook", () => {
  it("holds the rule through the hook, over a tail delivery that beat the snapshot", async () => {
    // The race the fold exists for: the tail opens with the snapshot still in flight,
    // so a delivery made before the snapshot lands is one that arrived first.
    const { bridge, clock, queueCalls, deliver } = queueFeedBridge([
      queueRow(QUEUE_ITEM_A, "queued", "2026-09-02T09:00:01.000Z", 0),
      queueRow(QUEUE_ITEM_B, "queued", "2026-09-02T09:00:01.000Z", 1),
    ]);
    let held: QueueFeed | undefined;
    render(
      <QueueFeedProbe
        bridge={bridge}
        sessionId={SESSION_ID}
        queueCalls={queueCalls}
        onFeed={(feed) => (held = feed)}
      />,
      { wrapper: bridgeWrapper(bridge, clock) },
    );
    act(() => {
      deliver(queueRow(QUEUE_ITEM_B, "admitted", "2026-09-02T09:00:02.000Z", 1));
    });
    await settleScheduledRead(clock);
    expect(held?.items.map((item) => item.id)).toStrictEqual([QUEUE_ITEM_A, QUEUE_ITEM_B]);
    expect(held?.items[1]?.state).toBe("admitted");
  });
});
