// One session's queue is read once for every surface, and its rows fold in from the
// tail.
//
// The tail delivers already-parsed rows: parsing the wire belongs to the call that
// opens the stream, so this fold seats what it is handed and nothing else.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { settleScheduledRead } from "../readings/scheduled-read.test-support.js";
import {
  QUEUED_ROW,
  QueueFeedProbe,
  SECOND_SESSION_ID,
  SESSION_ID,
  TwoQueueSurfaces,
  openFeed,
  queueFeedBridge,
} from "./queue-feed.test-support.js";
import { crossMacrotaskBoundary } from "../../core/macrotask-boundary.test-support.js";

describe("one session's queue is read once for every surface", () => {
  it("opens one stream and takes one snapshot for two surfaces on one session", async () => {
    const { bridge, queueCalls, tailedSessionIds, listedSessionIds } = queueFeedBridge();
    render(
      <TwoQueueSurfaces
        bridge={bridge}
        queueCalls={queueCalls}
        firstSessionId={SESSION_ID}
        secondSessionId={SESSION_ID}
      />,
    );
    await settleScheduledRead(bridge);
    expect(tailedSessionIds).toStrictEqual([SESSION_ID]);
    expect(listedSessionIds).toStrictEqual([SESSION_ID]);
  });

  it("negative control: two sessions on one bridge are two readings", async () => {
    const { bridge, queueCalls, tailedSessionIds, listedSessionIds } = queueFeedBridge();
    render(
      <TwoQueueSurfaces
        bridge={bridge}
        queueCalls={queueCalls}
        firstSessionId={SESSION_ID}
        secondSessionId={SECOND_SESSION_ID}
      />,
    );
    await settleScheduledRead(bridge);
    expect(tailedSessionIds).toStrictEqual([SESSION_ID, SECOND_SESSION_ID]);
    expect(listedSessionIds).toStrictEqual([SESSION_ID, SECOND_SESSION_ID]);
  });

  it("negative control: two bridges are two readings of the same session", async () => {
    // The key is the pair. One window's reading is never handed to another's bridge,
    // which is what would happen if the readings were keyed on the session alone.
    const first = queueFeedBridge();
    const second = queueFeedBridge();
    render(
      <>
        <QueueFeedProbe
          bridge={first.bridge}
          sessionId={SESSION_ID}
          queueCalls={first.queueCalls}
          onFeed={() => undefined}
        />
        <QueueFeedProbe
          bridge={second.bridge}
          sessionId={SESSION_ID}
          queueCalls={second.queueCalls}
          onFeed={() => undefined}
        />
      </>,
    );
    await act(async () => {
      await crossMacrotaskBoundary();
    });
    expect(first.tailedSessionIds).toStrictEqual([SESSION_ID]);
    expect(second.tailedSessionIds).toStrictEqual([SESSION_ID]);
  });

  it("leaves one live registered reading when one surface replaces another in a commit", async () => {
    // React runs cleanups BEFORE setups, so this pane swap retires the reading
    // between the arriving surface's render and its subscribe. A surface that
    // subscribed through the reading it captured at render revived that one — live,
    // open, and outside the registry — and the next surface then minted a second,
    // so one session carried two snapshot reads and two tails.
    const { bridge, queueCalls, tailedSessionIds, listedSessionIds } = queueFeedBridge();
    const view = render(
      <QueueFeedProbe
        key="x"
        bridge={bridge}
        sessionId={SESSION_ID}
        queueCalls={queueCalls}
        onFeed={() => undefined}
      />,
    );
    await settleScheduledRead(bridge);
    view.rerender(
      <QueueFeedProbe
        key="y"
        bridge={bridge}
        sessionId={SESSION_ID}
        queueCalls={queueCalls}
        onFeed={() => undefined}
      />,
    );

    // A third surface arriving afterwards must JOIN what the swap left behind rather
    // than mint its own, which is the reading that says the registry holds one. Both
    // arrivals settle together, which is the case's own claim: two surfaces sharing
    // one reading ask it for one read.
    render(
      <QueueFeedProbe
        key="z"
        bridge={bridge}
        sessionId={SESSION_ID}
        queueCalls={queueCalls}
        onFeed={() => undefined}
      />,
    );
    await settleScheduledRead(bridge);
    expect(tailedSessionIds).toStrictEqual([SESSION_ID, SESSION_ID]);
    expect(listedSessionIds).toStrictEqual([SESSION_ID, SESSION_ID]);
  });

  it("keeps the successor registered when the reading it replaced goes idle", async () => {
    // The eviction closure captures the map and the key but not the reading, so an
    // unconditional `delete(sessionId)` evicted whatever was under that key by the
    // time the last watcher left — a SUCCESSOR with watchers of its own. A retiring
    // reading may only remove itself.
    const { bridge, queueCalls, tailedSessionIds } = queueFeedBridge();
    const swapped = render(
      <QueueFeedProbe
        key="x"
        bridge={bridge}
        sessionId={SESSION_ID}
        queueCalls={queueCalls}
        onFeed={() => undefined}
      />,
    );
    await act(async () => {
      await crossMacrotaskBoundary();
    });
    swapped.rerender(
      <QueueFeedProbe
        key="y"
        bridge={bridge}
        sessionId={SESSION_ID}
        queueCalls={queueCalls}
        onFeed={() => undefined}
      />,
    );
    const joined = render(
      <QueueFeedProbe
        bridge={bridge}
        sessionId={SESSION_ID}
        queueCalls={queueCalls}
        onFeed={() => undefined}
      />,
    );
    await act(async () => {
      await crossMacrotaskBoundary();
    });
    // The swapped-in surface leaves; the joiner stays, so the reading is still live
    // and still registered, and a fourth surface joins it rather than minting one.
    swapped.unmount();
    render(
      <QueueFeedProbe
        bridge={bridge}
        sessionId={SESSION_ID}
        queueCalls={queueCalls}
        onFeed={() => undefined}
      />,
    );
    await act(async () => {
      await crossMacrotaskBoundary();
    });
    expect(tailedSessionIds).toStrictEqual([SESSION_ID, SESSION_ID]);
    joined.unmount();
  });

  it("reads afresh once the last surface has left, rather than serving a stale list", async () => {
    const { bridge, queueCalls, tailedSessionIds } = queueFeedBridge();
    const mounted = render(
      <QueueFeedProbe
        bridge={bridge}
        sessionId={SESSION_ID}
        queueCalls={queueCalls}
        onFeed={() => undefined}
      />,
    );
    await act(async () => {
      await crossMacrotaskBoundary();
    });
    mounted.unmount();
    render(
      <QueueFeedProbe
        bridge={bridge}
        sessionId={SESSION_ID}
        queueCalls={queueCalls}
        onFeed={() => undefined}
      />,
    );
    await act(async () => {
      await crossMacrotaskBoundary();
    });
    expect(tailedSessionIds).toStrictEqual([SESSION_ID, SESSION_ID]);
  });
});

describe("the queue feed folds the rows the tail delivers", () => {
  it("seats a row from a delivery and reads once the snapshot lands", async () => {
    const { deliver, latest } = await openFeed();
    deliver(QUEUED_ROW);
    expect(latest().items).toHaveLength(1);
    expect(latest().items[0]?.state).toBe("queued");
    expect(latest().phase).toBe("read");
  });
});
