// Reading the session's history past the store's window: a stretch asked as the reader nears the
// top, one per gesture, landing above the row being read without moving it; `Load earlier`, its
// failure line and `Try again`; and the forward read after a tail the store let go, as the reader
// nears the bottom or, for a tail let go off screen, as the feed opens.

import { act, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ManualClock } from "#renderer/lib/clock.js";
import { createFixtureBridge } from "#renderer/services/platform/bridge.fixture.js";
import { EMPTY_SESSION_SCENARIO } from "#fixtures/scenarios/empty-session.js";
import { type SessionStore } from "#renderer/store/session/store.js";
import {
  TRANSCRIPT_APPROACH_SCREEN_HEIGHTS,
  TRANSCRIPT_GESTURE_GAP_MS,
  TRANSCRIPT_LET_GO_SCREEN_HEIGHTS,
} from "../../viewport/caps.js";
import { ViewportController } from "../../viewport/controller.js";
import { withLaidOutViewport } from "../../viewport/controller.test-support.js";
import {
  PAGED_SESSION_ID,
  openPagedSessionStore,
  scriptedTranscriptLog,
  transcriptFixtureStreamCursor,
} from "../../logs.test-support.js";
import { RowIdBody, renderFeed } from "./TranscriptFeed.test-support.js";

afterEach(() => {
  vi.restoreAllMocks();
});

/** Rows in the daemon's log of the paged session. */
const DAEMON_LOG_ROWS = 600;
/**
 * Rows the store holds at the bottom of that log: estimated taller than the stretch the opening
 * look-ahead owes, so opening reads nothing, and short of the distance the window lets rows go at.
 */
const WINDOW_ROWS = 48;

function scrollContainerOf(feed: HTMLElement): HTMLElement {
  const scrollContainer = feed.querySelector(".meridian-transcript-viewport__scroll-container");
  if (!(scrollContainer instanceof HTMLElement)) {
    throw new Error("the feed rendered no scroll container");
  }
  return scrollContainer;
}

/**
 * Fails legibly when the held rows are not estimated between the height the opening look-ahead
 * fills and the distance the window lets rows go at: the band every case here is laid out in.
 */
function expectHeldRowsWithinBand(scrollContainer: HTMLElement): void {
  const screenHeightPx = scrollContainer.clientHeight;
  expect(scrollContainer.scrollHeight).toBeGreaterThan(
    (TRANSCRIPT_APPROACH_SCREEN_HEIGHTS + 1) * screenHeightPx,
  );
  expect(scrollContainer.scrollHeight).toBeLessThan(
    TRANSCRIPT_LET_GO_SCREEN_HEIGHTS * screenHeightPx,
  );
}

/** The reader's own scroll: the box moves and says so, as the platform does after a wheel. */
function readerScrollsTo(scrollContainer: HTMLElement, scrollTopPx: number): void {
  scrollContainer.scrollTop = scrollTopPx;
  fireEvent.scroll(scrollContainer);
}

/** The controller the mounted feed bound its virtualizer to. */
function boundController(bindings: {
  readonly mock: { readonly contexts: readonly unknown[] };
}): ViewportController {
  const controller = bindings.mock.contexts.at(-1);
  if (!(controller instanceof ViewportController)) {
    throw new Error("the feed bound no virtualizer to a viewport controller");
  }
  return controller;
}

/** The row whose top edge is the last at or above the top of the box, and where it sits. */
function firstRowOnScreen(
  controller: ViewportController,
  sessionStore: SessionStore,
  scrollTopPx: number,
): { readonly rowKey: string; readonly startPx: number } {
  let first: { readonly rowKey: string; readonly startPx: number } | undefined;
  for (const event of sessionStore.snapshot().transcript) {
    const startPx = controller.rowStartPx(event.id);
    if (startPx !== undefined && startPx <= scrollTopPx) {
      first = { rowKey: event.id, startPx };
    }
  }
  if (first === undefined) {
    throw new Error("no row of the window sits at the top of the box");
  }
  return first;
}

