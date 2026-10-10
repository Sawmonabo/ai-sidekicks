// Reading the session's history past the store's window: a stretch asked as the reader nears the
// top, one per gesture, landing above the row being read without moving it; `Load earlier`, its
// failure line and `Try again`; the forward read after a tail the store let go as the reader nears
// the bottom; and a session off screen, which keeps only its newest rows and, when the reader
// returns, reads the rest forward as the feed opens and rejoins the stream.

import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TranscriptReadRequest } from "@ai-sidekicks/contracts/transcript/operations";

import { ManualClock } from "#renderer/lib/clock.js";
import { transcriptPageReadThroughDaemon } from "#renderer/services/daemon/transcript/page.js";
import { createFixtureBridge } from "#renderer/services/platform/bridge.fixture.js";
import { EMPTY_SESSION_SCENARIO } from "#fixtures/scenarios/empty-session.js";
import {
  SessionStoreRegistry,
  type SessionStreamOpening,
} from "#renderer/store/session/registry.js";
import { type SessionStore } from "#renderer/store/session/store.js";
import { withDaemonCall } from "#test/helpers/fixture/bridge.js";
import { crossMacrotaskBoundary } from "#test/helpers/macrotask-boundary.js";
import { openingPageLimit } from "#test/helpers/session/store/fixtures.js";
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
  pagedSessionEventAt,
  scriptedTranscriptLog,
  transcriptFixtureStreamCursor,
} from "../../logs.test-support.js";
import {
  LONG_LOG_EVENT_COUNT,
  RowIdBody,
  boundController,
  readerScrollsTo,
  renderFeed,
  scrollContainerOf,
} from "./TranscriptFeed.test-support.js";

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
/** Rows a session keeps off screen: fewer than the viewport keeps around the bottom it opens at. */
const OFF_SCREEN_ROWS = 20;
/** The newest row the off-screen session's opening read places: a log the viewport lets go in. */
const OPENED_THROUGH = LONG_LOG_EVENT_COUNT - 1;
/** The newest row the log holds when the returning reader's read is answered. */
const READ_THROUGH = OPENED_THROUGH + 15;
/** The newest row the stream delivers while that read is in flight. */
const STREAMED_THROUGH = READ_THROUGH + 15;
/** The off-screen session's refresh debounce, which its frozen clock is advanced past. */
const REFRESH_DEBOUNCE_MS = 20;

/** The ids of the rows the window has drawn into the document now. */
function drawnRowIds(): string[] {
  return [...document.querySelectorAll("[data-row-id]")].flatMap(
    (row) => row.getAttribute("data-row-id") ?? [],
  );
}

/** The log positions `first` through `last`, in order. */
function logPositions(first: number, last: number): number[] {
  return Array.from({ length: last - first + 1 }, (_unused, offset) => first + offset);
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

    // Every input stands on one timeline, so a slow run cannot stretch the gesture past its gap.
    const gestureAtMs = 1_000;
    const inGestureAtMs = gestureAtMs + 1;

    // Just outside the approach distance nothing is asked; just inside, one read before the head.
    readerScrollsTo(scrollContainer, approachPx + 1, gestureAtMs);
    expect(log.requests).toEqual([]);
    readerScrollsTo(scrollContainer, approachPx - 1, gestureAtMs);
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
    readerScrollsTo(scrollContainer, 0, inGestureAtMs);
    const pullInGesture = new WheelEvent("wheel", { deltaY: -100, bubbles: true });
    Object.defineProperty(pullInGesture, "timeStamp", { value: inGestureAtMs });
    fireEvent(scrollContainer, pullInGesture);
    await act(async () => {
      await Promise.resolve();
    });
    expect(log.requests).toHaveLength(1);

    // A pause ends the gesture, timed by the pulls' own event stamps, and the next pull at the top
    // reads before the new head.
    const headCursor = sessionStore.snapshot().transcriptHead.cursor;
    const pullAfterPause = new WheelEvent("wheel", { deltaY: -100, bubbles: true });
    Object.defineProperty(pullAfterPause, "timeStamp", {
      value: inGestureAtMs + TRANSCRIPT_GESTURE_GAP_MS,
    });
    fireEvent(scrollContainer, pullAfterPause);
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
});

