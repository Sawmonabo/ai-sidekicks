// What the shelf's feed will and will not read off `run.subscribeQueue`.
//
// The same seam the runs pane reads, and the same contract: the stream carries the
// registered `QueueItemSummary` projection, never the whole-session event envelope.
// Asserted here as well as beside the pane's fold because the two folds are
// deliberately separate — the shelf keeps `queued` alone and drops a row the moment
// the daemon says it is no longer waiting — so a change to one is not a change to
// the other, and a shared assertion would leave whichever fold it did not run
// against unguarded.
//
// The failure this catches is silent: an envelope-shaped delivery leaves the shelf
// showing nothing, which is indistinguishable from a participant having nothing
// waiting.

import { useEffect } from "react";
import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ConsoleBridge } from "../../../console/bridge/index.js";
import { useQueueFeed, type QueueFeed } from "./queue-feed.js";

const SESSION_ID = "0a1b2c3d-4e5f-4061-8273-9a4b5c6d7e8f";
const QUEUE_ITEM_ID = "7c6b5a49-3827-4615-9403-2e1d0c9b8a77";

/** One waiting row, exactly as `QueueItemSummarySchema` registers it. */
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

/** A bridge that hands the test the subscription handler. */
function stubBridge(): { bridge: ConsoleBridge; deliver: (payload: unknown) => void } {
  let deliverToFeed: (payload: unknown) => void = () => undefined;
  const bridge = {
    sidekicks: {
      daemon: {
        call: async (): Promise<unknown> => undefined,
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
function ShelfFeedProbe(props: {
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

async function openShelfFeed(): Promise<{
  deliver: (payload: unknown) => void;
  latest: () => QueueFeed;
}> {
  const { bridge, deliver } = stubBridge();
  let held: QueueFeed | undefined;
  render(<ShelfFeedProbe bridge={bridge} onFeed={(feed) => (held = feed)} />);
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
        throw new Error("the shelf feed reported nothing, so there is no reading to assert");
      }
      return held;
    },
  };
}

describe("the shelf feed reads the registered payload shape", () => {
  it("holds a waiting row from a registered-shape delivery", async () => {
    const { deliver, latest } = await openShelfFeed();
    deliver(REGISTERED_ROW_DELIVERY);
    expect(latest().hasRead).toBe(true);
    expect(latest().items).toHaveLength(1);
  });
});

describe("the shelf feed ignores the whole-session envelope", () => {
  it("holds nothing from an envelope-shaped delivery and reports nothing read", async () => {
    const { deliver, latest } = await openShelfFeed();
    deliver(ENVELOPE_SHAPED_DELIVERY);
    expect(latest().items).toHaveLength(0);
    // `hasRead` is what separates "the stream said nothing" from "the stream said
    // something this feed could not read", and an ignored delivery is the latter.
    expect(latest().hasRead).toBe(false);
  });

  it("negative control: the envelope's own payload is held on its own", async () => {
    const { deliver, latest } = await openShelfFeed();
    deliver(ENVELOPE_SHAPED_DELIVERY.payload);
    expect(latest().items).toHaveLength(1);
  });
});
