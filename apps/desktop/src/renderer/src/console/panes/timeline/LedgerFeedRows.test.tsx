// What a ROW is, in the mounted feed: a chapter header, a seam line, or the seat.
//
// The feed's other subjects are their own files (`LedgerFeed.test.tsx` for the rail
// seam, `LedgerFeedAbsences.test.tsx`, `LedgerFeedReplay.test.tsx`,
// `LedgerFeedSeats.test.tsx`), and this one holds the three dispatches the row
// renderer performs and the one piece of state it keeps for a row body. Every case
// drives the composed feed, because each defect it pins was a correct model that
// reached no component: the chapter fold, the seam metadata, and the window's lease
// table were all derived on every pass and drawn by nothing.

import { fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LEDGER_WINDOW_ROW_CAP } from "../../ledger/frame/frame-bounds.js";
import { type TimelineRowSlotProps } from "../../seats/index.js";
import {
  LeasingRowBody,
  contributeLedgerCommands,
  dispatchConsoleCommand,
  renderFeed,
  withLaidOutViewport,
  withdrawLedgerCommands,
} from "./ledger-feed-fixtures.js";
import {
  openSessionStoreWithSeam,
  openSessionStoreWithTerminalChapter,
  openSessionStoreWithToolRows,
} from "./ledger-feed-logs.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const CHAPTER_HEADER = ".meridian-chapter-header";
const CHAPTER_DISCLOSURE = ".meridian-chapter-header__disclosure";
const SEAT_ROW = ".meridian-ledger-viewport__row";

/** A row seat mount with no ledger around it — the refusal case's input. */
function outsideLedgerSlotProps(): TimelineRowSlotProps {
  return {
    row: {
      id: "row-with-no-ledger",
      sessionId: "session-ledger-feed" as TimelineRowSlotProps["row"]["sessionId"],
      sequence: 0,
      category: "session_lifecycle",
      kind: "general",
      type: "session.created",
      summary: "The session was created.",
      timestamp: "2026-01-01T11:00:00.000Z",
      payload: {},
    },
    participantHue: undefined,
    isSuperseded: false,
    density: "expanded",
  };
}

/** The chapter header the feed drew, refusing rather than answering null. */
function headerByPosition(feed: HTMLElement): HTMLElement {
  const header = feed.querySelector<HTMLElement>(CHAPTER_HEADER);
  if (header === null) {
    throw new Error("the feed drew no chapter header");
  }
  return header;
}

