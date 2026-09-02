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

import type { ConsoleBridge } from "../../bridge/index.js";
import { useQueueFeed, type QueueFeed } from "./queue-feed.js";

const SESSION_ID = "0a1b2c3d-4e5f-4061-8273-9a4b5c6d7e8f";
const QUEUE_ITEM_ID = "7c6b5a49-3827-4615-9403-2e1d0c9b8a77";

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
function stubBridge(): { bridge: ConsoleBridge; deliver: (payload: unknown) => void } {
  let deliverToFeed: (payload: unknown) => void = () => undefined;
  const bridge = {
    sidekicks: {
      daemon: {
        call: async (): Promise<unknown> => ({ items: [] }),
        subscribe: (_stream: string, handler: (payload: unknown) => void) => {
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
  return { bridge, deliver: (payload) => deliverToFeed(payload) };
}

/** Reports the feed out of the tree, so a case reads the hook's own answer. */
function QueueFeedProbe(props: {
  readonly bridge: ConsoleBridge;
  readonly onFeed: (feed: QueueFeed) => void;
}): null {
  const feed = useQueueFeed(props.bridge, SESSION_ID);
  const { onFeed } = props;
  useEffect(() => {
    onFeed(feed);
  }, [feed, onFeed]);
  return null;
}

async function openFeed(): Promise<{
  deliver: (payload: unknown) => void;
  latest: () => QueueFeed;
}> {
  const { bridge, deliver } = stubBridge();
  let held: QueueFeed | undefined;
  render(<QueueFeedProbe bridge={bridge} onFeed={(feed) => (held = feed)} />);
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