describe("the transcript feed — reading earlier history", () => {
  it("reads one stretch near the top per gesture, holding the row being read", async () => {
    withLaidOutViewport({ content: "laid-out" });
    const fixture = createFixtureBridge({ scenario: EMPTY_SESSION_SCENARIO });
    const clock = fixture.scenarioEngine.clock;
    if (!(clock instanceof ManualClock)) {
      throw new Error("the fixture bridge runs on no frozen clock");
    }
    const log = scriptedTranscriptLog(DAEMON_LOG_ROWS);
    const headIndex = DAEMON_LOG_ROWS - WINDOW_ROWS - 1;
    const sessionStore = openPagedSessionStore(headIndex + 1, DAEMON_LOG_ROWS - 1, {
      cursor: transcriptFixtureStreamCursor(headIndex),
      hasMore: true,
    });
    const bindings = vi.spyOn(ViewportController.prototype, "bindVirtualizer");
    const feed = renderFeed(sessionStore, undefined, RowIdBody, {
      readTranscriptPage: log.read,
      fixture,
    });
    const controller = boundController(bindings);
    const scrollContainer = scrollContainerOf(feed);
    expectHeldRowsWithinBand(scrollContainer);
    const approachPx = TRANSCRIPT_APPROACH_SCREEN_HEIGHTS * scrollContainer.clientHeight;

    // Just outside the approach distance nothing is asked; just inside, one read before the head.
    readerScrollsTo(scrollContainer, approachPx + 1);
    expect(log.requests).toEqual([]);
    readerScrollsTo(scrollContainer, approachPx - 1);
    expect(log.requests).toEqual([
      {
        sessionId: PAGED_SESSION_ID,
        beforeCursor: transcriptFixtureStreamCursor(headIndex),
        limit: expect.any(Number),
      },
    ]);

    // The stretch lands above the row being read, which moves down the content by its height and
    // stays where it was on screen.
    const firstOnScreen = firstRowOnScreen(controller, sessionStore, approachPx - 1);
    await waitFor(() => {
      expect(sessionStore.snapshot().transcript.length).toBeGreaterThan(WINDOW_ROWS);
    });
    const landedStartPx = controller.rowStartPx(firstOnScreen.rowKey) ?? Number.NaN;
    expect(landedStartPx).toBeGreaterThan(firstOnScreen.startPx);
    expect(landedStartPx - scrollContainer.scrollTop).toBeCloseTo(
      firstOnScreen.startPx - (approachPx - 1),
      0,
    );

    // The rest of the fling reaches the top and a wheel pulls past it, still one gesture: nothing
    // more is read.
    readerScrollsTo(scrollContainer, 0);
    fireEvent.wheel(scrollContainer, { deltaY: -100 });
    await act(async () => {
      await Promise.resolve();
    });
    expect(log.requests).toHaveLength(1);

    // A pause ends the gesture, and the next pull at the top reads before the new head.
    clock.advance(TRANSCRIPT_GESTURE_GAP_MS);
    const headCursor = sessionStore.snapshot().transcriptHead.cursor;
    fireEvent.wheel(scrollContainer, { deltaY: -100 });
    expect(log.requests).toHaveLength(2);
    expect(log.requests[1]?.beforeCursor).toBe(headCursor);
  });

  it("reads before the head on `Load earlier` and `Try again`, then leaves", async () => {
    withLaidOutViewport({ content: "laid-out" });
    // Ten rows lie before the head: the first stretch reads them all and ends the history.
    const headIndex = 9;
    const log = scriptedTranscriptLog(headIndex + 1 + WINDOW_ROWS);
    const sessionStore = openPagedSessionStore(headIndex + 1, headIndex + WINDOW_ROWS, {
      cursor: transcriptFixtureStreamCursor(headIndex),
      hasMore: true,
    });
    const feed = renderFeed(sessionStore, undefined, RowIdBody, { readTranscriptPage: log.read });
    expectHeldRowsWithinBand(scrollContainerOf(feed));
    log.refuseNextRead();

    fireEvent.click(within(feed).getByRole("button", { name: "Load earlier" }));
    expect(log.requests).toEqual([
      {
        sessionId: PAGED_SESSION_ID,
        beforeCursor: transcriptFixtureStreamCursor(headIndex),
        limit: expect.any(Number),
      },
    ]);
    await waitFor(() => {
      expect(feed.textContent).toContain("Couldn't load earlier messages · Try again");
    });

    fireEvent.click(within(feed).getByRole("button", { name: "Try again" }));
    expect(log.requests).toHaveLength(2);
    expect(log.requests[1]).toEqual(log.requests[0]);
    await waitFor(() => {
      expect(sessionStore.snapshot().transcript[0]?.sequence).toBe(0);
    });
    expect(within(feed).queryByRole("button", { name: "Load earlier" })).toBeNull();
    expect(feed.textContent).not.toContain("Couldn't load earlier messages");
  });
});

