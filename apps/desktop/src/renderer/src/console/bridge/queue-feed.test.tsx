// What this feed will and will not read off `run.subscribeQueue`.
//
// The stream carries the registered `QueueItemSummary` projection and never the
// whole-session event envelope the session stream carries. The seam owes that
// projection in the bridge's direction — a fixture projects each beat into the
// registered payload shape — and this fold parses that shape and nothing else.
//
// Both halves are asserted because both failures are silent. A fold that started
// reading envelopes would seat rows from a shape the daemon does not send; a bridge
// that started sending envelopes would leave the pane's queue empty while the
// snapshot read reported `read`, which looks exactly like an empty queue.
//
// Driven through the hook rather than through `QueueOrder`, because the parse lives
// in the subscription callback and not in the fold: a test that handed `QueueOrder`
// a pre-parsed row would assert the ordering rule and never reach the schema.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ConsoleRefusalError, refuse } from "../core/index.js";
import { QUEUE_SUBSCRIBE_STREAM } from "./daemon-streams.js";
import {
  withRecordedStreamLifecycle,
  withStreamUnopenableAtFirst,
  withUnopenableStream,
} from "./daemon-streams.test-support.js";
import {
  createFixture,
  withDaemonCall,
  type RecordedDaemonCall,
} from "./fixture-bridge.test-support.js";
import { settleScheduledRead } from "./scheduled-read.test-support.js";
import type { ConsoleBridge } from "./console-bridge.js";
import type { QueueFeed } from "./queue-reading.js";
import {
  ENVELOPE_SHAPED_DELIVERY,
  QueueFeedProbe,
  REGISTERED_ROW_DELIVERY,
  SECOND_SESSION_ID,
  SESSION_ID,
  TwoQueueSurfaces,
  methodsOf,
  openFeed,
  queueFeedBridge,
} from "./queue-feed.test-support.js";
import { drainMicrotasks } from "./fixture-bridge.test-support.js";

describe("one session's queue is read once for every surface", () => {
  it("opens one stream and takes one snapshot for two surfaces on one session", async () => {
    const { bridge, openedStreams, calls } = queueFeedBridge();
    render(
      <TwoQueueSurfaces bridge={bridge} firstSessionId={SESSION_ID} secondSessionId={SESSION_ID} />,
    );
    await settleScheduledRead(bridge);
    expect(openedStreams).toStrictEqual(["run.subscribeQueue"]);
    expect(methodsOf(calls)).toStrictEqual(["run.queueList"]);
  });

  it("negative control: two sessions on one bridge are two readings", async () => {
    const { bridge, openedStreams, calls } = queueFeedBridge();
    render(
      <TwoQueueSurfaces
        bridge={bridge}
        firstSessionId={SESSION_ID}
        secondSessionId={SECOND_SESSION_ID}
      />,
    );
    await settleScheduledRead(bridge);
    expect(openedStreams).toStrictEqual(["run.subscribeQueue", "run.subscribeQueue"]);
    expect(methodsOf(calls)).toStrictEqual(["run.queueList", "run.queueList"]);
  });

  it("negative control: two bridges are two readings of the same session", async () => {
    // The key is the pair. One window's reading is never handed to another's bridge,
    // which is what would happen if the readings were keyed on the session alone.
    const first = queueFeedBridge();
    const second = queueFeedBridge();
    render(
      <>
        <QueueFeedProbe bridge={first.bridge} sessionId={SESSION_ID} onFeed={() => undefined} />
        <QueueFeedProbe bridge={second.bridge} sessionId={SESSION_ID} onFeed={() => undefined} />
      </>,
    );
    await act(async () => {
      await drainMicrotasks();
    });
    expect(first.openedStreams).toStrictEqual(["run.subscribeQueue"]);
    expect(second.openedStreams).toStrictEqual(["run.subscribeQueue"]);
  });

  it("leaves one live registered reading when one surface replaces another in a commit", async () => {
    // React runs cleanups BEFORE setups, so this pane swap retires the reading
    // between the arriving surface's render and its subscribe. A surface that
    // subscribed through the reading it captured at render revived that one — live,
    // open, and outside the registry — and the next surface then minted a second,
    // so one session carried two snapshot reads and two tails.
    const { bridge, openedStreams, calls } = queueFeedBridge();
    const view = render(
      <QueueFeedProbe key="x" bridge={bridge} sessionId={SESSION_ID} onFeed={() => undefined} />,
    );
    await settleScheduledRead(bridge);
    view.rerender(
      <QueueFeedProbe key="y" bridge={bridge} sessionId={SESSION_ID} onFeed={() => undefined} />,
    );

    // A third surface arriving afterwards must JOIN what the swap left behind rather
    // than mint its own, which is the reading that says the registry holds one. Both
    // arrivals settle together, which is the case's own claim: two surfaces sharing
    // one reading ask it for one read.
    render(
      <QueueFeedProbe key="z" bridge={bridge} sessionId={SESSION_ID} onFeed={() => undefined} />,
    );
    await settleScheduledRead(bridge);
    expect(openedStreams).toStrictEqual(["run.subscribeQueue", "run.subscribeQueue"]);
    expect(methodsOf(calls)).toStrictEqual(["run.queueList", "run.queueList"]);
  });

  it("keeps the successor registered when the reading it replaced goes idle", async () => {
    // The eviction closure captures the map and the key but not the reading, so an
    // unconditional `delete(sessionId)` evicted whatever was under that key by the
    // time the last watcher left — a SUCCESSOR with watchers of its own. A retiring
    // reading may only remove itself.
    const { bridge, openedStreams } = queueFeedBridge();
    const swapped = render(
      <QueueFeedProbe key="x" bridge={bridge} sessionId={SESSION_ID} onFeed={() => undefined} />,
    );
    await act(async () => {
      await drainMicrotasks();
    });
    swapped.rerender(
      <QueueFeedProbe key="y" bridge={bridge} sessionId={SESSION_ID} onFeed={() => undefined} />,
    );
    const joined = render(
      <QueueFeedProbe bridge={bridge} sessionId={SESSION_ID} onFeed={() => undefined} />,
    );
    await act(async () => {
      await drainMicrotasks();
    });
    // The swapped-in surface leaves; the joiner stays, so the reading is still live
    // and still registered, and a fourth surface joins it rather than minting one.
    swapped.unmount();
    render(<QueueFeedProbe bridge={bridge} sessionId={SESSION_ID} onFeed={() => undefined} />);
    await act(async () => {
      await drainMicrotasks();
    });
    expect(openedStreams).toStrictEqual(["run.subscribeQueue", "run.subscribeQueue"]);
    joined.unmount();
  });

  it("reads afresh once the last surface has left, rather than serving a stale list", async () => {
    const { bridge, openedStreams } = queueFeedBridge();
    const mounted = render(
      <QueueFeedProbe bridge={bridge} sessionId={SESSION_ID} onFeed={() => undefined} />,
    );
    await act(async () => {
      await drainMicrotasks();
    });
    mounted.unmount();
    render(<QueueFeedProbe bridge={bridge} sessionId={SESSION_ID} onFeed={() => undefined} />);
    await act(async () => {
      await drainMicrotasks();
    });
    expect(openedStreams).toStrictEqual(["run.subscribeQueue", "run.subscribeQueue"]);
  });
});

