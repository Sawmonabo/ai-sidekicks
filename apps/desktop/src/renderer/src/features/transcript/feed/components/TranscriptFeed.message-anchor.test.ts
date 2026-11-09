// Opening a session at one message, as a link from a workflow run does: the feed finds the row by
// its event cursor, keeps it however far back it sits, scrolls to it and puts focus on the log. A
// message outside the window is reached by one read of the page around it, which takes the
// window's place. A cursor the daemon holds no row at leaves the page where it is, with nothing
// landed and one line saying the message was not found.

import { act, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  validateTranscriptReadResponse,
  type TranscriptReadRequest,
} from "@ai-sidekicks/contracts/transcript/operations";
import type { TranscriptReadRow } from "@ai-sidekicks/contracts/transcript/row";

import { createFixtureBridge } from "#renderer/services/platform/bridge.fixture.js";
import { EMPTY_SESSION_SCENARIO } from "#fixtures/scenarios/empty-session.js";
import { type SessionStore } from "#renderer/store/session/store.js";
import { type TranscriptPageRead } from "#renderer/services/daemon/transcript/page.js";
import { checkedValue } from "#test/helpers/checked-value.js";
import { runFactsServedFor } from "#test/helpers/transcript/run-facts.js";
import {
  LONG_LOG_EVENT_COUNT,
  RowIdBody,
  renderFeed,
  scrollContainerOf,
} from "./TranscriptFeed.test-support.js";
import { withLaidOutViewport } from "../../viewport/controller.test-support.js";
import {
  openPagedSessionStore,
  openSessionStoreWithGeneralLog,
  transcriptFixtureEventId,
  transcriptFixtureStreamCursor,
  transcriptReadRowAt,
} from "../../logs.test-support.js";
import { openSessionStoreWithTerminalRunGroup } from "../../runs/groups.logs.test-support.js";

afterEach(() => {
  vi.restoreAllMocks();
});

/** A message far back from the newest row, which the window lets go of on an ordinary open. */
const FAR_BACK_INDEX = 10;
/**
 * A message far enough above the bottom that an ordinary open, which stands at the bottom, does
 * not mount it, and near enough that the laid-out box's content height reaches it.
 */
const MID_LOG_INDEX = 120;
/** A row twenty rows below `MID_LOG_INDEX`, past the box a landing there mounts. */
const BELOW_MID_LOG_INDEX = 140;

/** Whether the window mounted the row for the event at one log position. */
function isMounted(feed: HTMLElement, index: number): boolean {
  return feed.querySelector(`[data-row-id="${transcriptFixtureEventId(index)}"]`) !== null;
}

/** Where the window placed a row's box in the scrolled content, in pixels. */
function rowOffsetPx(row: HTMLElement): number | undefined {
  const transform = row.closest<HTMLElement>(".meridian-transcript-viewport__row")?.style.transform;
  const offset = /translate3d\(0(?:px)?, (-?[\d.]+)px, 0(?:px)?\)/u.exec(transform ?? "")?.[1];
  return offset === undefined ? undefined : Number(offset);
}

/**
 * The long log mounted with `messageAnchorCursor` naming the message to open at, in a box that
 * opens at its tail as the app's does.
 */
function renderLongFeed(messageAnchorCursor?: string): HTMLElement {
  withLaidOutViewport({ content: "laid-out" });
  return renderFeed(
    openSessionStoreWithGeneralLog(LONG_LOG_EVENT_COUNT),
    undefined,
    RowIdBody,
    messageAnchorCursor === undefined ? {} : { messageAnchorCursor },
  );
}

/** The paged session's log: the window holds its newest rows, `WINDOW_FIRST_INDEX` onward. */
const LOG_ROW_COUNT = 150;
const WINDOW_FIRST_INDEX = 100;
/** A message well before the window, which no ordinary open holds. */
const OUTSIDE_WINDOW_INDEX = 10;
/** The rows the daemon serves around `OUTSIDE_WINDOW_INDEX`: ten before it and ten after. */
const AROUND_FIRST_INDEX = 0;
const AROUND_LAST_INDEX = 20;

/** The log's rows from `firstIndex` through `lastIndex`. */
function rowsBetween(firstIndex: number, lastIndex: number): TranscriptReadRow[] {
  return Array.from({ length: lastIndex - firstIndex + 1 }, (_unused, offset) =>
    transcriptReadRowAt(firstIndex + offset),
  );
}

/**
 * The read the daemon answers around one row, counting what it was asked: the page around
 * `OUTSIDE_WINDOW_INDEX`'s cursor, and for any other cursor the refusal that no row stands there.
 */