describe("the transcript feed — reading later history", () => {
  it("reads after a tail the store let go once the reader nears the bottom", async () => {
    withLaidOutViewport({ content: "laid-out" });
    const log = scriptedTranscriptLog(DAEMON_LOG_ROWS);
    // One row past the window, so the feed opens in the band and the release below lets one go.
    const sessionStore = openPagedSessionStore(0, WINDOW_ROWS);
    const feed = renderFeed(sessionStore, undefined, RowIdBody, { readTranscriptPage: log.read });
    // The store lets the tail go while the feed is open: everything after its last kept row is the
    // daemon's alone.
    const tailIndex = WINDOW_ROWS - 1;
    act(() => {
      sessionStore.releaseOutside(
        transcriptFixtureStreamCursor(0),
        transcriptFixtureStreamCursor(tailIndex),
      );
    });
    const scrollContainer = scrollContainerOf(feed);
    expectHeldRowsWithinBand(scrollContainer);
    const bottomPx = scrollContainer.scrollHeight - scrollContainer.clientHeight;
    const approachPx = TRANSCRIPT_APPROACH_SCREEN_HEIGHTS * scrollContainer.clientHeight;

    readerScrollsTo(scrollContainer, bottomPx - approachPx - 1);
    expect(log.requests).toEqual([]);
    readerScrollsTo(scrollContainer, bottomPx - approachPx + 1);
    expect(log.requests).toEqual([
      {
        sessionId: PAGED_SESSION_ID,
        afterCursor: transcriptFixtureStreamCursor(tailIndex),
        limit: expect.any(Number),
      },
    ]);
    await waitFor(() => {
      expect(sessionStore.snapshot().transcript.at(-1)?.sequence).toBeGreaterThan(tailIndex);
    });
  });

  it("reads after a tail let go while the session was off screen as the feed opens", async () => {
    withLaidOutViewport({ content: "laid-out" });
    const log = scriptedTranscriptLog(DAEMON_LOG_ROWS);
    const tailIndex = WINDOW_ROWS + 11;
    const sessionStore = openPagedSessionStore(0, tailIndex);
    // Off screen the store keeps only its newest rows and stops following the live tail.
    sessionStore.releaseBeyondNewest(WINDOW_ROWS);

    renderFeed(sessionStore, undefined, RowIdBody, { readTranscriptPage: log.read });
    expect(log.requests).toEqual([
      {
        sessionId: PAGED_SESSION_ID,
        afterCursor: transcriptFixtureStreamCursor(tailIndex),
        limit: expect.any(Number),
      },
    ]);
    await waitFor(() => {
      expect(sessionStore.snapshot().transcript.at(-1)?.sequence).toBeGreaterThan(tailIndex);
    });
  });
});
