// The feed's window chain. The body lengths it hands the viewport's measurement table: a reply
// the reveal still draws pairs its whole body's length with the height of the part drawn so far,
// so it would pull its kind's line of height on body length down; the feed reports no length for
// it until its lane is retired. And a long run's window a find step kept the end of, which
// `Jump to latest` puts back on the run's newest call. The chain is the shipped one: a real store,
// the real reveal binding, the real table and viewport controller.

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QueueItemSummary } from "@ai-sidekicks/contracts/run/queue";

import { EMPTY_SESSION_SCENARIO } from "#fixtures/scenarios/empty-session.js";
import { ManualClock } from "#renderer/lib/clock.js";
import { createFixtureBridge } from "#renderer/services/platform/bridge.fixture.js";
import { SessionStore } from "#renderer/store/session/store.js";
import {
  SESSION_ID,
  transcriptFixtureEventId,
  transcriptFixtureStampAt,
  transcriptFixtureStreamCursor,
} from "../../logs.test-support.js";
import {
  longRunCallIds,
  longRunEvents,
  onlyRunGroupOf,
  openSessionStoreWithLongRun,
} from "../../runs/call-window.test-support.js";
import { runWindowEdgeKey } from "../../runs/call-window.js";
import { FixtureBridgeProvider } from "#test/helpers/app/frame-fixtures.js";
import { ViewportController } from "../../viewport/controller.js";
import { useTranscriptFeedWindows } from "./useTranscriptFeedWindows.js";

afterEach(() => {
  vi.restoreAllMocks();
});

/** A session whose queue holds nothing. */
const NO_QUEUE_ITEMS: readonly QueueItemSummary[] = [];
const NO_RETRIES: ReadonlyMap<string, string> = new Map();

/** A store holding one agent reply per body length, oldest first, outside any run. */
function openSessionStoreWithReplies(bodyLengths: readonly number[]): SessionStore {
  const sessionStore = new SessionStore({ sessionId: SESSION_ID });
  sessionStore.initialize({ shape: "project", cursor: -1, entities: [] });
  sessionStore.applyBatch(
    bodyLengths.map((contentLength, index) => ({
      id: transcriptFixtureEventId(index),
      sessionId: SESSION_ID,
      sequence: index,
      cursor: transcriptFixtureStreamCursor(index),
      kind: "agent.message.sent",
      occurredAt: transcriptFixtureStampAt(index),
      payload: { sessionId: SESSION_ID, contentLength },
    })),
  );
  return sessionStore;
}

describe("the transcript feed windows — the body lengths the viewport estimates from", () => {
  it("reports no length for a reply the reveal still draws, so it does not move the line", () => {
    // Two settled replies on 100 px + 0.5 px per byte, a third still being revealed at a height
    // far under its whole body's, and a fourth not yet measured.
    const sessionStore = openSessionStoreWithReplies([200, 600, 1000, 400]);
    const boundVirtualizers = vi.spyOn(ViewportController.prototype, "bindVirtualizer");
    const clock = new ManualClock();
    const feed = renderHook(
      () =>
        useTranscriptFeedWindows({
          sessionStore,
          clock,
          messageAnchorCursor: undefined,
          readTranscriptPage: undefined,
          drawsBody: () => true,
          prepareRow: () => undefined,
          queueItems: NO_QUEUE_ITEMS,
          retriedItemFrom: NO_RETRIES,
        }),
      {
        // The run group disclosure reads the platform bridge.
        wrapper: ({ children }) => (
          <FixtureBridgeProvider
            fixture={createFixtureBridge({ scenario: EMPTY_SESSION_SCENARIO })}
          >
            {children}
          </FixtureBridgeProvider>
        ),
      },
    );
    const controller = boundVirtualizers.mock.contexts.at(-1);
    if (!(controller instanceof ViewportController)) {
      throw new Error("the feed bound no virtualizer to a viewport controller");
    }
    const [settledShort, settledLong, revealing, unmeasured] = [0, 1, 2, 3].map(
      transcriptFixtureEventId,
    ) as [string, string, string, string];
    act(() => {
      feed.result.current.reveal.ingest({ laneId: revealing, mode: "direct", text: "Stre" });
    });
    expect(feed.result.current.reveal.isRevealing(revealing)).toBe(true);

    controller.measurements.acceptedHeight(settledShort, 200);
    controller.measurements.acceptedHeight(settledLong, 400);
    controller.measurements.acceptedHeight(revealing, 150);
    controller.measurements.publishEstimates();

    expect(controller.measurements.heightOf(unmeasured)).toBe(300);
  });
});

describe("the transcript feed windows — Jump to latest after a find step", () => {
  it("shows a live run's newest call with no later line under it", () => {
    // A run long enough that its window holds a few screens of its calls, ending on a call.
    const eventCount = 1205;
    const grownEventCount = eventCount + 40;
    const sessionStore = openSessionStoreWithLongRun(eventCount);
    const clock = new ManualClock();
    const feed = renderHook(
      () =>
        useTranscriptFeedWindows({
          sessionStore,
          clock,
          messageAnchorCursor: undefined,
          readTranscriptPage: undefined,
          drawsBody: () => true,
          prepareRow: () => undefined,
          queueItems: NO_QUEUE_ITEMS,
          retriedItemFrom: NO_RETRIES,
        }),
      {
        wrapper: ({ children }) => (
          <FixtureBridgeProvider
            fixture={createFixtureBridge({ scenario: EMPTY_SESSION_SCENARIO })}
          >
            {children}
          </FixtureBridgeProvider>
        ),
      },
    );
    const runGroup = onlyRunGroupOf(feed.result.current.unfurledWindow);
    const newestCallId = longRunCallIds(longRunEvents(eventCount)).at(-1) ?? "";
    const lastRowKey = (): string | undefined =>
      feed.result.current.transcriptWindow.viewportRows.at(-1)?.key;
    // A press on the earlier edge leaves the newest call past the window's later edge.
    act(() => {
      feed.result.current.openRunStretch(runGroup, "earlier");
    });
    expect(lastRowKey()).toBe(runWindowEdgeKey(runGroup.key, "later"));

    // The find step onto the newest call: open what hides it, then land on it.
    act(() => {
      expect(feed.result.current.unfoldRow(newestCallId)).toBe(true);
    });
    act(() => {
      feed.result.current.viewport.jumpToRow(newestCallId);
    });
    expect(feed.result.current.viewport.snapshot.reading.mode).not.toBe("following");
    act(() => {
      sessionStore.applyBatch(longRunEvents(grownEventCount).slice(eventCount));
    });
    expect(lastRowKey()).toBe(runWindowEdgeKey(runGroup.key, "later"));

    act(() => {
      feed.result.current.viewport.jumpToTail();
    });
    expect(feed.result.current.viewport.snapshot.reading.mode).toBe("following");
    expect(lastRowKey()).toBe(longRunCallIds(longRunEvents(grownEventCount)).at(-1));
  });
});
