// What both halves of the queue-feed suite build their cases out of.
//
// The subscription's cases and the rows' cases were one file, and these are what they
// share: the registered row shapes, the scripted bridge, the probe that reports the
// hook's answer out of the tree, and the two mounts both use. Written once so the two
// files cannot drift into disagreeing about what a registered row looks like — which
// is the exact drift this suite exists to catch on the wire.

import { useEffect, type ReactElement } from "react";
import { act, render } from "@testing-library/react";

import { QUEUE_SUBSCRIBE_STREAM } from "../daemon/daemon-streams.js";
import { withRecordedStreamLifecycle } from "../daemon/daemon-streams.test-support.js";
import {
  createFixture,
  withCapturedStream,
  withDaemonCall,
  type RecordedDaemonCall,
} from "../fixture/fixture-bridge.test-support.js";
import { settleScheduledRead } from "../scheduled-read.test-support.js";
import type { ConsoleBridge } from "../console-bridge.js";
import { useQueueFeed } from "./queue-feed.js";
import type { QueueFeed } from "./queue-reading.js";

export const SESSION_ID = "0a1b2c3d-4e5f-4061-8273-9a4b5c6d7e8f";
export const SECOND_SESSION_ID = "8b7a6959-4837-4726-8514-3f2e1d0c9b8a";
export const QUEUE_ITEM_ID = "7c6b5a49-3827-4615-9403-2e1d0c9b8a77";
export const QUEUE_ITEM_A = "1a2b3c4d-5e6f-4071-8283-94a5b6c7d8e9";
export const QUEUE_ITEM_B = "2b3c4d5e-6f70-4182-9394-a5b6c7d8e9f0";

/** One row, exactly as `QueueItemSummarySchema` registers it. */
export const REGISTERED_ROW_DELIVERY: Readonly<Record<string, unknown>> = {
  id: QUEUE_ITEM_ID,
  state: "queued",
  priority: 0,
  createdAt: "2026-09-02T09:00:00.000Z",
  updatedAt: "2026-09-02T09:00:00.000Z",
};

/** The whole-session envelope, wrapping the very same row. */
export interface EnvelopeShapedDelivery {
  readonly sessionId: string;
  readonly sequence: number;
  readonly kind: string;
  readonly occurredAt: string;
  /** The very row the narrowed stream carries bare — the point of the pair. */
  readonly payload: Readonly<Record<string, unknown>>;
}

export const ENVELOPE_SHAPED_DELIVERY: EnvelopeShapedDelivery = {
  sessionId: SESSION_ID,
  sequence: 4,
  kind: "queue_item.created",
  occurredAt: "2026-09-02T09:00:00.000Z",
  payload: REGISTERED_ROW_DELIVERY,
};

/**
 * The shipped fixture with the queue snapshot scripted and its stream captured.
 *
 * Composed out of the family's own wrappers rather than fabricated. What stood here
 * was an object cast to `ConsoleBridge`, and the cast is what made it wrong in three
 * ways at once: it answered EVERY method with a queue snapshot, it captured EVERY
 * stream rather than the queue's, and it had to carry a hand-made scenario engine
 * because a cast is not a bridge and has no frozen clock for the scheduler to arm on.
 * Each wrapper below names the one thing it replaces, and the fixture answers the
 * rest.
 *
 * The recorder is OUTERMOST, and that ordering is load-bearing: the capture answers
 * the queue stream itself rather than forwarding it, so a recorder inside it would
 * never see that open and would report every case compliant at zero.
 *
 * NAMED FOR WHAT IT ANSWERS. It was `stubBridge`, and so was a wrapper one family
 * away that returns a bare `ConsoleBridge` — same name, same family, two shapes, so a
 * suite reaching for the wrong one got a type error today and a silently different
 * double the moment either return shape widened toward the other. Neither is a stub
 * any more either: both are the shipped fixture with one arm over it.
 */
export function queueFeedBridge(snapshot: readonly unknown[] = []): {
  bridge: ConsoleBridge;
  deliver: (payload: unknown) => void;
  openedStreams: readonly string[];
  calls: readonly RecordedDaemonCall[];
} {
  const answered = withDaemonCall(createFixture().bridge, async () => ({ items: snapshot }));
  const captured = withCapturedStream(answered.bridge, QUEUE_SUBSCRIBE_STREAM);
  const recorded = withRecordedStreamLifecycle(captured.bridge);
  return {
    bridge: recorded.bridge,
    deliver: captured.deliver,
    openedStreams: recorded.openedStreams,
    calls: answered.calls,
  };
}

/**
 * The methods a bridge was asked for, read at assert time off its own record.
 *
 * A function rather than a member, because the record is live: every case here
 * destructures at the top and asserts at the bottom, so a mapped copy taken at
 * destructure time would be empty for the whole of the case.
 */
export function methodsOf(calls: readonly RecordedDaemonCall[]): readonly string[] {
  return calls.map((call) => call.method);
}

/** Reports the feed out of the tree, so a case reads the hook's own answer. */
export function QueueFeedProbe(props: {
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

export async function openFeed(
  options: { readonly snapshot?: readonly unknown[]; readonly sessionId?: string } = {},
): Promise<{
  deliver: (payload: unknown) => void;
  latest: () => QueueFeed;
  openedStreams: readonly string[];
}> {
  const { bridge, deliver, openedStreams } = queueFeedBridge(options.snapshot ?? []);
  let held: QueueFeed | undefined;
  render(
    <QueueFeedProbe
      bridge={bridge}
      sessionId={options.sessionId ?? SESSION_ID}
      onFeed={(feed) => (held = feed)}
    />,
  );
  await settleScheduledRead(bridge);
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
export function TwoQueueSurfaces(props: {
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
