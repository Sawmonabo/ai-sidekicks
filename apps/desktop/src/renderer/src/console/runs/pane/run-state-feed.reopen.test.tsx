// A repaired session re-opens the run-state stream over the rows already folded.
//
// WHAT THIS IS ABOUT. This feed has no snapshot read: `run.subscribeState` IS the
// reading, so the only re-read it has is a re-open. Before the trigger set was wired
// here, a stream that dropped was never re-opened at all — the effect had no reason
// to run again, so the pane kept rendering whatever it had folded before the drop for
// the life of the mount.
//
// AND WHY THE FOLD IS NOT MINTED PER SUBSCRIPTION. A re-open that started from an
// empty fold would blank every row the moment the connection came back and leave the
// pane blank until the daemon re-delivered them — a worse reading than the slightly
// stale one it replaced. The rows are the SESSION's, so they outlive the
// subscription and die with the subject.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { settleScheduledRead } from "../../bridge/scheduled-read.test-support.js";

import { RUN_STATE_SUBSCRIBE_STREAM, type ConsoleBridge } from "../../bridge/index.js";
import {
  createFixture,
  withCapturedStream,
} from "../../bridge/fixture/fixture-bridge.test-support.js";
import { withRecordedStreamLifecycle } from "../../bridge/daemon-streams.test-support.js";
import { SessionStore } from "../../store/index.js";
import { useRunFeed, type RunStateFeed } from "./run-state-feed.js";
import { SESSION_ID, STATE_CHANGE_DELIVERY } from "./run-state-feed.test-support.js";

/** A session whose snapshot has landed, which is what makes a repair observable. */
function initialisedStore(): SessionStore {
  const store = new SessionStore({ sessionId: SESSION_ID });
  store.initialise({ cursor: 0, entities: [], participantJoinLog: [] });
  return store;
}

/** One mounted feed, the stream it opened, and how many times it opened one. */
function mountedFeed(): {
  readonly bridge: ConsoleBridge;
  readonly sessionStore: SessionStore;
  readonly deliver: (payload: unknown) => void;
  readonly openCount: () => number;
  readonly feed: () => RunStateFeed;
} {
  // Counted in the bridge family and captured there too: taking `sidekicks.daemon`
  // is that family's licence, and a test in this one goes through what it publishes.
  // The counter wraps the CAPTURE and not the other way round, because the capture
  // answers the run-state stream itself rather than forwarding it — a counter inside
  // it would never be reached and would report every case compliant at zero.
  const captured = withCapturedStream(createFixture().bridge, RUN_STATE_SUBSCRIBE_STREAM);
  const counted = withRecordedStreamLifecycle(captured.bridge);

  const sessionStore = initialisedStore();
  let held: RunStateFeed | undefined;
  function StateFeedProbe(): null {
    held = useRunFeed(counted.bridge, sessionStore);
    return null;
  }
  render(<StateFeedProbe />);
  return {
    bridge: counted.bridge,
    sessionStore,
    deliver: captured.deliver,
    openCount: () => counted.openCountFor(RUN_STATE_SUBSCRIBE_STREAM),
    feed: () => {
      if (held === undefined) {
        throw new Error("the run-state feed reported nothing, so there is no reading to assert");
      }
      return held;
    },
  };
}

describe("the run-state stream re-opens on a repair", () => {
  it("re-opens the stream and keeps the rows it had already folded", async () => {
    const mounted = mountedFeed();
    await act(async () => {
      mounted.deliver(STATE_CHANGE_DELIVERY);
    });
    expect(mounted.feed().runs).toHaveLength(1);
    expect(mounted.openCount()).toBe(1);

    act(() => {
      mounted.sessionStore.markDegraded("subscription-closed");
    });
    await settleScheduledRead(mounted.bridge);
    // The drop is not the moment: a re-open would go to a wire that is not answering.
    expect(mounted.openCount()).toBe(1);

    act(() => {
      mounted.sessionStore.initialise({ cursor: 4, entities: [], participantJoinLog: [] });
    });
    await settleScheduledRead(mounted.bridge);

    expect(mounted.openCount()).toBe(2);
    // The row is still on screen. A fold minted per subscription would report none.
    expect(mounted.feed().runs).toHaveLength(1);
  });

  it("negative control: nothing re-opens without a reason", async () => {
    const mounted = mountedFeed();
    await act(async () => {
      mounted.deliver(STATE_CHANGE_DELIVERY);
    });
    expect(mounted.openCount()).toBe(1);

    await settleScheduledRead(mounted.bridge);
    await settleScheduledRead(mounted.bridge);
    expect(mounted.openCount()).toBe(1);
  });
});
