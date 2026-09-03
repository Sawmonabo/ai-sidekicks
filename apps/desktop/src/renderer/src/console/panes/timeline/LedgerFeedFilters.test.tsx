// Narrowing the mounted ledger — the model reached at last.
//
// Every case here drives the COMPOSED feed rather than `applyLedgerFilter`, because
// the defect this file pins was never in the filter: `filters.test.ts` has proved
// the narrowing correct since it was written, and no surface in the application
// could reach it. So each case presses a chip or runs a palette row and reads what
// the feed and the rail then hold.
//
// THE BOUNDARY RULE IS THE ONE THAT MUST NOT REGRESS. A narrowing that kept a run's
// rows and dropped the rollback boundary between them would render a history that
// had been corrected as though it never was. Its fixture gives the boundary a
// different actor from the run, so admitting the run's participant admits the
// boundary only through the rule.

import { fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { deriveLedgerFacets } from "../../ledger/structure/index.js";
import {
  contributeLedgerCommands,
  dispatchConsoleCommand,
  renderFeed,
  withLaidOutViewport,
  withdrawLedgerCommands,
} from "./ledger-feed-fixtures.js";
import {
  EARLY_JOINER,
  FOLDED_CHAPTER_MESSAGE_ROW_COUNT,
  LATE_JOINER,
  filterableRowId,
  foldedMessageChapterLog,
  openSessionStoreWithFilterableLog,
  openSessionStoreWithFoldedMessageChapter,
} from "./ledger-feed-logs.js";
import { foldChapterHeaders } from "./ledger-chapter-fold.js";
import { deriveLedgerWindow } from "./ledger-window.js";

afterEach(() => {
  withdrawLedgerCommands();
  vi.restoreAllMocks();
});

const FACET = ".meridian-ledger-filter__facet";
const SEAT_ROW = ".meridian-ledger-viewport__row";
const CHAPTER_HEADER = ".meridian-chapter-header";
const CHAPTER_DISCLOSURE = ".meridian-chapter-header__disclosure";
const MESSAGE_FAMILY = "assistant_output";
const TOOL_FAMILY = "tool_activity";

/** One facet chip, by the value it offers. Refuses rather than answering null. */
function facetChip(feed: HTMLElement, value: string): HTMLElement {
  const chip = [...feed.querySelectorAll<HTMLElement>(FACET)].find(
    (candidate) =>
      candidate.querySelector(".meridian-ledger-filter__facet-value")?.textContent === value,
  );
  if (chip === undefined) {
    throw new Error(`the bar offered no facet for ${value}`);
  }
  return chip;
}

/** Every facet value the bar offers, in the order it offers them. */
function offeredFacets(feed: HTMLElement): readonly string[] {
  return [...feed.querySelectorAll<HTMLElement>(".meridian-ledger-filter__facet-value")].map(
    (value) => value.textContent ?? "",
  );
}

function seatRowCount(feed: HTMLElement): number {
  return feed.querySelectorAll(SEAT_ROW).length;
}

describe("the ledger's facet bar — a press narrows the feed", () => {
  it("narrows to one participant's rows, and the rail with them", () => {
    withLaidOutViewport();
    const feed = renderFeed(openSessionStoreWithFilterableLog());
    const unfilteredRowCount = seatRowCount(feed);

    fireEvent.click(facetChip(feed, EARLY_JOINER));

    // The agent authored one run row; the boundary rides in on the rule below.
    expect(seatRowCount(feed)).toBeLessThan(unfilteredRowCount);
    expect(facetChip(feed, EARLY_JOINER).getAttribute("aria-pressed")).toBe("true");
  });

  it("keeps a narrowed run's rollback boundary, which is the rule that must not regress", () => {
    withLaidOutViewport();
    const feed = renderFeed(openSessionStoreWithFilterableLog());

    fireEvent.click(facetChip(feed, EARLY_JOINER));

    // The boundary's own actor is the OTHER participant, so it is here only because
    // the filter re-admitted it for the run whose rows it admitted.
    expect(feed.querySelector(".meridian-seam-row")).not.toBeNull();
  });

  it("narrows by event family", () => {
    withLaidOutViewport();
    const feed = renderFeed(openSessionStoreWithFilterableLog());
    const unfilteredRowCount = seatRowCount(feed);

    fireEvent.click(facetChip(feed, "run_lifecycle"));

    expect(seatRowCount(feed)).toBeLessThan(unfilteredRowCount);
  });

  it("offers only the families this window actually holds", () => {
    // Negative control for the offer itself: a hand-written list of every
    // `EventCategory` would put families here that match nothing in this session.
    withLaidOutViewport();
    const feed = renderFeed(openSessionStoreWithFilterableLog());

    const offered = offeredFacets(feed);
    expect(offered).toContain("run_lifecycle");
    expect(offered).not.toContain("mcp_lifecycle");
    expect(offered).toContain(EARLY_JOINER);
    expect(offered).toContain(LATE_JOINER);
  });

  it("negative control: an unfiltered feed renders every row it renders today", () => {
    withLaidOutViewport();
    const feed = renderFeed(openSessionStoreWithFilterableLog());

    expect(seatRowCount(feed)).toBeGreaterThan(0);
    for (const chip of feed.querySelectorAll<HTMLElement>(FACET)) {
      expect(chip.getAttribute("aria-pressed")).toBe("false");
    }
    expect(feed.querySelector(".meridian-ledger-filter__clear")).toBeNull();
  });
});

describe("the ledger's narrowing runs BEFORE the chapter fold", () => {
  /** The one chapter header this fixture draws. Refuses rather than answering null. */
  function chapterHeader(feed: HTMLElement): HTMLElement {
    const header = feed.querySelector<HTMLElement>(CHAPTER_HEADER);
    if (header === null) {
      throw new Error("the feed drew no chapter header");
    }
    return header;
  }

  it("offers a folded chapter's own event family, counted over every member row", () => {
    // The chapter is shut, so its message rows are nowhere on screen — and the bar
    // offers the family anyway, because the facets are derived from the unfurled
    // projection rather than from the receipt the fold left.
    withLaidOutViewport();
    const feed = renderFeed(openSessionStoreWithFoldedMessageChapter());

    expect(
      chapterHeader(feed).querySelector(CHAPTER_DISCLOSURE)?.getAttribute("aria-expanded"),
    ).toBe("false");
    expect(offeredFacets(feed)).toContain(MESSAGE_FAMILY);
    expect(facetChip(feed, MESSAGE_FAMILY).textContent).toContain(
      String(FOLDED_CHAPTER_MESSAGE_ROW_COUNT),
    );
  });

  it("narrows to those rows, and the header re-counts to what the narrowing admitted", () => {
    withLaidOutViewport();
    const mountedRowTypes: string[] = [];
    const feed = renderFeed(openSessionStoreWithFoldedMessageChapter(), (mount) => {
      mountedRowTypes.push(mount.row.type);
    });

    fireEvent.click(facetChip(feed, MESSAGE_FAMILY));

    // The whole run holds five rows; this narrowing admits three of them, and the
    // header reports the admitted count rather than the run's. A header carrying the
    // whole run's figure over a body that can only hold three would be its own lie.
    expect(chapterHeader(feed).textContent).toContain(String(FOLDED_CHAPTER_MESSAGE_ROW_COUNT));
    // Shut, the chapter is one list row — its header — because the narrowing took
    // the receipt the fold would otherwise have kept beside it.
    expect(seatRowCount(feed)).toBe(1);

    mountedRowTypes.length = 0;
    fireEvent.click(chapterHeader(feed).querySelector(CHAPTER_DISCLOSURE) as Element);

    // Opening reveals exactly the admitted rows under that header — the run's
    // lifecycle rows stay out, which is the narrowing still holding inside the
    // chapter it opened. Read off what the seat was handed rather than off the
    // markup, because the header renders the terminal's own name whether or not the
    // receipt row is in the body.
    expect(seatRowCount(feed)).toBe(1 + FOLDED_CHAPTER_MESSAGE_ROW_COUNT);
    expect(new Set(mountedRowTypes)).toStrictEqual(new Set(["assistant.message"]));
  });

  it("drops the header of a chapter this narrowing empties", () => {
    // The live run's tool call is the only row in this family, so the finished
    // chapter admits nothing — and a header over no rows would draw a finished run
    // this narrowing has nothing of.
    withLaidOutViewport();
    const feed = renderFeed(openSessionStoreWithFoldedMessageChapter());

    fireEvent.click(facetChip(feed, TOOL_FAMILY));

    expect(feed.querySelectorAll(CHAPTER_HEADER)).toHaveLength(0);
    expect(seatRowCount(feed)).toBe(1);
  });

  it("negative control: folding first offers no such family at all", () => {
    // The old order, driven directly. The fold collapses the finished run to its
    // receipt before the facets are derived, so the family every one of its message
    // rows carries is absent from the bar and there is no chip to press.
    const projection = deriveLedgerWindow(foldedMessageChapterLog(), false);
    const foldedFirst = foldChapterHeaders(projection, new Set<string>());

    const foldedFamilies = deriveLedgerFacets(foldedFirst.rows).categories.map(
      (facet) => facet.value,
    );
    expect(foldedFamilies).not.toContain(MESSAGE_FAMILY);

    const unfurledFamilies = deriveLedgerFacets(projection.rows).categories;
    expect(unfurledFamilies.map((facet) => facet.value)).toContain(MESSAGE_FAMILY);
    expect(unfurledFamilies.find((facet) => facet.value === MESSAGE_FAMILY)?.rowCount).toBe(
      FOLDED_CHAPTER_MESSAGE_ROW_COUNT,
    );
  });
});

describe("the ledger's clear command — real, and refusing only what it must", () => {
  it("restores the whole window from the keyboard", () => {
    withLaidOutViewport();
    const feed = renderFeed(openSessionStoreWithFilterableLog());
    const unfilteredRowCount = seatRowCount(feed);
    contributeLedgerCommands();

    fireEvent.click(facetChip(feed, EARLY_JOINER));
    expect(seatRowCount(feed)).toBeLessThan(unfilteredRowCount);

    dispatchConsoleCommand("ledger.clearFilters");

    expect(seatRowCount(feed)).toBe(unfilteredRowCount);
    expect(feed.querySelector(".meridian-ledger-filter__clear")).toBeNull();
  });

  it("the bar's own clear control widens back too", () => {
    withLaidOutViewport();
    const feed = renderFeed(openSessionStoreWithFilterableLog());
    const unfilteredRowCount = seatRowCount(feed);

    fireEvent.click(facetChip(feed, EARLY_JOINER));
    const clear = feed.querySelector<HTMLElement>(".meridian-ledger-filter__clear");
    if (clear === null) {
      throw new Error("a narrowed ledger drew no clear control");
    }
    fireEvent.click(clear);

    expect(seatRowCount(feed)).toBe(unfilteredRowCount);
  });
});

describe("the ledger's jump by event id — reached through the field somebody has open", () => {
  /** Open the find field the way the palette does, and type into it. */
  function typeIntoFind(feed: HTMLElement, query: string): void {
    contributeLedgerCommands();
    dispatchConsoleCommand("ledger.find");
    const input = feed.querySelector<HTMLInputElement>(".meridian-find__input");
    if (input === null) {
      throw new Error("the find command opened no field");
    }
    fireEvent.change(input, { target: { value: query } });
  }

  it("offers a jump when the query names a row this window is showing", () => {
    withLaidOutViewport();
    const feed = renderFeed(openSessionStoreWithFilterableLog());

    typeIntoFind(feed, filterableRowId(0));

    expect(feed.querySelector(".meridian-ledger__jump-action")).not.toBeNull();
  });

  it("says a row is hidden by the filter rather than telling anyone to load it again", () => {
    // The arm that could not be reached before this ledger could be narrowed at
    // all: an id nobody holds and an id the filter is hiding call for different
    // words, and the second one is fixed by clearing the filter.
    withLaidOutViewport();
    const feed = renderFeed(openSessionStoreWithFilterableLog());

    fireEvent.click(facetChip(feed, LATE_JOINER));
    typeIntoFind(feed, filterableRowId(0));

    expect(feed.querySelector(".meridian-ledger__jump-action")).toBeNull();
    expect(feed.textContent).toContain("hidden by the filter");
  });

  it("negative control: an ordinary text query offers no jump at all", () => {
    withLaidOutViewport();
    const feed = renderFeed(openSessionStoreWithFilterableLog());

    typeIntoFind(feed, "run");

    expect(feed.querySelector(".meridian-ledger__jump-action")).toBeNull();
    expect(feed.textContent).not.toContain("hidden by the filter");
  });
});
