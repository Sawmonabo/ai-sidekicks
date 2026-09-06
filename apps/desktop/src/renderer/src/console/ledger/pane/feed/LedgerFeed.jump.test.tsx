// Jump by event id: which narrowing is hiding the row, and the act that reaches it.
//
// FOUR NARROWINGS SIT BETWEEN THE LOG AND THE SCREEN — the filter, the chapter
// fold, the replay position, and the window cap — and until each got its own arm
// the last one that had a name spoke for all of them. Typing the id of a row folded
// into a chapter, or one a replay was holding back, or one the cap had taken, read
// "That entry is hidden by the filter" over a ledger with no filter on it, and
// offered an act that would have changed nothing.
//
// So every case here drives the COMPOSED feed rather than the classifier — the
// classifier's own cases are `ledger/structure/narrowing/filters.test.ts`'. What only this
// file can say is that the arm the feed reaches is the arm the ledger's real state
// calls for, and that the act it then offers actually reveals the row: each of the
// three actionable arms presses its own button and reads the ledger afterwards.

import { fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  OVER_CAP_EVENT_COUNT,
  REPLAY_LOG_EVENT_COUNT,
  facetChip,
  renderFeed,
  typeIntoFind,
  withLaidOutViewport,
  withdrawLedgerCommands,
} from "./LedgerFeedFixtures.test-support.js";
import {
  LATE_JOINER,
  filterableRowId,
  openSessionStoreWithFilterableLog,
  openSessionStoreWithGeneralLog,
  openSessionStoreWithLog,
  projectedRowId,
} from "./ledger-feed-logs.test-support.js";
import {
  FOLDED_CHAPTER_MESSAGE_ROW_COUNT,
  openSessionStoreWithFoldedMessageChapter,
} from "./ledger-chapter-logs.test-support.js";

afterEach(() => {
  withdrawLedgerCommands();
  vi.restoreAllMocks();
});

const JUMP_ACTION = ".meridian-ledger__jump-action";
/** The words the found arm offers. Reaching them is what "revealed" means here. */
const REACHED = "Go to that entry";
/** Four seconds into a one-row-per-second log: the first five rows and no more. */
const SCRUB_TO_FIFTH_ROW_MS = 4000;

/** The jump offer's words, or `undefined` where the arm offers no act. */
function jumpActionLabel(feed: HTMLElement): string | undefined {
  return feed.querySelector<HTMLElement>(JUMP_ACTION)?.textContent ?? undefined;
}

/** Press whatever the current arm offers. Refuses rather than passing silently. */
function pressJumpAction(feed: HTMLElement): void {
  const action = feed.querySelector<HTMLElement>(JUMP_ACTION);
  if (action === null) {
    throw new Error("the arm offered no act to press");
  }
  fireEvent.click(action);
}

