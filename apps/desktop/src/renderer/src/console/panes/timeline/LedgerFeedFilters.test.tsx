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

import {
  EARLY_JOINER,
  LATE_JOINER,
  contributeLedgerCommands,
  dispatchConsoleCommand,
  filterableRowId,
  openSessionStoreWithFilterableLog,
  renderFeed,
  withLaidOutViewport,
  withdrawLedgerCommands,
} from "./ledger-feed-fixtures.js";

afterEach(() => {
  withdrawLedgerCommands();
  vi.restoreAllMocks();
});

const FACET = ".meridian-ledger-filter__facet";
const SEAT_ROW = ".meridian-ledger-viewport__row";

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