function scriptedAroundRead(): {
  readonly read: TranscriptPageRead;
  readonly requests: TranscriptReadRequest[];
} {
  const requests: TranscriptReadRequest[] = [];
  const log = rowsBetween(0, LOG_ROW_COUNT - 1);
  const page = rowsBetween(AROUND_FIRST_INDEX, AROUND_LAST_INDEX);
  return {
    requests,
    read: (request) => {
      requests.push(request);
      return Promise.resolve(
        request.aroundCursor === transcriptFixtureStreamCursor(OUTSIDE_WINDOW_INDEX)
          ? {
              status: "served",
              value: checkedValue(validateTranscriptReadResponse, {
                entries: page,
                runs: runFactsServedFor(page, log),
                hasMore: false,
                joinedThrough: transcriptFixtureStreamCursor(AROUND_LAST_INDEX),
              }),
            }
          : {
              status: "refused",
              refusal: {
                code: "transcript.row.notFound",
                detail: "No row there.",
                origin: "daemon",
              },
            },
      );
    },
  };
}

/** A window holding the log's newest rows, with the history before them still to read. */
function openWindowAtLogEnd(): SessionStore {
  return openPagedSessionStore(WINDOW_FIRST_INDEX, LOG_ROW_COUNT - 1, {
    cursor: transcriptFixtureStreamCursor(WINDOW_FIRST_INDEX - 1),
    hasMore: true,
  });
}

describe("the transcript feed — opened at a message", () => {
  it("centers the window on a message it let go of, lands on it and puts focus on the log", () => {
    const feed = renderLongFeed(transcriptFixtureStreamCursor(FAR_BACK_INDEX));
    expect(isMounted(feed, FAR_BACK_INDEX)).toBe(true);
    expect(document.activeElement).toBe(scrollContainerOf(feed));
  });

  it("scrolls the window to a message above the bottom", () => {
    const feed = renderLongFeed(transcriptFixtureStreamCursor(MID_LOG_INDEX));
    expect(isMounted(feed, MID_LOG_INDEX)).toBe(true);
    expect(isMounted(feed, BELOW_MID_LOG_INDEX)).toBe(false);
  });

  it("negative control: with no message named, the same log mounts neither message", () => {
    // The window lets the far one go and the bottom is far from the other, so the cases above
    // hold only through the landing.
    const feed = renderLongFeed();
    expect(isMounted(feed, FAR_BACK_INDEX)).toBe(false);
    expect(isMounted(feed, MID_LOG_INDEX)).toBe(false);
    expect(document.activeElement).not.toBe(scrollContainerOf(feed));
  });

  it("opens as with no message named for a cursor the log does not hold", () => {
    // The row id, not the stream position: a lookup that confused the two would land here.
    const feed = renderLongFeed(transcriptFixtureEventId(FAR_BACK_INDEX));
    expect(isMounted(feed, FAR_BACK_INDEX)).toBe(false);
    expect(document.activeElement).not.toBe(scrollContainerOf(feed));
  });

  it("lands a link to a row the feed draws nothing for on the next row it draws", () => {
    withLaidOutViewport();
    const feed = renderFeed(
      openSessionStoreWithGeneralLog(LONG_LOG_EVENT_COUNT),
      undefined,
      RowIdBody,
      {
        messageAnchorCursor: transcriptFixtureStreamCursor(FAR_BACK_INDEX),
        drawsBody: (row) => row.id !== transcriptFixtureEventId(FAR_BACK_INDEX),
      },
    );
    // Reading starts at the next drawn row, at the top of the box, and no line says the message
    // is missing: the event is in the log, it draws nothing.
    const box = scrollContainerOf(feed);
    const rowAtTop = [...feed.querySelectorAll<HTMLElement>("[data-row-id]")].find(
      (row) => rowOffsetPx(row) === box.scrollTop,
    );
    expect(rowAtTop?.getAttribute("data-row-id")).toBe(
      transcriptFixtureEventId(FAR_BACK_INDEX + 1),
    );
    expect(feed.textContent).not.toContain("Message not found");
    expect(document.activeElement).toBe(box);
  });

  it("lands once on a message inside a run group, so a reader who folds the group keeps it", () => {
    withLaidOutViewport();
    const fixture = createFixtureBridge({ scenario: EMPTY_SESSION_SCENARIO });
    const feed = renderFeed(openSessionStoreWithTerminalRunGroup(), undefined, RowIdBody, {
      messageAnchorCursor: transcriptFixtureStreamCursor(1),
      fixture,
    });
    // The land draws the rows on screen; the group's header above them draws in a task after.
    act(() => {
      fixture.scenarioEngine.advance(0);
    });
    const disclosure = feed.querySelector<HTMLElement>(".meridian-run-group-header__disclosure");
    expect(disclosure?.getAttribute("aria-expanded")).toBe("true");
    expect(isMounted(feed, 1)).toBe(true);
    expect(document.activeElement).toBe(scrollContainerOf(feed));
    // A reader who folds it afterwards is not overruled.
    disclosure?.focus();
    fireEvent.click(disclosure as Element);
    expect(disclosure?.getAttribute("aria-expanded")).toBe("false");
    expect(isMounted(feed, 1)).toBe(false);
    // Opening it again brings the message back without landing on it again: focus stays on the
    // disclosure the reader pressed.
    fireEvent.click(disclosure as Element);
    expect(isMounted(feed, 1)).toBe(true);
    expect(document.activeElement).toBe(disclosure);
  });
});

