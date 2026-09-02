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

import { useEffect } from "react";
import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { QueueItemSummarySchema, type QueueItemSummary } from "@ai-sidekicks/contracts";

import type { ConsoleBridge } from "../../bridge/index.js";
import { QueueOrder, useQueueFeed, type QueueFeed } from "./queue-feed.js";

const SESSION_ID = "0a1b2c3d-4e5f-4061-8273-9a4b5c6d7e8f";
const QUEUE_ITEM_ID = "7c6b5a49-3827-4615-9403-2e1d0c9b8a77";
const QUEUE_ITEM_A = "1a2b3c4d-5e6f-4071-8283-94a5b6c7d8e9";
const QUEUE_ITEM_B = "2b3c4d5e-6f70-4182-9394-a5b6c7d8e9f0";
const QUEUE_ITEM_C = "3c4d5e6f-7081-4293-84a5-b6c7d8e9f001";

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
} {
  let deliverToFeed: (payload: unknown) => void = () => undefined;
  const openedStreams: string[] = [];
  const bridge = {
    sidekicks: {
      daemon: {
        call: async (): Promise<unknown> => ({ items: snapshot }),
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
  return { bridge, deliver: (payload) => deliverToFeed(payload), openedStreams };
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

/** One row of the registered shape, at one state and one `updatedAt`. */
function row(id: string, state: string, updatedAt: string): Record<string, unknown> {
  return { id, state, priority: 0, createdAt: "2026-09-02T09:00:00.000Z", updatedAt };
}

/** The same row, through the registered parse the fold's callers perform. */
function parsedRow(id: string, state: string, updatedAt: string): QueueItemSummary {
  return QueueItemSummarySchema.parse(row(id, state, updatedAt));
}

describe("the snapshot never regresses a newer tail row", () => {
  it("rebuilds the snapshot's order and keeps the newer reading of a raced row", () => {
    // The finding's own example: a tail update for B, then a snapshot of [A, B].
    const order = new QueueOrder();
    order.merge(parsedRow(QUEUE_ITEM_B, "admitted", "2026-09-02T09:00:02.000Z"));
    order.seat([
      parsedRow(QUEUE_ITEM_A, "queued", "2026-09-02T09:00:01.000Z"),
      parsedRow(QUEUE_ITEM_B, "queued", "2026-09-02T09:00:01.000Z"),
    ]);
    expect(order.items().map((item) => item.id)).toStrictEqual([QUEUE_ITEM_A, QUEUE_ITEM_B]);
    expect(order.items()[1]?.state).toBe("admitted");
  });

  it("keeps an admitted tail row against a queued snapshot row", () => {
    const order = new QueueOrder();
    order.merge(parsedRow(QUEUE_ITEM_A, "admitted", "2026-09-02T09:00:05.000Z"));
    order.seat([parsedRow(QUEUE_ITEM_A, "queued", "2026-09-02T09:00:04.000Z")]);
    expect(order.items()[0]?.state).toBe("admitted");
  });

  it("takes the snapshot's row when the snapshot is the newer reading", () => {
    // The rule is "newer wins", not "the tail always wins" — a snapshot taken after
    // the emission is the later reading and is what the list shows.
    const order = new QueueOrder();
    order.merge(parsedRow(QUEUE_ITEM_A, "queued", "2026-09-02T09:00:04.000Z"));
    order.seat([parsedRow(QUEUE_ITEM_A, "canceled", "2026-09-02T09:00:06.000Z")]);
    expect(order.items()[0]?.state).toBe("canceled");
  });

  it("appends tail-only ids after the snapshot's own order", () => {
    const order = new QueueOrder();
    order.merge(parsedRow(QUEUE_ITEM_C, "queued", "2026-09-02T09:00:02.000Z"));
    order.seat([
      parsedRow(QUEUE_ITEM_A, "queued", "2026-09-02T09:00:01.000Z"),
      parsedRow(QUEUE_ITEM_B, "queued", "2026-09-02T09:00:01.000Z"),
    ]);
    expect(order.items().map((item) => item.id)).toStrictEqual([
      QUEUE_ITEM_A,
      QUEUE_ITEM_B,
      QUEUE_ITEM_C,
    ]);
  });

  it("negative control: writing the snapshot over the tail reverses and regresses", () => {
    // The old seat, spelled out so the cases above fail on it rather than passing
    // over a fold that never had the defect: this is what `Map.set` per snapshot row
    // does to a map the tail wrote into first.
    const writtenOver = new Map<string, QueueItemSummary>();
    writtenOver.set(QUEUE_ITEM_B, parsedRow(QUEUE_ITEM_B, "admitted", "2026-09-02T09:00:02.000Z"));
    for (const snapshotRow of [
      parsedRow(QUEUE_ITEM_A, "queued", "2026-09-02T09:00:01.000Z"),
      parsedRow(QUEUE_ITEM_B, "queued", "2026-09-02T09:00:01.000Z"),
    ]) {
      writtenOver.set(snapshotRow.id, snapshotRow);
    }
    expect([...writtenOver.keys()]).toStrictEqual([QUEUE_ITEM_B, QUEUE_ITEM_A]);
    expect(writtenOver.get(QUEUE_ITEM_B)?.state).toBe("queued");
  });

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
