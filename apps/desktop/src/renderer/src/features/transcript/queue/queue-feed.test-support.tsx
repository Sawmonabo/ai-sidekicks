// What the queue-feed suites build their cases out of.
//
// The registered row shapes, the stubbed calls, the probe that reports the hook's answer
// out of the tree, and the mounts the suites share. Written once so the files cannot
// drift into disagreeing about what a row looks like.

import { useEffect, type ReactElement } from "react";
import { act, render } from "@testing-library/react";
import { QueueItemSummarySchema, type QueueItemSummary } from "@ai-sidekicks/contracts";

import { createFixture } from "@test/helpers/fixture-bridge.js";
import { settleScheduledRead } from "@test/helpers/scheduled-read.js";
import type { PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { useQueueFeed } from "./queue-feed.js";
import type { QueueCalls, QueueFeed } from "./queue-reading.js";

/** The session most cases read. */
export const SESSION_ID = "0a1b2c3d-4e5f-4061-8273-9a4b5c6d7e8f";
/** A second session, for cases that need two readings apart. */
export const SECOND_SESSION_ID = "8b7a6959-4837-4726-8514-3f2e1d0c9b8a";
/** The queue item the single-row cases use. */
export const QUEUE_ITEM_ID = "7c6b5a49-3827-4615-9403-2e1d0c9b8a77";
/** The first of two distinct queue items. */
export const QUEUE_ITEM_A = "1a2b3c4d-5e6f-4071-8283-94a5b6c7d8e9";
/** The second of two distinct queue items. */
export const QUEUE_ITEM_B = "2b3c4d5e-6f70-4182-9394-a5b6c7d8e9f0";

/** One row of the registered shape, at one state and one `updatedAt`. */
export function queueRow(
  id: string,
  state: QueueItemSummary["state"],
  updatedAt: string,
): QueueItemSummary {
  return QueueItemSummarySchema.parse({
    id,
    state,
    priority: 0,
    createdAt: "2026-09-02T09:00:00.000Z",
    updatedAt,
  });
}

/** A queued row, as the tail or the snapshot carries it. */
export const QUEUED_ROW: QueueItemSummary = queueRow(
  QUEUE_ITEM_ID,
  "queued",
  "2026-09-02T09:00:00.000Z",
);

/**
 * The shipped fixture bridge, which supplies the frozen clock and the reconnect signal,
 * and stub queue calls that record what they were asked.
 *
 * The record is live: every case destructures at the top and asserts at the bottom, so
 * each member is an array the calls append to rather than a copy taken up front.
 */
export function queueFeedBridge(snapshot: readonly QueueItemSummary[] = []): {
  bridge: PlatformBridge;
  queueCalls: QueueCalls;
  deliver: (item: QueueItemSummary) => void;
  tailedSessionIds: readonly string[];
  listedSessionIds: readonly string[];
  cancelledItemIds: readonly string[];
} {
  const tailedSessionIds: string[] = [];
  const listedSessionIds: string[] = [];
  const cancelledItemIds: string[] = [];
  const tails = new Set<(item: QueueItemSummary) => void>();
  return {
    bridge: createFixture().bridge,
    queueCalls: {
      list: async (sessionId) => {
        listedSessionIds.push(sessionId);
        return snapshot;
      },
      tail: (sessionId, onItem) => {
        tailedSessionIds.push(sessionId);
        tails.add(onItem);
        return () => {
          tails.delete(onItem);
        };
      },
      cancel: async (queueItemId) => {
        cancelledItemIds.push(queueItemId);
      },
    },
    deliver: (item) => {
      for (const onItem of tails) {
        onItem(item);
      }
    },
    tailedSessionIds,
    listedSessionIds,
    cancelledItemIds,
  };
}

/** Reports the feed out of the tree, so a case reads the hook's own answer. */
export function QueueFeedProbe(props: {
  readonly bridge: PlatformBridge;
  readonly sessionId: string;
  readonly queueCalls: QueueCalls;
  readonly onFeed: (feed: QueueFeed) => void;
}): null {
  const feed = useQueueFeed(props.bridge, props.sessionId, props.queueCalls);
  const { onFeed } = props;
  useEffect(() => {
    onFeed(feed);
  }, [feed, onFeed]);
  return null;
}

/** Mounts one surface on a fresh reading, settles the snapshot, and returns the feed it reads. */
export async function openFeed(snapshot: readonly QueueItemSummary[] = []): Promise<{
  deliver: (item: QueueItemSummary) => void;
  latest: () => QueueFeed;
}> {
  const { bridge, queueCalls, deliver } = queueFeedBridge(snapshot);
  let held: QueueFeed | undefined;
  render(
    <QueueFeedProbe
      bridge={bridge}
      sessionId={SESSION_ID}
      queueCalls={queueCalls}
      onFeed={(feed) => (held = feed)}
    />,
  );
  await settleScheduledRead(bridge);
  return {
    deliver: (item) => {
      act(() => {
        deliver(item);
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

// One session's queue is read once, however many surfaces ask for it. The count is the
// assertion, so the negative controls in the suite show the counter is capable of
// reaching two: a hook that opened nothing would otherwise pass the first case.

/** Two surfaces on one bridge, each asking the hook its own question. */
export function TwoQueueReaders(props: {
  readonly bridge: PlatformBridge;
  readonly queueCalls: QueueCalls;
  readonly firstSessionId: string;
  readonly secondSessionId: string;
}): ReactElement {
  return (
    <>
      <QueueFeedProbe
        bridge={props.bridge}
        sessionId={props.firstSessionId}
        queueCalls={props.queueCalls}
        onFeed={() => undefined}
      />
      <QueueFeedProbe
        bridge={props.bridge}
        sessionId={props.secondSessionId}
        queueCalls={props.queueCalls}
        onFeed={() => undefined}
      />
    </>
  );
}
