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

import { useEffect, type ReactElement } from "react";
import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ConsoleRefusalError, refuse } from "../core/index.js";
import type { ConsoleBridge } from "./console-bridge.js";
import { useQueueFeed } from "./queue-feed.js";
import type { QueueFeed } from "./queue-reading.js";

const SESSION_ID = "0a1b2c3d-4e5f-4061-8273-9a4b5c6d7e8f";
const SECOND_SESSION_ID = "8b7a6959-4837-4726-8514-3f2e1d0c9b8a";
const QUEUE_ITEM_ID = "7c6b5a49-3827-4615-9403-2e1d0c9b8a77";
const QUEUE_ITEM_A = "1a2b3c4d-5e6f-4071-8283-94a5b6c7d8e9";
const QUEUE_ITEM_B = "2b3c4d5e-6f70-4182-9394-a5b6c7d8e9f0";

/** One row, exactly as `QueueItemSummarySchema` registers it. */
const REGISTERED_ROW_DELIVERY = {
  id: QUEUE_ITEM_ID,
  state: "queued",
  priority: 0,
  createdAt: "2026-09-02T09:00:00.000Z",
  updatedAt: "2026-09-02T09:00:00.000Z",
};

/** The whole-session envelope, wrapping the very same row. */
const ENVELOPE_SHAPED_DELIVERY = {
  sessionId: SESSION_ID,
  sequence: 4,
  kind: "queue_item.created",
  occurredAt: "2026-09-02T09:00:00.000Z",
  payload: REGISTERED_ROW_DELIVERY,
};

/** A bridge that hands the test the subscription handler and an empty snapshot. */
function stubBridge(snapshot: readonly unknown[] = []): {
  bridge: ConsoleBridge;
  deliver: (payload: unknown) => void;
  openedStreams: string[];
  calledMethods: string[];
} {
  let deliverToFeed: (payload: unknown) => void = () => undefined;
  const openedStreams: string[] = [];
  const calledMethods: string[] = [];
  const bridge = {
    sidekicks: {
      daemon: {
        call: async (method: string): Promise<unknown> => {
          calledMethods.push(method);
          return { items: snapshot };
        },
        subscribe: (stream: string, handler: (payload: unknown) => void) => {
          openedStreams.push(stream);
          deliverToFeed = handler;
          return () => undefined;
        },
      },
    },
    growth: {},
    growthServedOperations: new Set(),
    source: "fixture",
    scenarioEngine: undefined,
  } as unknown as ConsoleBridge;
  return { bridge, deliver: (payload) => deliverToFeed(payload), openedStreams, calledMethods };
}

/** Reports the feed out of the tree, so a case reads the hook's own answer. */
function QueueFeedProbe(props: {
  readonly bridge: ConsoleBridge;
  readonly sessionId: string;
  readonly onFeed: (feed: QueueFeed) => void;
}): null {
  const feed = useQueueFeed(props.bridge, props.sessionId);
  const { onFeed } = props;
  useEffect(() => {
    onFeed(feed);
  }, [feed, onFeed]);
  return null;
}

async function openFeed(
  options: { readonly snapshot?: readonly unknown[]; readonly sessionId?: string } = {},
): Promise<{
  deliver: (payload: unknown) => void;
  latest: () => QueueFeed;
  openedStreams: readonly string[];
}> {
  const { bridge, deliver, openedStreams } = stubBridge(options.snapshot ?? []);
  let held: QueueFeed | undefined;
  render(
    <QueueFeedProbe
      bridge={bridge}
      sessionId={options.sessionId ?? SESSION_ID}
      onFeed={(feed) => (held = feed)}
    />,
  );
  await act(async () => {
    await Promise.resolve();
  });
  return {
    deliver: (payload) => {
      act(() => {
        deliver(payload);
      });
    },
    latest: () => {
      if (held === undefined) {
        throw new Error("the queue feed reported nothing, so there is no reading to assert");
      }
      return held;
    },
    openedStreams,
  };
}

