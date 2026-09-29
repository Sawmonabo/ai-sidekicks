// The queue list is re-read when the session's stream comes back.
//
// WHAT THIS IS ABOUT. The tail keeps the rows current while it is up, and the snapshot
// read is what says what the whole list is. A stream that dropped and was repaired must
// take a fresh snapshot, or the pane shows the list as it stood before the drop with
// every row the daemon queued or canceled in between missing.
//
// WHY THE CONTROL IS THE WHOLE CASE. A reading that had simply started polling would
// pass the positive assertion, so the negative one — time passing, no repair, and the
// wire staying quiet — is what makes the positive one mean "because it was repaired".

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { bridgeWrapper } from "@test/helpers/app-frame-fixtures.js";
import { settleScheduledRead } from "@test/helpers/scheduled-read.js";

import { SessionStore } from "@renderer/store/session/session-store.js";
import { queueFeedBridge } from "./queue-feed.test-support.js";
import { useQueueFeed, useQueueRepairRead } from "./queue-feed.js";
import type { QueueCalls, QueueFeed } from "./queue-reading.js";
import type { PlatformBridge } from "@renderer/services/platform/platform-bridge.js";

/** A session whose snapshot has landed, which is what makes a repair observable. */
function initializedStore(): SessionStore {
  const store = new SessionStore({ sessionId: "019b7a33-3300-75e5-8510-ada11a5a55a5" });
  store.initialize({ cursor: 0, entities: [] });
  return store;
}

function QueueProbe(props: {
  readonly bridge: PlatformBridge;
  readonly queueCalls: QueueCalls;
  readonly sessionStore: SessionStore;
}): null {
  useQueueFeed(props.bridge, props.sessionStore.sessionId, props.queueCalls);
  useQueueRepairRead(props.bridge, props.sessionStore, props.queueCalls);
  return null;
}

describe("the queue reading re-reads on a repair", () => {
  it("takes a fresh snapshot when the session's degraded flag clears", async () => {
    const { bridge, clock, queueCalls, listedSessionIds } = queueFeedBridge();
    const sessionStore = initializedStore();
    await act(async () => {
      render(<QueueProbe bridge={bridge} queueCalls={queueCalls} sessionStore={sessionStore} />, {
        wrapper: bridgeWrapper(bridge, clock),
      });
    });
    await settleScheduledRead(clock);
    expect(listedSessionIds).toHaveLength(1);

    act(() => {
      sessionStore.markDegraded("subscription-closed");
    });
    // Losing the stream is not the moment: the read would go to a wire that is not
    // answering. The repair is.
    await settleScheduledRead(clock);
    expect(listedSessionIds).toHaveLength(1);

    act(() => {
      sessionStore.initialize({ cursor: 4, entities: [] });
    });
    await settleScheduledRead(clock);
    expect(listedSessionIds).toHaveLength(2);
  });

  it("negative control: nothing re-reads without a reason", async () => {
    const { bridge, clock, queueCalls, listedSessionIds } = queueFeedBridge();
    const sessionStore = initializedStore();
    await act(async () => {
      render(<QueueProbe bridge={bridge} queueCalls={queueCalls} sessionStore={sessionStore} />, {
        wrapper: bridgeWrapper(bridge, clock),
      });
    });
    await settleScheduledRead(clock);
    expect(listedSessionIds).toHaveLength(1);

    await settleScheduledRead(clock);
    await settleScheduledRead(clock);
    expect(listedSessionIds).toHaveLength(1);
  });

  it("waits out a reply that is parked on a timer", async () => {
    // Every other case here answers synchronously, so this is the one that says the
    // settling helper waits for a reply that is not merely a microtask away.
    const { bridge, clock, queueCalls } = queueFeedBridge();
    const parked: QueueCalls = {
      ...queueCalls,
      list: () =>
        new Promise((resolveRead) => {
          setTimeout(() => {
            resolveRead([]);
          }, 0);
        }),
    };
    const sessionStore = initializedStore();
    let phase: QueueFeed["phase"] | undefined;
    function ParkedProbe(): null {
      phase = useQueueFeed(bridge, sessionStore.sessionId, parked).phase;
      useQueueRepairRead(bridge, sessionStore, parked);
      return null;
    }
    await act(async () => {
      render(<ParkedProbe />, { wrapper: bridgeWrapper(bridge, clock) });
    });

    await settleScheduledRead(clock);
    expect(phase).toBe("read");
  });

  it("re-reads when the window regains focus", async () => {
    // The window half, wired by `useQueueFeed` itself, so a surface holding only the
    // session id still stops showing a list read before the person was away.
    const { bridge, clock, queueCalls, listedSessionIds } = queueFeedBridge();
    const sessionStore = initializedStore();
    await act(async () => {
      render(<QueueProbe bridge={bridge} queueCalls={queueCalls} sessionStore={sessionStore} />, {
        wrapper: bridgeWrapper(bridge, clock),
      });
    });
    await settleScheduledRead(clock);
    expect(listedSessionIds).toHaveLength(1);

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await settleScheduledRead(clock);
    expect(listedSessionIds).toHaveLength(2);
  });
});