describe("the transcript feed — opened at a message outside the window", () => {
  it("reads the page around the message once and lands on it, focused", async () => {
    withLaidOutViewport();
    const aroundRead = scriptedAroundRead();
    const feed = renderFeed(openWindowAtLogEnd(), undefined, RowIdBody, {
      messageAnchorCursor: transcriptFixtureStreamCursor(OUTSIDE_WINDOW_INDEX),
      readTranscriptPage: aroundRead.read,
    });
    await waitFor(() => {
      expect(isMounted(feed, OUTSIDE_WINDOW_INDEX)).toBe(true);
    });
    // One read names the row alone, with no cursor to read before or after.
    expect(aroundRead.requests).toHaveLength(1);
    expect(aroundRead.requests[0]?.aroundCursor).toBe(
      transcriptFixtureStreamCursor(OUTSIDE_WINDOW_INDEX),
    );
    expect(aroundRead.requests[0]?.beforeCursor).toBeUndefined();
    expect(aroundRead.requests[0]?.afterCursor).toBeUndefined();
    expect(feed.textContent).not.toContain("Message not found");
    expect(document.activeElement).toBe(scrollContainerOf(feed));
  });

  it("says the message was not found for a row the daemon no longer holds", async () => {
    withLaidOutViewport();
    const aroundRead = scriptedAroundRead();
    const feed = renderFeed(openWindowAtLogEnd(), undefined, RowIdBody, {
      // The row id, not the cursor: the daemon holds no row at it.
      messageAnchorCursor: transcriptFixtureEventId(OUTSIDE_WINDOW_INDEX),
      readTranscriptPage: aroundRead.read,
    });
    // The one line stands in `Jump to latest`'s place, where the person is looking.
    await waitFor(() => {
      expect(feed.querySelector(".meridian-transcript-viewport__tail")?.textContent).toBe(
        "Message not found",
      );
    });
    expect(feed.querySelector(".meridian-transcript-viewport__pill")).toBeNull();
    expect(aroundRead.requests).toHaveLength(1);
    expect(document.activeElement).not.toBe(scrollContainerOf(feed));
    // It stays until the next act and goes with it.
    fireEvent.pointerDown(document.body);
    expect(feed.textContent).not.toContain("Message not found");
  });

  it("offers a refused read on the catch-up line, whose retry lands the message", async () => {
    withLaidOutViewport();
    let refuses = true;
    const aroundRead = scriptedAroundRead();
    const sessionStore = openWindowAtLogEnd();
    const feed = renderFeed(sessionStore, undefined, RowIdBody, {
      messageAnchorCursor: transcriptFixtureStreamCursor(OUTSIDE_WINDOW_INDEX),
      readTranscriptPage: (request, options) =>
        refuses
          ? Promise.resolve({
              status: "refused",
              refusal: { code: "unscripted", detail: "No page.", origin: "test" },
            })
          : aroundRead.read(request, options),
    });
    await waitFor(() => {
      expect(sessionStore.failedDependentReads.readable.getState().failedReads).toHaveLength(1);
    });
    // A failed read is no missing message, and the link does not ask again on its own.
    expect(feed.textContent).not.toContain("Message not found");
    expect(aroundRead.requests).toHaveLength(0);
    refuses = false;
    act(() => {
      sessionStore.failedDependentReads.retryFailed();
    });
    await waitFor(() => {
      expect(isMounted(feed, OUTSIDE_WINDOW_INDEX)).toBe(true);
    });
    expect(aroundRead.requests).toHaveLength(1);
    expect(sessionStore.failedDependentReads.readable.getState().failedReads).toEqual([]);
  });
});
