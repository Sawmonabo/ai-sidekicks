// What the feed does with the rows themselves: one cancel, a delivery it cannot
// read, and the order the list is kept in.
//
// Split from the subscription's own cases because the subjects are different. Those
// are about opening a stream, taking one snapshot per session, and what happens when
// the open refuses; these take an open feed as a premise and are about the ROWS that
// arrive on it — which is why every case here reaches for `deliver` and none of them
// asserts on `openedStreams`.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { settleScheduledRead } from "../readings/scheduled-read.test-support.js";
import type { QueueFeed } from "./queue-reading.js";
import {
  QUEUE_ITEM_A,
  QUEUE_ITEM_B,
  QUEUE_ITEM_ID,
  QueueFeedProbe,
  REGISTERED_ROW_DELIVERY,
  SESSION_ID,
  methodsOf,
  queueFeedBridge,
} from "./queue-feed.test-support.js";
import { crossMacrotaskBoundary } from "../../core/macrotask-boundary.test-support.js";

describe("a queued item is cancelled once", () => {
  it("issues one mutation for two synchronous presses on one row", async () => {
    const { bridge, calls } = queueFeedBridge();
    let held: QueueFeed | undefined;
    render(
      <QueueFeedProbe bridge={bridge} sessionId={SESSION_ID} onFeed={(feed) => (held = feed)} />,
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
      cancelItem(QUEUE_ITEM_ID);
      cancelItem(QUEUE_ITEM_ID);
    });
    expect(methodsOf(calls).filter((method) => method === "run.queueCancel")).toHaveLength(1);
  });

  it("negative control: two rows pressed once each are two mutations", async () => {
    // Without this the case above would pass over a chokepoint that dispatched
    // NOTHING, which is a different defect with the same count. The latch is per id,
    // and this is the case that says so.
    const { bridge, calls } = queueFeedBridge();
    let held: QueueFeed | undefined;
    render(
      <QueueFeedProbe bridge={bridge} sessionId={SESSION_ID} onFeed={(feed) => (held = feed)} />,
    );
    await act(async () => {
      await crossMacrotaskBoundary();
    });
    act(() => {
      held?.cancelItem(QUEUE_ITEM_A);
      held?.cancelItem(QUEUE_ITEM_B);
    });
    expect(methodsOf(calls).filter((method) => method === "run.queueCancel")).toHaveLength(2);
  });

  it("takes the row's cancel again once the first has settled", async () => {
    const { bridge, calls } = queueFeedBridge();
    let held: QueueFeed | undefined;
    render(
      <QueueFeedProbe bridge={bridge} sessionId={SESSION_ID} onFeed={(feed) => (held = feed)} />,
    );
    await act(async () => {
      await crossMacrotaskBoundary();
    });
    await act(async () => {
      held?.cancelItem(QUEUE_ITEM_ID);
      await crossMacrotaskBoundary();
    });
    expect(held?.pendingCancelIds.has(QUEUE_ITEM_ID)).toBe(false);
    act(() => {
      held?.cancelItem(QUEUE_ITEM_ID);
    });
    expect(methodsOf(calls).filter((method) => method === "run.queueCancel")).toHaveLength(2);
  });

  it("holds one row's cancel without holding another's", async () => {
    const { bridge } = queueFeedBridge();
    let held: QueueFeed | undefined;
    render(
      <QueueFeedProbe bridge={bridge} sessionId={SESSION_ID} onFeed={(feed) => (held = feed)} />,
    );
    await act(async () => {
      await crossMacrotaskBoundary();
    });
    act(() => {
      held?.cancelItem(QUEUE_ITEM_A);
    });
    expect(held?.pendingCancelIds.has(QUEUE_ITEM_A)).toBe(true);
    expect(held?.pendingCancelIds.has(QUEUE_ITEM_B)).toBe(false);
  });
});

