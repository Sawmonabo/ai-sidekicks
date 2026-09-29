// What the feed does with the rows themselves: one cancel, and the order the list is
// kept in.
//
// These take an open feed as a premise and are about the ROWS that arrive on it, which
// is why every case here reaches for `deliver` or `cancelItem`.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { settleScheduledRead } from "@test/helpers/scheduled-read.js";
import type { QueueFeed } from "./queue-reading.js";
import {
  QUEUE_ITEM_A,
  QUEUE_ITEM_B,
  QUEUE_ITEM_ID,
  QueueFeedProbe,
  SESSION_ID,
  queueFeedBridge,
  queueRow,
} from "./queue-feed.test-support.js";
import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";

describe("a queued item is cancelled once", () => {
  it("issues one mutation for two synchronous presses on one row", async () => {
    const { bridge, queueCalls, cancelledItemIds } = queueFeedBridge();
    let held: QueueFeed | undefined;
    render(
      <QueueFeedProbe
        bridge={bridge}
        sessionId={SESSION_ID}
        queueCalls={queueCalls}
        onFeed={(feed) => (held = feed)}
      />,
    );
    await act(async () => {
      await crossMacrotaskBoundary();
    });
    const cancelItem = held?.cancelItem;
    if (cancelItem === undefined) {
      throw new Error("the queue feed reported no cancel");
    }
    // Both presses inside one act, which is the frame a person double-pressing
    // produces: the second reads a control the render has not redrawn yet.
    act(() => {
      void cancelItem(QUEUE_ITEM_ID);
      void cancelItem(QUEUE_ITEM_ID);
    });
    expect(cancelledItemIds).toStrictEqual([QUEUE_ITEM_ID]);
  });

  it("negative control: two rows pressed once each are two mutations", async () => {
    // Without this the case above would pass over a chokepoint that dispatched
    // NOTHING, which is a different defect with the same count. The latch is per id,
    // and this is the case that says so.
    const { bridge, queueCalls, cancelledItemIds } = queueFeedBridge();
    let held: QueueFeed | undefined;
    render(
      <QueueFeedProbe
        bridge={bridge}
        sessionId={SESSION_ID}
        queueCalls={queueCalls}
        onFeed={(feed) => (held = feed)}
      />,
    );
    await act(async () => {
      await crossMacrotaskBoundary();
    });
    act(() => {
      void held?.cancelItem(QUEUE_ITEM_A);
      void held?.cancelItem(QUEUE_ITEM_B);
    });
    expect(cancelledItemIds).toStrictEqual([QUEUE_ITEM_A, QUEUE_ITEM_B]);
  });

  it("takes the row's cancel again once the first has settled", async () => {
    const { bridge, queueCalls, cancelledItemIds } = queueFeedBridge();
    let held: QueueFeed | undefined;
    render(
      <QueueFeedProbe
        bridge={bridge}
        sessionId={SESSION_ID}
        queueCalls={queueCalls}
        onFeed={(feed) => (held = feed)}
      />,
    );
    await act(async () => {
      await crossMacrotaskBoundary();
    });
    await act(async () => {
      void held?.cancelItem(QUEUE_ITEM_ID);
      await crossMacrotaskBoundary();
    });
    expect(held?.pendingCancelIds.has(QUEUE_ITEM_ID)).toBe(false);
    act(() => {
      void held?.cancelItem(QUEUE_ITEM_ID);
    });
    expect(cancelledItemIds).toStrictEqual([QUEUE_ITEM_ID, QUEUE_ITEM_ID]);
  });

  it("holds one row's cancel without holding another's", async () => {
    const { bridge, queueCalls } = queueFeedBridge();
    let held: QueueFeed | undefined;
    render(
      <QueueFeedProbe
        bridge={bridge}
        sessionId={SESSION_ID}
        queueCalls={queueCalls}
        onFeed={(feed) => (held = feed)}
      />,
    );
    await act(async () => {
      await crossMacrotaskBoundary();
    });
    act(() => {
      void held?.cancelItem(QUEUE_ITEM_A);
    });
    expect(held?.pendingCancelIds.has(QUEUE_ITEM_A)).toBe(true);
    expect(held?.pendingCancelIds.has(QUEUE_ITEM_B)).toBe(false);
  });
});

describe("the ordering rule holds through the hook", () => {
  it("holds the rule through the hook, over a tail delivery that beat the snapshot", async () => {
    // The race the fold exists for: the tail opens with the snapshot still in flight,
    // so a delivery made before the snapshot lands is one that arrived first.
    const { bridge, queueCalls, deliver } = queueFeedBridge([
      queueRow(QUEUE_ITEM_A, "queued", "2026-09-02T09:00:01.000Z"),
      queueRow(QUEUE_ITEM_B, "queued", "2026-09-02T09:00:01.000Z"),
    ]);
    let held: QueueFeed | undefined;
    render(
      <QueueFeedProbe
        bridge={bridge}
        sessionId={SESSION_ID}
        queueCalls={queueCalls}
        onFeed={(feed) => (held = feed)}
      />,
    );
    act(() => {
      deliver(queueRow(QUEUE_ITEM_B, "admitted", "2026-09-02T09:00:02.000Z"));
    });
    await settleScheduledRead(bridge);
    expect(held?.items.map((item) => item.id)).toStrictEqual([QUEUE_ITEM_A, QUEUE_ITEM_B]);
    expect(held?.items[1]?.state).toBe("admitted");
  });
});
