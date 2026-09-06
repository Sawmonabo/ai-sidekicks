// The queue list is re-read when the session's stream comes back.
//
// WHAT THIS IS ABOUT. `run.subscribeQueue` keeps the rows current while it is up, and
// the snapshot read is what says what the whole list is. Before the console's four
// re-read reasons were wired here, that snapshot was taken exactly once — inside the
// reading's own open — so a stream that dropped and was repaired left the pane
// showing the list as it stood before the drop, with every row the daemon queued or
// cancelled in between missing and nothing on screen saying so.
//
// WHY THE CONTROL IS THE WHOLE CASE. A reading that had simply started polling would
// pass the positive assertion, so the negative one — time passing, no repair, and the
// wire staying quiet — is what makes the positive one mean "because it was repaired".

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { settleScheduledRead } from "../scheduled-read.test-support.js";

import { SessionStore } from "../../store/index.js";
import { bridgeAnswering, type BridgeUnderTest } from "../fixture/fixture-bridge.test-support.js";
import { useQueueFeed, useQueueRepairRead } from "./queue-feed.js";
import type { WireReadPhase } from "../readings/reading-lifecycle.js";
import type { ConsoleBridge } from "../console-bridge.js";

const SESSION_ID = "019b7a33-3300-75e5-8510-ada11a5a55a5";

/** A session whose snapshot has landed, which is what makes a repair observable. */
function initialisedStore(): SessionStore {
  const store = new SessionStore({ sessionId: SESSION_ID });
  store.initialise({ cursor: 0, entities: [], participantJoinLog: [] });
  return store;
}

/** A bridge answering the queue list with no rows, and the record of what it was asked. */
function answeringQueueList(): BridgeUnderTest {
  return bridgeAnswering(async (call, forward) => {
    if (call.method === "run.queueList") {
      return { items: [] };
    }
    return forward();
  });
}

function queueListCallCount(under: BridgeUnderTest): number {
  return under.calls.filter((call) => call.method === "run.queueList").length;
}

function QueueProbe(props: {
  readonly bridge: ConsoleBridge;
  readonly sessionStore: SessionStore;
}): null {
  useQueueFeed(props.bridge, props.sessionStore.sessionId);
  useQueueRepairRead(props.bridge, props.sessionStore);
  return null;
}

describe("the queue reading re-reads on a repair", () => {
  it("takes a fresh snapshot when the session's degraded flag clears", async () => {
    const under = answeringQueueList();
    const sessionStore = initialisedStore();
    await act(async () => {
      render(<QueueProbe bridge={under.bridge} sessionStore={sessionStore} />);
    });
    await settleScheduledRead(under.bridge);
    expect(queueListCallCount(under)).toBe(1);

    act(() => {
      sessionStore.markDegraded("subscription-closed");
    });
    // Losing the stream is not the moment: the read would go to a wire that is not
    // answering. The repair is.
    await settleScheduledRead(under.bridge);
    expect(queueListCallCount(under)).toBe(1);

    act(() => {
      sessionStore.initialise({ cursor: 4, entities: [], participantJoinLog: [] });
    });
    await settleScheduledRead(under.bridge);
    expect(queueListCallCount(under)).toBe(2);
  });

  it("negative control: nothing re-reads without a reason", async () => {
    const under = answeringQueueList();
    const sessionStore = initialisedStore();
    await act(async () => {
      render(<QueueProbe bridge={under.bridge} sessionStore={sessionStore} />);
    });
    await settleScheduledRead(under.bridge);
    expect(queueListCallCount(under)).toBe(1);

    await settleScheduledRead(under.bridge);
    await settleScheduledRead(under.bridge);
    expect(queueListCallCount(under)).toBe(1);
  });

  it("waits out a reply the bridge parks on a timer", async () => {
    // Every other case here answers synchronously, so this is the one that says the
    // settling helper waits for a reply that is not merely a microtask away. It is
    // deliberately NOT offered as evidence that the shared drain beats a counted one:
    // a counted pair of microtask passes also settles this chain, because the awaits
    // around the mount already cross a macrotask boundary. What makes the counted
    // form wrong is that the number is tuned against whatever chain it was written
    // over, and that is an argument about the next chain rather than this one.
    const parked = bridgeAnswering(async (call, forward) => {
      if (call.method === "run.queueList") {
        return new Promise((resolveRead) => {
          setTimeout(() => {
            resolveRead({ items: [] });
          }, 0);
        });
      }
      return forward();
    });
    const sessionStore = initialisedStore();
    let phase: WireReadPhase | undefined;
    function ParkedProbe(): null {
      phase = useQueueFeed(parked.bridge, sessionStore.sessionId).phase;
      useQueueRepairRead(parked.bridge, sessionStore);
      return null;
    }
    await act(async () => {
      render(<ParkedProbe />);
    });

    await settleScheduledRead(parked.bridge);
    expect(phase).toBe("read");
  });

  it("re-reads when the window regains focus", async () => {
    // The window half, wired by `useQueueFeed` itself, so a surface holding only the
    // session id still stops showing a list read before the person was away.
    const under = answeringQueueList();
    const sessionStore = initialisedStore();
    await act(async () => {
      render(<QueueProbe bridge={under.bridge} sessionStore={sessionStore} />);
    });
    await settleScheduledRead(under.bridge);
    expect(queueListCallCount(under)).toBe(1);

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await settleScheduledRead(under.bridge);
    expect(queueListCallCount(under)).toBe(2);
  });
});