describe("the transcript feed — a session off screen", () => {
  it("keeps its newest rows off screen and reads the rest back when the reader returns", async () => {
    withLaidOutViewport({ content: "laid-out" });
    const fixture = createFixtureBridge({ scenario: EMPTY_SESSION_SCENARIO });
    const log = scriptedTranscriptLog(READ_THROUGH + 1);
    // Every `transcript.read` waits until the case lets it land, so the stream can deliver rows
    // the daemon wrote after it answered the read.
    let landReads: () => void = () => undefined;
    const readsLand = new Promise<void>((resolve) => {
      landReads = resolve;
    });
    const { bridge, calls } = withDaemonCall(fixture.bridge, async (call, passThrough) => {
      if (call.method !== "transcript.read") {
        return await passThrough();
      }
      await readsLand;
      const reply = await log.read(call.params as TranscriptReadRequest);
      if (reply.status !== "served") {
        throw new Error(`the scripted log served no page for ${JSON.stringify(call.params)}`);
      }
      return reply.value;
    });
    const readTranscriptPage = transcriptPageReadThroughDaemon(bridge);
    const transcriptReads = (): unknown[] =>
      calls.filter((call) => call.method === "transcript.read").map((call) => call.params);
    const registryClock = new ManualClock(0);
    const registry = new SessionStoreRegistry({
      read: () =>
        Promise.resolve({
          cursor: OPENED_THROUGH,
          entities: [],
          transcript: logPositions(0, OPENED_THROUGH).map(pagedSessionEventAt),
        }),
      clock: registryClock,
      openingPageLimit,
      offScreenRowLimit: () => OFF_SCREEN_ROWS,
      refreshDebounceMs: REFRESH_DEBOUNCE_MS,
    });
    const deliver = (first: number, last: number): void => {
      act(() => {
        expect(
          registry.enqueue(PAGED_SESSION_ID, logPositions(first, last).map(pagedSessionEventAt)),
        ).toBeUndefined();
        expect(registry.flush(PAGED_SESSION_ID)).toBeUndefined();
      });
    };
    const sessionStore = registry.open(PAGED_SESSION_ID);
    const heldSequences = (): number[] =>
      sessionStore.snapshot().transcript.map((event) => event.sequence);

    // On screen, the viewport lets go of rows far above the bottom the feed opens at, and the
    // store of their events, but never of an event a row drawn at that moment is drawn from.
    const endFirstLook = registry.markOnScreen(PAGED_SESSION_ID);
    registry.requestRefresh(PAGED_SESSION_ID, "subscribe");
    registryClock.advance(REFRESH_DEBOUNCE_MS);
    await crossMacrotaskBoundary();
    expect(heldSequences()).toStrictEqual(logPositions(0, OPENED_THROUGH));
    // A pass-through recorder: the rows drawn at the moment of the release, read before React
    // draws again from the cut store.
    const releaseOutside = sessionStore.releaseOutside.bind(sessionStore);
    const drawnRowIdsAtRelease: string[] = [];
    vi.spyOn(sessionStore, "releaseOutside").mockImplementation((firstKept, lastKept) => {
      drawnRowIdsAtRelease.push(...drawnRowIds());
      releaseOutside(firstKept, lastKept);
    });
    renderFeed(sessionStore, undefined, RowIdBody, { readTranscriptPage, fixture });
    await waitFor(() => {
      expect(heldSequences()[0]).toBeGreaterThan(0);
    });
    const heldRowIds = new Set(sessionStore.snapshot().transcript.map((event) => event.id));
    expect(drawnRowIdsAtRelease.length).toBeGreaterThan(0);
    expect(drawnRowIdsAtRelease.filter((rowId) => !heldRowIds.has(rowId))).toStrictEqual([]);

    // Off screen the store keeps only its newest rows, and the stream folds past them without
    // growing the window.
    expect(heldSequences().length).toBeGreaterThan(OFF_SCREEN_ROWS);
    cleanup();
    endFirstLook();
    const keptSequences = logPositions(OPENED_THROUGH - OFF_SCREEN_ROWS + 1, OPENED_THROUGH);
    expect(heldSequences()).toStrictEqual(keptSequences);
    expect(sessionStore.snapshot().transcriptTail).toStrictEqual({
      cursor: transcriptFixtureStreamCursor(OPENED_THROUGH),
      hasMore: true,
      following: "detached",
    });
    deliver(OPENED_THROUGH + 1, READ_THROUGH);
    expect(heldSequences()).toStrictEqual(keptSequences);
    expect(sessionStore.snapshot().cursor).toBe(READ_THROUGH);

    // The reader returns: the feed opens by reading forward from the kept edge. While that read is
    // in flight the stream delivers the rows written after the daemon answered it.
    const streamOpenings: SessionStreamOpening[] = [];
    const stopWatchingStream = registry.subscribeToStreamOpenings((opening) => {
      streamOpenings.push(opening);
    });
    const endReturn = registry.markOnScreen(PAGED_SESSION_ID);
    renderFeed(sessionStore, undefined, RowIdBody, { readTranscriptPage, fixture });
    await waitFor(() => {
      expect(transcriptReads()).toHaveLength(1);
    });
    expect(transcriptReads()).toStrictEqual([
      {
        sessionId: PAGED_SESSION_ID,
        afterCursor: transcriptFixtureStreamCursor(OPENED_THROUGH),
        limit: expect.any(Number),
      },
    ]);
    deliver(READ_THROUGH + 1, STREAMED_THROUGH);
    expect(heldSequences()).toStrictEqual(keptSequences);

    // The page reaches the end of the log the read found, behind the stream, so the tail goes live
    // and the stream is opened again after the page's newest row.
    act(() => {
      landReads();
    });
    await waitFor(() => {
      expect(sessionStore.snapshot().transcriptTail.following).toBe("live");
    });
    expect(heldSequences()).toStrictEqual(logPositions(keptSequences[0]!, READ_THROUGH));
    expect(streamOpenings).toStrictEqual([
      {
        sessionId: PAGED_SESSION_ID,
        afterCursor: transcriptFixtureStreamCursor(READ_THROUGH),
        afterSequence: READ_THROUGH,
      },
    ]);

    // The reopened stream sends again the rows it already delivered, then a new one; rows it
    // repeats once the window holds them join no second time.
    deliver(READ_THROUGH + 1, STREAMED_THROUGH + 1);
    deliver(STREAMED_THROUGH, STREAMED_THROUGH + 1);
    expect(heldSequences()).toStrictEqual(logPositions(keptSequences[0]!, STREAMED_THROUGH + 1));
    expect(transcriptReads()).toHaveLength(1);

    stopWatchingStream();
    endReturn();
    registry.disposeAll();
  });
});
