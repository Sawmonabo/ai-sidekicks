// One session's queue is read once for every view, and its rows fold in from the tail. The
// tail delivers already-parsed rows, so the fold places what it is handed and nothing else.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { bridgeWrapper } from "@test/helpers/app-frame-fixtures.js";
import { PlatformBridgeProvider } from "@renderer/services/platform/PlatformBridgeProvider.js";
import { settleScheduledRead } from "@test/helpers/scheduled-read.js";
import {
  QUEUED_ROW,
  QueueFeedProbe,
  SECOND_SESSION_ID,
  SESSION_ID,
  TwoQueueReaders,
  openFeed,
  queueFeedBridge,
} from "./queue-feed.test-support.js";
import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";
import type { QueueCalls, QueueFeed } from "./queue-reading.js";

describe("one session's queue is read once for every view", () => {
  it("opens one stream and takes one snapshot for two views on one session", async () => {
    const { bridge, clock, queueCalls, tailedSessionIds, listedSessionIds } = queueFeedBridge();
    render(
      <TwoQueueReaders
        bridge={bridge}
        queueCalls={queueCalls}
        firstSessionId={SESSION_ID}
        secondSessionId={SESSION_ID}
      />,
      { wrapper: bridgeWrapper(bridge, clock) },
    );
    await settleScheduledRead(clock);
    expect(tailedSessionIds).toStrictEqual([SESSION_ID]);
    expect(listedSessionIds).toStrictEqual([SESSION_ID]);
  });

  it("two sessions on one bridge are two readings", async () => {
    const { bridge, clock, queueCalls, tailedSessionIds, listedSessionIds } = queueFeedBridge();
    render(
      <TwoQueueReaders
        bridge={bridge}
        queueCalls={queueCalls}
        firstSessionId={SESSION_ID}
        secondSessionId={SECOND_SESSION_ID}
      />,
      { wrapper: bridgeWrapper(bridge, clock) },
    );
    await settleScheduledRead(clock);
    expect(tailedSessionIds).toStrictEqual([SESSION_ID, SECOND_SESSION_ID]);
    expect(listedSessionIds).toStrictEqual([SESSION_ID, SECOND_SESSION_ID]);
  });

  it("two bridges are two readings of the same session", async () => {
    // The key is the pair. One window's reading is never handed to another's bridge,
    // which is what would happen if the readings were keyed on the session alone.
    const first = queueFeedBridge();
    const second = queueFeedBridge();
    render(
      <>
        <PlatformBridgeProvider bridge={first.bridge} clock={first.clock}>
          <QueueFeedProbe
            bridge={first.bridge}
            sessionId={SESSION_ID}
            queueCalls={first.queueCalls}
            onFeed={() => undefined}
          />
        </PlatformBridgeProvider>
        <PlatformBridgeProvider bridge={second.bridge} clock={second.clock}>
          <QueueFeedProbe
            bridge={second.bridge}
            sessionId={SESSION_ID}
            queueCalls={second.queueCalls}
            onFeed={() => undefined}
          />
        </PlatformBridgeProvider>
      </>,
    );
    await act(async () => {
      await crossMacrotaskBoundary();
    });
    expect(first.tailedSessionIds).toStrictEqual([SESSION_ID]);
    expect(second.tailedSessionIds).toStrictEqual([SESSION_ID]);
  });

  it("leaves one live registered reading when one view replaces another in a commit", async () => {
    // React runs cleanups before setups, so this pane swap retires the reading between the
    // arriving view's render and its subscribe. Subscribing through the reading captured at
    // render would revive it outside the registry, and the next view would mint a second.
    const { bridge, clock, queueCalls, tailedSessionIds, listedSessionIds } = queueFeedBridge();
    const view = render(
      <QueueFeedProbe
        key="x"
        bridge={bridge}
        sessionId={SESSION_ID}
        queueCalls={queueCalls}
        onFeed={() => undefined}
      />,
      { wrapper: bridgeWrapper(bridge, clock) },
    );
    await settleScheduledRead(clock);
    view.rerender(
      <QueueFeedProbe
        key="y"
        bridge={bridge}
        sessionId={SESSION_ID}
        queueCalls={queueCalls}
        onFeed={() => undefined}
      />,
    );

    // A third view must join what the swap left behind rather than mint its own; both arrivals
    // settle together, so two views on one reading ask for one read.
    render(
      <QueueFeedProbe
        key="z"
        bridge={bridge}
        sessionId={SESSION_ID}
        queueCalls={queueCalls}
        onFeed={() => undefined}
      />,
      { wrapper: bridgeWrapper(bridge, clock) },
    );
    await settleScheduledRead(clock);
    expect(tailedSessionIds).toStrictEqual([SESSION_ID, SESSION_ID]);
    expect(listedSessionIds).toStrictEqual([SESSION_ID, SESSION_ID]);
  });

  it("keeps the successor registered when the reading it replaced goes idle", async () => {
    // The eviction closure captures the map and key, not the reading, so an unconditional
    // `delete(sessionId)` would evict a successor with watchers of its own.
    const { bridge, clock, queueCalls, tailedSessionIds } = queueFeedBridge();
    const swapped = render(
      <QueueFeedProbe
        key="x"
        bridge={bridge}
        sessionId={SESSION_ID}
        queueCalls={queueCalls}
        onFeed={() => undefined}
      />,
      { wrapper: bridgeWrapper(bridge, clock) },
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
      { wrapper: bridgeWrapper(bridge, clock) },
    );
    await act(async () => {
      await crossMacrotaskBoundary();
    });
    // The swapped-in view leaves; the joiner stays, so the reading is still live
    // and still registered, and a fourth view joins it rather than minting one.
    swapped.unmount();
    render(
      <QueueFeedProbe
        bridge={bridge}
        sessionId={SESSION_ID}
        queueCalls={queueCalls}
        onFeed={() => undefined}
      />,
      { wrapper: bridgeWrapper(bridge, clock) },
    );
    await act(async () => {
      await crossMacrotaskBoundary();
    });
    expect(tailedSessionIds).toStrictEqual([SESSION_ID, SESSION_ID]);
    joined.unmount();
  });

  it("reads afresh once the last view has left, rather than serving a stale list", async () => {
    const { bridge, clock, queueCalls, tailedSessionIds } = queueFeedBridge();
    const mounted = render(
      <QueueFeedProbe
        bridge={bridge}
        sessionId={SESSION_ID}
        queueCalls={queueCalls}
        onFeed={() => undefined}
      />,
      { wrapper: bridgeWrapper(bridge, clock) },
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
      { wrapper: bridgeWrapper(bridge, clock) },
    );
    await act(async () => {
      await crossMacrotaskBoundary();
    });
    expect(tailedSessionIds).toStrictEqual([SESSION_ID, SESSION_ID]);
  });
});

describe("the queue feed folds the rows the tail delivers", () => {
  it("places a row from a delivery and reads once the snapshot lands", async () => {
    const { deliver, latest } = await openFeed();
    deliver(QUEUED_ROW);
    expect(latest().items).toHaveLength(1);
    expect(latest().items[0]?.state).toBe("queued");
    expect(latest().phase).toBe("read");
  });
});

describe("a snapshot read the daemon refuses", () => {
  it("settles refused with the refusal, so a failed read never reads as an empty queue", async () => {
    const { bridge, clock, queueCalls } = queueFeedBridge();
    const refusingCalls: QueueCalls = {
      ...queueCalls,
      list: () => Promise.reject(new Error("the queue could not be read")),
    };
    let held: QueueFeed | undefined;
    render(
      <QueueFeedProbe
        bridge={bridge}
        sessionId={SESSION_ID}
        queueCalls={refusingCalls}
        onFeed={(feed) => (held = feed)}
      />,
      { wrapper: bridgeWrapper(bridge, clock) },
    );
    await settleScheduledRead(clock);
    expect(held?.phase).toBe("refused");
    expect(held?.readRefusal?.detail).toBe("the queue could not be read");
  });
});