// One session's queue is read once, however many surfaces ask for it.
//
// The defect this replaces was two modules with the same file name, the same exported
// symbols, and their own subscriptions: a session view holding the runs pane beside
// the composer's shelf tailed `run.subscribeQueue` twice and read `run.queueList`
// twice for one answer. The count is the assertion, so the negative controls below
// show the counter is capable of reaching two — otherwise a hook that opened NOTHING
// would pass the first case.

/** Two surfaces on one bridge, each asking the hook its own question. */
function TwoQueueSurfaces(props: {
  readonly bridge: ConsoleBridge;
  readonly firstSessionId: string;
  readonly secondSessionId: string;
}): ReactElement {
  return (
    <>
      <QueueFeedProbe
        bridge={props.bridge}
        sessionId={props.firstSessionId}
        onFeed={() => undefined}
      />
      <QueueFeedProbe
        bridge={props.bridge}
        sessionId={props.secondSessionId}
        onFeed={() => undefined}
      />
    </>
  );
}

describe("one session's queue is read once for every surface", () => {
  it("opens one stream and takes one snapshot for two surfaces on one session", async () => {
    const { bridge, openedStreams, calledMethods } = stubBridge();
    render(
      <TwoQueueSurfaces bridge={bridge} firstSessionId={SESSION_ID} secondSessionId={SESSION_ID} />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(openedStreams).toStrictEqual(["run.subscribeQueue"]);
    expect(calledMethods).toStrictEqual(["run.queueList"]);
  });

  it("negative control: two sessions on one bridge are two readings", async () => {
    const { bridge, openedStreams, calledMethods } = stubBridge();
    render(
      <TwoQueueSurfaces
        bridge={bridge}
        firstSessionId={SESSION_ID}
        secondSessionId={SECOND_SESSION_ID}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(openedStreams).toStrictEqual(["run.subscribeQueue", "run.subscribeQueue"]);
    expect(calledMethods).toStrictEqual(["run.queueList", "run.queueList"]);
  });

  it("negative control: two bridges are two readings of the same session", async () => {
    // The key is the pair. One window's reading is never handed to another's bridge,
    // which is what would happen if the readings were keyed on the session alone.
    const first = stubBridge();
    const second = stubBridge();
    render(
      <>
        <QueueFeedProbe bridge={first.bridge} sessionId={SESSION_ID} onFeed={() => undefined} />
        <QueueFeedProbe bridge={second.bridge} sessionId={SESSION_ID} onFeed={() => undefined} />
      </>,
    );
    await act(async () => {
      await Promise.resolve();
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
    const { bridge, openedStreams, calledMethods } = stubBridge();
    const view = render(
      <QueueFeedProbe key="x" bridge={bridge} sessionId={SESSION_ID} onFeed={() => undefined} />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    view.rerender(
      <QueueFeedProbe key="y" bridge={bridge} sessionId={SESSION_ID} onFeed={() => undefined} />,
    );
    await act(async () => {
      await Promise.resolve();
    });

    // A third surface arriving afterwards must JOIN what the swap left behind rather
    // than mint its own, which is the reading that says the registry holds one.
    render(
      <QueueFeedProbe key="z" bridge={bridge} sessionId={SESSION_ID} onFeed={() => undefined} />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(openedStreams).toStrictEqual(["run.subscribeQueue", "run.subscribeQueue"]);
    expect(calledMethods).toStrictEqual(["run.queueList", "run.queueList"]);
  });

  it("keeps the successor registered when the reading it replaced goes idle", async () => {
    // The eviction closure captures the map and the key but not the reading, so an
    // unconditional `delete(sessionId)` evicted whatever was under that key by the
    // time the last watcher left — a SUCCESSOR with watchers of its own. A retiring
    // reading may only remove itself.
    const { bridge, openedStreams } = stubBridge();
    const swapped = render(
      <QueueFeedProbe key="x" bridge={bridge} sessionId={SESSION_ID} onFeed={() => undefined} />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    swapped.rerender(
      <QueueFeedProbe key="y" bridge={bridge} sessionId={SESSION_ID} onFeed={() => undefined} />,
    );
    const joined = render(
      <QueueFeedProbe bridge={bridge} sessionId={SESSION_ID} onFeed={() => undefined} />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    // The swapped-in surface leaves; the joiner stays, so the reading is still live
    // and still registered, and a fourth surface joins it rather than minting one.
    swapped.unmount();
    render(<QueueFeedProbe bridge={bridge} sessionId={SESSION_ID} onFeed={() => undefined} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(openedStreams).toStrictEqual(["run.subscribeQueue", "run.subscribeQueue"]);
    joined.unmount();
  });

  it("reads afresh once the last surface has left, rather than serving a stale list", async () => {
    const { bridge, openedStreams } = stubBridge();
    const mounted = render(
      <QueueFeedProbe bridge={bridge} sessionId={SESSION_ID} onFeed={() => undefined} />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    mounted.unmount();
    render(<QueueFeedProbe bridge={bridge} sessionId={SESSION_ID} onFeed={() => undefined} />);
    await act(async () => {
      await Promise.resolve();
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
  /** A bridge whose subscription throws synchronously, as the shipped live one does. */
  function bridgeRefusingTheStream(thrown: unknown): {
    bridge: ConsoleBridge;
    calledMethods: string[];
  } {
    const calledMethods: string[] = [];
    const bridge = {
      sidekicks: {
        daemon: {
          call: async (method: string): Promise<unknown> => {
            calledMethods.push(method);
            return { items: [] };
          },
          subscribe: () => {
            throw thrown;
          },
        },
      },
      growth: {},
      growthServedOperations: new Set(),
      source: "fixture",
      scenarioEngine: undefined,
    } as unknown as ConsoleBridge;
    return { bridge, calledMethods };
  }

  it("settles refused with the thrown refusal's own code and lets nothing escape", async () => {
    // The negative control is the code this replaces: the unguarded `#open` let the
    // throw unwind out of `render`, so this case failed as an uncaught exception
    // rather than as an assertion — a mounted surface rendered nothing at all.
    const refusal = refuse("console-daemon-stream", "stream-unavailable", "The daemon is a stub.");
    const { bridge, calledMethods } = bridgeRefusingTheStream(new ConsoleRefusalError(refusal));
    let held: QueueFeed | undefined;
    render(
      <QueueFeedProbe bridge={bridge} sessionId={SESSION_ID} onFeed={(feed) => (held = feed)} />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(held?.phase).toBe("refused");
    expect(held?.readRefusal?.code).toBe("stream-unavailable");
    expect(held?.readRefusal?.origin).toBe("console-daemon-stream");
    // The snapshot is not attempted: the tail is what keeps the list current, so a
    // list read off a bridge that cannot stream would stop being true immediately.
    expect(calledMethods).toStrictEqual([]);
  });

  it("normalizes a rejection that carries no refusal of its own", async () => {
    const { bridge } = bridgeRefusingTheStream(new Error("the preload is a stub"));
    let held: QueueFeed | undefined;
    render(
      <QueueFeedProbe bridge={bridge} sessionId={SESSION_ID} onFeed={(feed) => (held = feed)} />,
    );
    await act(async () => {
      await Promise.resolve();
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

describe("a queued item is cancelled once", () => {
  it("issues one mutation for two synchronous presses on one row", async () => {
    const { bridge, calledMethods } = stubBridge();
    let held: QueueFeed | undefined;
    render(
      <QueueFeedProbe bridge={bridge} sessionId={SESSION_ID} onFeed={(feed) => (held = feed)} />,
    );
    await act(async () => {
      await Promise.resolve();
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
    expect(calledMethods.filter((method) => method === "run.queueCancel")).toHaveLength(1);
  });

  it("negative control: two rows pressed once each are two mutations", async () => {
    // Without this the case above would pass over a chokepoint that dispatched
    // NOTHING, which is a different defect with the same count. The latch is per id,
    // and this is the case that says so.
    const { bridge, calledMethods } = stubBridge();
    let held: QueueFeed | undefined;
    render(
      <QueueFeedProbe bridge={bridge} sessionId={SESSION_ID} onFeed={(feed) => (held = feed)} />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      held?.cancelItem(QUEUE_ITEM_A);
      held?.cancelItem(QUEUE_ITEM_B);
    });
    expect(calledMethods.filter((method) => method === "run.queueCancel")).toHaveLength(2);
  });

  it("takes the row's cancel again once the first has settled", async () => {
    const { bridge, calledMethods } = stubBridge();
    let held: QueueFeed | undefined;
    render(
      <QueueFeedProbe bridge={bridge} sessionId={SESSION_ID} onFeed={(feed) => (held = feed)} />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      held?.cancelItem(QUEUE_ITEM_ID);
      await Promise.resolve();
    });
    expect(held?.pendingCancelIds.has(QUEUE_ITEM_ID)).toBe(false);
    act(() => {
      held?.cancelItem(QUEUE_ITEM_ID);
    });
    expect(calledMethods.filter((method) => method === "run.queueCancel")).toHaveLength(2);
  });

  it("holds one row's cancel without holding another's", async () => {
    const { bridge } = stubBridge();
    let held: QueueFeed | undefined;
    render(
      <QueueFeedProbe bridge={bridge} sessionId={SESSION_ID} onFeed={(feed) => (held = feed)} />,
    );
    await act(async () => {
      await Promise.resolve();
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
    const { bridge, deliver } = stubBridge();
    let held: QueueFeed | undefined;
    render(
      <QueueFeedProbe bridge={bridge} sessionId={SESSION_ID} onFeed={(feed) => (held = feed)} />,
    );
    await act(async () => {
      await Promise.resolve();
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
    const { bridge, deliver } = stubBridge();
    let held: QueueFeed | undefined;
    render(
      <QueueFeedProbe bridge={bridge} sessionId={SESSION_ID} onFeed={(feed) => (held = feed)} />,
    );
    await act(async () => {
      await Promise.resolve();
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
    // delivery missed before the list was restated is no longer missing.
    const { bridge, deliver } = stubBridge([REGISTERED_ROW_DELIVERY]);
    let held: QueueFeed | undefined;
    render(
      <QueueFeedProbe bridge={bridge} sessionId={SESSION_ID} onFeed={(feed) => (held = feed)} />,
    );
    act(() => {
      deliver(UNREADABLE_DELIVERY);
    });
    expect(held?.unreadableDeliveryCount).toBe(1);
    await act(async () => {
      await Promise.resolve();
    });
    expect(held?.unreadableDeliveryCount).toBe(0);
    expect(held?.unreadableRefusal).toBeUndefined();
  });

  it("negative control: a reading whose every delivery parsed claims nothing is missing", async () => {
    // Without this the cases above would pass over a feed that reported every
    // reading as partial, which would make the warning meaningless.
    const { bridge, deliver } = stubBridge();
    let held: QueueFeed | undefined;
    render(
      <QueueFeedProbe bridge={bridge} sessionId={SESSION_ID} onFeed={(feed) => (held = feed)} />,
    );
    await act(async () => {
      await Promise.resolve();
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
    // opened synchronously inside the effect and the snapshot resolves a microtask
    // later, so a delivery made before that await is one that arrived first.
    const { bridge, deliver } = stubBridge([
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
    await act(async () => {
      await Promise.resolve();
    });
    expect(held?.items.map((item) => item.id)).toStrictEqual([QUEUE_ITEM_A, QUEUE_ITEM_B]);
    expect(held?.items[1]?.state).toBe("admitted");
  });
});