describe("the queue feed reads the registered payload shape", () => {
  it("seats a row from a registered-shape delivery", async () => {
    const { deliver, latest } = await openFeed();
    deliver(REGISTERED_ROW_DELIVERY);
    expect(latest().items).toHaveLength(1);
    expect(latest().items[0]?.state).toBe("queued");
  });
});

describe("the queue feed ignores the whole-session envelope", () => {
  it("seats no row from an envelope-shaped delivery", async () => {
    const { deliver, latest } = await openFeed();
    deliver(ENVELOPE_SHAPED_DELIVERY);
    expect(latest().items).toHaveLength(0);
    // The snapshot still landed, so an empty list here is the fold refusing the
    // delivery and not the read having failed.
    expect(latest().phase).toBe("read");
  });

  it("negative control: the envelope's own payload is seated on its own", async () => {
    const { deliver, latest } = await openFeed();
    deliver(ENVELOPE_SHAPED_DELIVERY.payload);
    expect(latest().items).toHaveLength(1);
  });
});

describe("the queue stream is opened with its registered request", () => {
  it("opens the stream for a session the registered request shape accepts", async () => {
    const { openedStreams, latest } = await openFeed();
    expect(openedStreams).toStrictEqual(["run.subscribeQueue"]);
    expect(latest().readRefusal).toBeUndefined();
  });

  it("refuses rather than opening an unscoped stream when the session does not parse", async () => {
    const { openedStreams, latest } = await openFeed({ sessionId: "not-a-session" });
    expect(openedStreams).toStrictEqual([]);
    expect(latest().phase).toBe("refused");
    expect(latest().readRefusal?.code).toBe("session-unreadable");
  });
});

