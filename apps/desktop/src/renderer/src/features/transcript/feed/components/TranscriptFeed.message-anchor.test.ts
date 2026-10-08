// Opening a session at one message, as a link from a workflow run does: the feed finds the row by
// its event cursor, keeps it however far back it sits, scrolls to it and puts focus on the log. A
// message older than the window is reached by reading back. A cursor no read holds opens at the
// bottom with nothing landed.

import { act, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  TranscriptReadResponseSchema,
  type TranscriptReadResponse,
} from "@ai-sidekicks/contracts/transcript/operations";
import type { TranscriptEventRow } from "@ai-sidekicks/contracts/transcript/row";
import type { EventCursor } from "@ai-sidekicks/contracts/session/event-cursor";

import { type SessionStore } from "#renderer/store/session/store.js";
import { type TranscriptPageRead } from "#renderer/services/daemon/transcript-page.js";
import { LONG_LOG_EVENT_COUNT, RowIdBody, renderFeed } from "./TranscriptFeed.test-support.js";
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

function scrollContainerOf(feed: HTMLElement): Element | null {
  return feed.querySelector(".meridian-transcript-viewport__scroll-container");
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

/** Rows per backward page: the log behind the window is two pages, the window a third. */
const PAGE_ROWS = 50;
/** On the second page back, so the first page alone does not reach it. */
const BEFORE_FIRST_PAGE_INDEX = 10;
/** The store's head cursor: everything at or before it is behind the window. */
const WINDOW_HEAD_CURSOR = "position-before-100" as EventCursor;

function rowsFrom(firstIndex: number): TranscriptEventRow[] {
  return Array.from({ length: PAGE_ROWS }, (_unused, offset) =>
    transcriptReadRowAt(firstIndex + offset),
  );
}

/** The two pages behind the window, keyed by the position each is asked before. */
const PAGES_BY_BEFORE_CURSOR: Readonly<Record<string, TranscriptReadResponse>> = {
  [WINDOW_HEAD_CURSOR]: TranscriptReadResponseSchema.parse({
    entries: rowsFrom(50),
    hasMore: true,
    nextCursor: "position-before-50",
  }),
  "position-before-50": TranscriptReadResponseSchema.parse({
    entries: rowsFrom(0),
    hasMore: false,
  }),
};

/** The backward read over those pages, counting what it was asked. */
function scriptedEarlierRead(): {
  readonly read: TranscriptPageRead;
  readonly calls: () => number;
} {
  let calls = 0;
  return {
    read: (request) => {
      calls += 1;
      const page =
        request.beforeCursor === undefined
          ? undefined
          : PAGES_BY_BEFORE_CURSOR[request.beforeCursor];
      return Promise.resolve(
        page === undefined
          ? {
              status: "refused",
              refusal: { code: "unscripted", detail: "No page there.", origin: "test" },
            }
          : { status: "served", value: page },
      );
    },
    calls: () => calls,
  };
}

/** A window whose head is `headCursor`, holding only the newest page of messages. */
function openWindowAfterTwoPages(headCursor: EventCursor = WINDOW_HEAD_CURSOR): SessionStore {
  return openPagedSessionStore(2 * PAGE_ROWS, 3 * PAGE_ROWS - 1, {
    cursor: headCursor,
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
    // Reading starts at the next drawn row.
    expect(isMounted(feed, FAR_BACK_INDEX + 1)).toBe(true);
    expect(document.activeElement).toBe(scrollContainerOf(feed));
  });

  it("opens the finished run group holding the message, and lands on it once", () => {
    withLaidOutViewport();
    const feed = renderFeed(openSessionStoreWithTerminalRunGroup(), undefined, RowIdBody, {
      messageAnchorCursor: transcriptFixtureStreamCursor(1),
    });
    const disclosure = feed.querySelector<HTMLElement>(".meridian-run-group-header__disclosure");
    expect(disclosure?.getAttribute("aria-expanded")).toBe("true");
    expect(isMounted(feed, 1)).toBe(true);
    expect(document.activeElement).toBe(scrollContainerOf(feed));
    // A reader who folds it again is not overruled.
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

describe("the transcript feed — opened at a message older than the window", () => {
  it("reads back past the first page to the message and lands on it, focused", async () => {
    withLaidOutViewport();
    const earlierRead = scriptedEarlierRead();
    const feed = renderFeed(openWindowAfterTwoPages(), undefined, RowIdBody, {
      messageAnchorCursor: transcriptFixtureStreamCursor(BEFORE_FIRST_PAGE_INDEX),
      readTranscriptPage: earlierRead.read,
    });
    await waitFor(() => {
      expect(isMounted(feed, BEFORE_FIRST_PAGE_INDEX)).toBe(true);
    });
    expect(earlierRead.calls()).toBe(2);
    expect(document.activeElement).toBe(scrollContainerOf(feed));
  });

  it("stops at the start of history for a cursor no page holds, landing nothing", async () => {
    withLaidOutViewport();
    const earlierRead = scriptedEarlierRead();
    const feed = renderFeed(openWindowAfterTwoPages(), undefined, RowIdBody, {
      // The row id, not the cursor: no page carries it as a position.
      messageAnchorCursor: transcriptFixtureEventId(BEFORE_FIRST_PAGE_INDEX),
      readTranscriptPage: earlierRead.read,
    });
    // The page that ends history takes the `Load earlier` line away.
    await waitFor(() => {
      expect(feed.querySelector(".meridian-transcript-viewport__load-earlier")).toBeNull();
    });
    expect(earlierRead.calls()).toBe(2);
    expect(document.activeElement).not.toBe(scrollContainerOf(feed));
  });

  it("stops at a refused read rather than asking again", async () => {
    withLaidOutViewport();
    const earlierRead = scriptedEarlierRead();
    const feed = renderFeed(
      openWindowAfterTwoPages("position-no-page-answers" as EventCursor),
      undefined,
      RowIdBody,
      {
        messageAnchorCursor: transcriptFixtureStreamCursor(BEFORE_FIRST_PAGE_INDEX),
        readTranscriptPage: earlierRead.read,
      },
    );
    await waitFor(() => {
      expect(feed.textContent).toContain("Couldn't load earlier messages");
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(earlierRead.calls()).toBe(1);
  });
});