describe("the ledger feed — a finished run folds to a header and its receipt", () => {
  it("draws one header for the terminal chapter and none for the live one", () => {
    withLaidOutViewport();
    const feed = renderFeed(openSessionStoreWithTerminalChapter());
    expect(feed.querySelectorAll(CHAPTER_HEADER)).toHaveLength(1);
    // The header carries the terminal the daemon named, verbatim, and how much the
    // chapter holds — which is the whole of what a fold may say about hidden rows.
    const header = headerByPosition(feed);
    expect(header.textContent).toContain("run.completed");
    expect(header.textContent).toContain("4");
  });

  it("hides the folded chapter's member rows and keeps its receipt", () => {
    withLaidOutViewport();
    const feed = renderFeed(openSessionStoreWithTerminalChapter());
    const drawn = feed.textContent ?? "";
    // The terminal row survives the fold: "header and receipt" is what folded means.
    expect(drawn).toContain("run.completed");
    // And the rows above it do not. `run.paused` is the discriminator because it is
    // a seam AND a member of the folded chapter, so a fold that only hid the seat's
    // rows would still leak it.
    expect(drawn).not.toContain("run.paused");
    // The live chapter is untouched: every row of it is still mounted.
    expect(feed.querySelectorAll(SEAT_ROW).length).toBeGreaterThan(0);
  });

  it("opens the fold when the header's disclosure is pressed", () => {
    withLaidOutViewport();
    const feed = renderFeed(openSessionStoreWithTerminalChapter());
    expect(feed.querySelector(CHAPTER_DISCLOSURE)?.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(feed.querySelector(CHAPTER_DISCLOSURE) as Element);
    expect(feed.querySelector(CHAPTER_DISCLOSURE)?.getAttribute("aria-expanded")).toBe("true");
    expect(feed.textContent).toContain("run.paused");
  });

  it("negative control: a session with no terminal run draws no header at all", () => {
    // Without this every case above would pass over a feed that headed every run,
    // which would fold the chapter somebody is watching being written.
    withLaidOutViewport();
    const feed = renderFeed(openSessionStoreWithSeam());
    expect(feed.querySelectorAll(CHAPTER_HEADER)).toHaveLength(0);
    expect(feed.querySelectorAll(SEAT_ROW).length).toBeGreaterThan(0);
  });

  it("folds an opened chapter back when the palette's collapse row is run", () => {
    withLaidOutViewport();
    contributeLedgerCommands();
    try {
      const feed = renderFeed(openSessionStoreWithTerminalChapter());
      fireEvent.click(feed.querySelector(CHAPTER_DISCLOSURE) as Element);
      expect(feed.textContent).toContain("run.paused");

      dispatchConsoleCommand("ledger.collapseTerminalChapters");
      // The act used to raise a typed refusal saying every finished chapter was
      // already folded and no control opened one. Both halves are false now.
      expect(feed.querySelector(CHAPTER_DISCLOSURE)?.getAttribute("aria-expanded")).toBe("false");
      expect(feed.textContent).not.toContain("run.paused");
    } finally {
      withdrawLedgerCommands();
    }
  });

  it("counts a folded chapter as one row against the window cap", () => {
    // The cap's own unit test pins the counting rule; this pins that the feed feeds
    // it the shape that rule is written for. A run-only log — every row naming its
    // run and no row being it — counted every row, so a long single-run session was
    // over cap before it had many chapters at all.
    withLaidOutViewport();
    const feed = renderFeed(openSessionStoreWithTerminalChapter());
    expect(feed.textContent).not.toContain("Older entries are no longer in this window.");
    expect(LEDGER_WINDOW_ROW_CAP).toBeGreaterThan(1);
    expect(headerByPosition(feed)).not.toBeNull();
  });
});

describe("the ledger feed — a seam is the ledger's own row", () => {
  it("draws a compaction as a seam line rather than delegating it to the seat", () => {
    withLaidOutViewport();
    const seatRowSummaries: string[] = [];
    const feed = renderFeed(openSessionStoreWithSeam(), (mount) => {
      seatRowSummaries.push(mount.row.type);
    });
    const seamLine = feed.querySelector(".meridian-seam-row");
    expect(seamLine).not.toBeNull();
    expect(seamLine?.textContent).toContain("Context compacted");
    // The boundary is the row's own run-scoped position, which the projection
    // resolved — the payload member the old read reached for is registered nowhere.
    expect(seamLine?.textContent).toContain("Boundary");
    // And the seat never saw it, which is the dispatch this case is about.
    expect(seatRowSummaries).not.toContain("usage.context_compacted");
  });

  it("negative control: an ordinary row still reaches the seat renderer unchanged", () => {
    // Without this the case above would pass over a feed that had stopped delegating
    // anything, which would replace every row body in the ledger with a seam line.
    withLaidOutViewport();
    const seatRowTypes: string[] = [];
    const feed = renderFeed(openSessionStoreWithSeam(), (mount) => {
      seatRowTypes.push(mount.row.type);
    });
    expect(seatRowTypes).toContain("assistant.message");
    expect(feed.querySelectorAll(SEAT_ROW).length).toBeGreaterThan(0);
  });
});

describe("the ledger feed — a row's disclosure leaves the row", () => {
  it("takes a press into the list's lease and hands the answer back", () => {
    // The round trip that used to happen inside the row body's own `useState`. The
    // virtualizer mounts the visible range and nothing else, so a choice kept there
    // was thrown away the moment a reader scrolled past — and came back as whatever
    // the list said. Now the write goes to the window's lease table, which the feed
    // overlays on the list's density, and which a prune re-parks rather than drops.
    withLaidOutViewport();
    const feed = renderFeed(openSessionStoreWithToolRows(3), undefined, LeasingRowBody);
    const rows = [...feed.querySelectorAll<HTMLElement>(".leasing-row")];
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.every((row) => row.dataset["density"] === "expanded")).toBe(true);

    fireEvent.click(rows[0] as Element);
    const densitiesAfter = [...feed.querySelectorAll<HTMLElement>(".leasing-row")].map(
      (row) => row.dataset["density"],
    );
    // Exactly one row changed, and it changed because the LIST answered differently
    // — the row body holds nothing of its own to have answered with.
    expect(densitiesAfter.filter((density) => density === "collapsed")).toHaveLength(1);
  });

  it("negative control: a row nobody touched still shows the list's density", () => {
    // Without this the case above would pass over an overlay that collapsed every
    // row once any lease existed, which would fold the whole ledger on one press.
    withLaidOutViewport();
    const densities = new Set<string>();
    renderFeed(openSessionStoreWithToolRows(3), (mount) => {
      densities.add(mount.density);
    });
    expect([...densities]).toStrictEqual(["expanded"]);
  });

  it("refuses a row body mounted outside a ledger rather than swallowing its press", () => {
    // The lease channel has no no-op default: a swallowed write looks exactly like a
    // row that will not open, which is the defect the whole change closes.
    expect(() => render(<LeasingRowBody {...outsideLedgerSlotProps()} />)).toThrow(
      /lease provider/,
    );
  });
});