describe("the ledger's jump by event id — which narrowing is hiding the row", () => {
  it("offers a plain jump when the query names a row this window is showing", () => {
    withLaidOutViewport();
    const feed = renderFeed(openSessionStoreWithFilterableLog());

    typeIntoFind(feed, filterableRowId(0));

    expect(jumpActionLabel(feed)).toBe(REACHED);
  });

  it("names the filter, and clearing it reaches the row", () => {
    withLaidOutViewport();
    const feed = renderFeed(openSessionStoreWithFilterableLog());
    fireEvent.click(facetChip(feed, LATE_JOINER));

    typeIntoFind(feed, filterableRowId(0));
    expect(feed.textContent).toContain("hidden by the filter");

    pressJumpAction(feed);

    expect(feed.textContent).not.toContain("hidden by the filter");
    expect(jumpActionLabel(feed)).toBe(REACHED);
  });

  it("names the chapter fold, and opening the chapter reaches the row", () => {
    // A message row inside a run that has finished: the chapter is folded shut by
    // default, so the row is in the narrowed window and out of the folded one.
    withLaidOutViewport();
    const feed = renderFeed(openSessionStoreWithFoldedMessageChapter());

    typeIntoFind(feed, projectedRowId(1));
    expect(feed.textContent).toContain("inside a chapter that is not showing it");
    expect(feed.textContent).not.toContain("hidden by the filter");

    pressJumpAction(feed);

    expect(feed.textContent).not.toContain("inside a chapter that is not showing it");
    expect(jumpActionLabel(feed)).toBe(REACHED);
  });

  it("names the replay position, and leaving the replay reaches the row", () => {
    withLaidOutViewport();
    const feed = renderFeed(openSessionStoreWithLog(REPLAY_LOG_EVENT_COUNT));
    const scrub = feed.querySelector<HTMLInputElement>(".meridian-replay__scrub");
    fireEvent.change(scrub as HTMLInputElement, {
      target: { value: String(SCRUB_TO_FIFTH_ROW_MS) },
    });

    // The last row of the log, which the position has not reached.
    typeIntoFind(feed, projectedRowId(REPLAY_LOG_EVENT_COUNT - 1));
    expect(feed.textContent).toContain("behind the replay position");
    expect(feed.textContent).not.toContain("hidden by the filter");

    pressJumpAction(feed);

    expect(feed.textContent).not.toContain("behind the replay position");
    expect(jumpActionLabel(feed)).toBe(REACHED);
  });

  it("names the cap, and offers no act for it", () => {
    // The one absence with nothing to press: this console subscribes to the log and
    // holds no read that fetches a range of it, so a button here would report a
    // success it could not perform.
    withLaidOutViewport();
    const feed = renderFeed(openSessionStoreWithGeneralLog(OVER_CAP_EVENT_COUNT));

    typeIntoFind(feed, projectedRowId(0));

    expect(feed.textContent).toContain("no longer in this window");
    expect(feed.textContent).not.toContain("hidden by the filter");
    expect(feed.querySelector(JUMP_ACTION)).toBeNull();
  });

  it("scrolls to the row once the act it offered has widened the window", () => {
    // The act cannot jump — every one of them widens the window on the NEXT render,
    // and `jumpToRow` reads the snapshot of the render it was built in — so the
    // request is held and spent when the row is one the viewport holds. Nothing
    // asserted that the held request is ever spent through the real binding: the
    // three cases above pass with the deferred jump a no-op.
    withLaidOutViewport();
    const feed = renderFeed(openSessionStoreWithLog(REPLAY_LOG_EVENT_COUNT));
    const scrub = feed.querySelector<HTMLInputElement>(".meridian-replay__scrub");
    fireEvent.change(scrub as HTMLInputElement, {
      target: { value: String(SCRUB_TO_FIFTH_ROW_MS) },
    });
    const surface = feed.querySelector<HTMLElement>(".meridian-ledger-viewport__surface");
    typeIntoFind(feed, projectedRowId(REPLAY_LOG_EVENT_COUNT - 1));
    // The widening alone moves nothing, which is what makes the reading below the
    // held request being spent rather than a side effect of the act.
    expect(surface?.scrollTop).toBe(0);

    pressJumpAction(feed);

    expect(surface?.scrollTop).toBeGreaterThan(0);
  });

  it("negative control: an ordinary text query says nothing at all", () => {
    // The field is a text search as well as an id entry, so a sentence about an id
    // nothing carries would print over every search somebody performs.
    withLaidOutViewport();
    const feed = renderFeed(openSessionStoreWithFilterableLog());

    typeIntoFind(feed, "run");

    expect(feed.querySelector(JUMP_ACTION)).toBeNull();
    expect(feed.textContent).not.toContain("hidden by the filter");
    expect(feed.textContent).not.toContain("no longer in this window");
  });

  it("negative control: a row this window is showing is never reported absent", () => {
    // Without this every case above would pass over a classifier that answered with
    // an absence for everything, which would put a notice on a complete ledger. The
    // chapter's own rows are the foil: the fold keeps its RECEIPT and drops the
    // rest, so one log holds both answers and the boundary between them is exact.
    withLaidOutViewport();
    const feed = renderFeed(openSessionStoreWithFoldedMessageChapter());
    // The run's start and its messages, folded away; then the receipt that ended it
    // and the live run's own row, both on screen.
    const lastFoldedSequence = FOLDED_CHAPTER_MESSAGE_ROW_COUNT;
    const liveRunSequence = FOLDED_CHAPTER_MESSAGE_ROW_COUNT + 2;

    for (let sequence = 0; sequence <= liveRunSequence; sequence += 1) {
      typeIntoFind(feed, projectedRowId(sequence));
      expect(jumpActionLabel(feed)).toBe(
        sequence <= lastFoldedSequence ? "Open that chapter and go to it" : REACHED,
      );
    }
  });
});