describe("a malformed delivery is a partial read, not a silent drop", () => {
  /** A payload that matches no registered queue row — a protocol-version mismatch. */
  const UNREADABLE_DELIVERY = { id: QUEUE_ITEM_A, status: "waiting", rank: 3 };

  it("counts the delivery, keeps the rows it has, and says the reading may be behind", async () => {
    const { bridge, deliver } = queueFeedBridge();
    let held: QueueFeed | undefined;
    render(
      <QueueFeedProbe bridge={bridge} sessionId={SESSION_ID} onFeed={(feed) => (held = feed)} />,
    );
    await act(async () => {
      await crossMacrotaskBoundary();
    });
    act(() => {
      deliver(REGISTERED_ROW_DELIVERY);
    });
    act(() => {
      deliver(UNREADABLE_DELIVERY);
    });
    // The row that read cleanly is still here, and it is no longer presented as a
    // current reading of the whole queue.
    expect(held?.items.map((item) => item.id)).toStrictEqual([QUEUE_ITEM_ID]);
    expect(held?.unreadableDeliveryCount).toBe(1);
  });

  it("carries the delivery's own parse refusal, naming the members that failed", async () => {
    const { bridge, deliver } = queueFeedBridge();
    let held: QueueFeed | undefined;
    render(
      <QueueFeedProbe bridge={bridge} sessionId={SESSION_ID} onFeed={(feed) => (held = feed)} />,
    );
    await act(async () => {
      await crossMacrotaskBoundary();
    });
    act(() => {
      deliver(UNREADABLE_DELIVERY);
    });
    expect(held?.unreadableRefusal?.code).toBe("delivery-unreadable");
    expect(held?.unreadableRefusal?.detail).toContain("state");
    // Never the payload that failed: an unvalidated value is not put on screen to
    // explain why an unvalidated value was refused.
    expect(held?.unreadableRefusal?.detail).not.toContain("waiting");
  });

  it("clears the count when a well-formed snapshot supersedes what preceded it", async () => {
    // The tail opens before the snapshot lands, so this window is a real one: a
    // delivery missed before the list was restated is no longer missing. The window
    // is now the scheduler's rather than a microtask's, which is what lets the case
    // place the delivery inside it deliberately instead of relying on a race.
    const { bridge, deliver } = queueFeedBridge([REGISTERED_ROW_DELIVERY]);
    let held: QueueFeed | undefined;
    render(
      <QueueFeedProbe bridge={bridge} sessionId={SESSION_ID} onFeed={(feed) => (held = feed)} />,
    );
    act(() => {
      deliver(UNREADABLE_DELIVERY);
    });
    expect(held?.unreadableDeliveryCount).toBe(1);
    await settleScheduledRead(bridge);
    expect(held?.unreadableDeliveryCount).toBe(0);
    expect(held?.unreadableRefusal).toBeUndefined();
  });

  it("negative control: a reading whose every delivery parsed claims nothing is missing", async () => {
    // Without this the cases above would pass over a feed that reported every
    // reading as partial, which would make the warning meaningless.
    const { bridge, deliver } = queueFeedBridge();
    let held: QueueFeed | undefined;
    render(
      <QueueFeedProbe bridge={bridge} sessionId={SESSION_ID} onFeed={(feed) => (held = feed)} />,
    );
    await act(async () => {
      await crossMacrotaskBoundary();
    });
    act(() => {
      deliver(REGISTERED_ROW_DELIVERY);
    });
    expect(held?.unreadableDeliveryCount).toBe(0);
    expect(held?.unreadableRefusal).toBeUndefined();
  });
});

/** One row of the registered shape, at one state and one `updatedAt`. */
function row(id: string, state: string, updatedAt: string): Record<string, unknown> {
  return { id, state, priority: 0, createdAt: "2026-09-02T09:00:00.000Z", updatedAt };
}

describe("the ordering rule holds through the hook", () => {
  it("holds the rule through the hook, over a tail delivery that beat the snapshot", async () => {
    // The production path, with the race the fold exists for: the subscription is
    // opened synchronously inside the effect and the snapshot is taken when the
    // scheduler's window elapses, so a delivery made before that is one that arrived
    // first.
    const { bridge, deliver } = queueFeedBridge([
      row(QUEUE_ITEM_A, "queued", "2026-09-02T09:00:01.000Z"),
      row(QUEUE_ITEM_B, "queued", "2026-09-02T09:00:01.000Z"),
    ]);
    let held: QueueFeed | undefined;
    render(
      <QueueFeedProbe bridge={bridge} sessionId={SESSION_ID} onFeed={(feed) => (held = feed)} />,
    );
    act(() => {
      deliver(row(QUEUE_ITEM_B, "admitted", "2026-09-02T09:00:02.000Z"));
    });
    await settleScheduledRead(bridge);
    expect(held?.items.map((item) => item.id)).toStrictEqual([QUEUE_ITEM_A, QUEUE_ITEM_B]);
    expect(held?.items[1]?.state).toBe("admitted");
  });
});