describe("an unopenable queue stream is a refusal, not a crash", () => {
  /** The shipped fixture whose queue subscription throws, as the live one does. */
  function bridgeRefusingTheStream(thrown: unknown): {
    bridge: ConsoleBridge;
    calls: readonly RecordedDaemonCall[];
  } {
    const answered = withDaemonCall(createFixture().bridge, async () => ({ items: [] }));
    return {
      bridge: withUnopenableStream(answered.bridge, QUEUE_SUBSCRIBE_STREAM, thrown),
      calls: answered.calls,
    };
  }

  it("settles refused with the thrown refusal's own code and lets nothing escape", async () => {
    // The negative control is the code this replaces: the unguarded `#open` let the
    // throw unwind out of `render`, so this case failed as an uncaught exception
    // rather than as an assertion — a mounted surface rendered nothing at all.
    const refusal = refuse("console-daemon-stream", "stream-unavailable", "The daemon is a stub.");
    const { bridge, calls } = bridgeRefusingTheStream(new ConsoleRefusalError(refusal));
    let held: QueueFeed | undefined;
    render(
      <QueueFeedProbe bridge={bridge} sessionId={SESSION_ID} onFeed={(feed) => (held = feed)} />,
    );
    await act(async () => {
      await drainMicrotasks();
    });
    expect(held?.phase).toBe("refused");
    expect(held?.readRefusal?.code).toBe("stream-unavailable");
    expect(held?.readRefusal?.origin).toBe("console-daemon-stream");
    // The snapshot is not attempted: the tail is what keeps the list current, so a
    // list read off a bridge that cannot stream would stop being true immediately.
    expect(methodsOf(calls)).toStrictEqual([]);
  });

  it("normalizes a rejection that carries no refusal of its own", async () => {
    const { bridge } = bridgeRefusingTheStream(new Error("the preload is a stub"));
    let held: QueueFeed | undefined;
    render(
      <QueueFeedProbe bridge={bridge} sessionId={SESSION_ID} onFeed={(feed) => (held = feed)} />,
    );
    await act(async () => {
      await drainMicrotasks();
    });
    expect(held?.phase).toBe("refused");
    expect(held?.readRefusal?.origin).toBe("session-queue");
    expect(held?.readRefusal?.detail).toContain("the preload is a stub");
  });

  it("negative control: a bridge whose stream opens reads the snapshot and lands read", async () => {
    // Without this the two cases above would pass over a feed that refused every
    // open, which would hide a live queue behind a permanent refusal.
    const { openedStreams, latest } = await openFeed();
    expect(openedStreams).toStrictEqual(["run.subscribeQueue"]);
    expect(latest().phase).toBe("read");
    expect(latest().readRefusal).toBeUndefined();
  });
});

describe("a queue reading whose open refused can be opened again", () => {
  /**
   * The shipped fixture whose queue subscription throws once, then opens.
   *
   * The transport arm of a refused open. Refusing every open cannot state this
   * claim — under it a reading that re-opens and one that never tries again look
   * identical — so the second open has to be able to succeed.
   */
  function bridgeRefusingTheFirstOpen(): {
    bridge: ConsoleBridge;
    openCount: () => number;
    calls: readonly RecordedDaemonCall[];
  } {
    const answered = withDaemonCall(createFixture().bridge, async () => ({ items: [] }));
    const refusingFirst = withStreamUnopenableAtFirst(
      answered.bridge,
      QUEUE_SUBSCRIBE_STREAM,
      new ConsoleRefusalError(
        refuse("console-daemon-stream", "stream-unavailable", "The daemon is a stub."),
      ),
    );
    const recorded = withRecordedStreamLifecycle(refusingFirst);
    return {
      bridge: recorded.bridge,
      openCount: () => recorded.openCountFor(QUEUE_SUBSCRIBE_STREAM),
      calls: answered.calls,
    };
  }

  it("re-opens on the window's own reason and then reads", async () => {
    // THE DEFECT. The catch arm left the reading marked open with no subscription
    // behind it, and the scoped session id was assigned only after the open — so
    // every later focus, repair, and mount was a guaranteed no-op and the pane held
    // that first refusal for the life of the window.
    const { bridge, openCount, calls } = bridgeRefusingTheFirstOpen();
    let held: QueueFeed | undefined;
    render(
      <QueueFeedProbe bridge={bridge} sessionId={SESSION_ID} onFeed={(feed) => (held = feed)} />,
    );
    await act(async () => {
      await drainMicrotasks();
    });
    expect(held?.phase).toBe("refused");
    expect(methodsOf(calls)).toStrictEqual([]);

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await settleScheduledRead(bridge);

    expect(openCount()).toBe(2);
    expect(held?.phase).toBe("read");
    // Cleared, not merely superseded: the reading that healed carries no refusal.
    expect(held?.readRefusal).toBeUndefined();
    expect(methodsOf(calls)).toStrictEqual(["run.queueList"]);
  });

  it("negative control: a request the registered shape refused is never re-opened", async () => {
    // The other arm, and the reason the two are named apart. This request is
    // composed from the same session id every time, so re-trying it would re-mint
    // one refusal on every window focus and re-render every watcher for a fact that
    // has not moved.
    const recorded = withRecordedStreamLifecycle(
      withDaemonCall(createFixture().bridge, async () => ({ items: [] })).bridge,
    );
    let held: QueueFeed | undefined;
    render(
      <QueueFeedProbe
        bridge={recorded.bridge}
        sessionId="not-a-session"
        onFeed={(feed) => (held = feed)}
      />,
    );
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await settleScheduledRead(recorded.bridge);

    expect(recorded.openCountFor(QUEUE_SUBSCRIBE_STREAM)).toBe(0);
    expect(held?.readRefusal?.code).toBe("session-unreadable");
  });
});
