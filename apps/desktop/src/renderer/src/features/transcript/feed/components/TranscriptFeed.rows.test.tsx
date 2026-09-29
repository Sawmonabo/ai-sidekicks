// What a ROW is, in the mounted feed: a run group header, a seam line, or the row renderer's.
//
// The feed's other subjects are the `TranscriptFeed.<subject>.test` files beside this one,
// and this one holds the three dispatches the row renderer performs and the one piece of state it
// keeps for a row body. Every case drives the composed feed, because each thing it
// pins is a correct model that has to reach a component: the run group fold, the seam
// metadata, and the window's lease table are each derived on every pass and must be
// drawn.

import { fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TRANSCRIPT_WINDOW_ROW_CAP } from "../../frame/frame-caps.js";
import { type TranscriptRowProps } from "../../transcript-row-renderer.js";
import {
  LeasingRowBody,
  contributeTranscriptCommands,
  dispatchCommand,
  renderFeed,
  withLaidOutViewport,
  withdrawTranscriptCommands,
} from "./TranscriptFeed.test-support.js";
import { openSessionStoreWithToolRows } from "../../transcript-logs.test-support.js";
import {
  openSessionStoreWithSystemMessage,
  openSessionStoreWithTerminalRunGroup,
} from "../../run-group-logs.test-support.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const RUN_GROUP_HEADER = ".meridian-run-group-header";
const RUN_GROUP_DISCLOSURE = ".meridian-run-group-header__disclosure";
const VIEWPORT_ROW = ".meridian-transcript-viewport__row";

/** A row renderer's props with no transcript around them — the refusal case's input. */
function outsideTranscriptRowProps(): TranscriptRowProps {
  return {
    row: {
      id: "row-with-no-transcript",
      sessionId: "session-transcript-feed" as TranscriptRowProps["row"]["sessionId"],
      sequence: 0,
      category: "session_lifecycle",
      kind: "general",
      type: "session.created",
      summary: "The session was created.",
      timestamp: "2026-01-01T11:00:00.000Z",
      payload: {},
    },
    actorHue: undefined,
    isSuperseded: false,
    density: "expanded",
  };
}

/** The run group header the feed drew, refusing rather than answering null. */
function headerByPosition(feed: HTMLElement): HTMLElement {
  const header = feed.querySelector<HTMLElement>(RUN_GROUP_HEADER);
  if (header === null) {
    throw new Error("the feed drew no run group header");
  }
  return header;
}

describe("the transcript feed — a finished run folds to a header and its receipt", () => {
  it("draws one header for the terminal run group and none for the live one", () => {
    withLaidOutViewport();
    const feed = renderFeed(openSessionStoreWithTerminalRunGroup());
    expect(feed.querySelectorAll(RUN_GROUP_HEADER)).toHaveLength(1);
    // The header carries the terminal the daemon named, verbatim, and how much the
    // run group holds — which is the whole of what a fold may say about hidden rows.
    const header = headerByPosition(feed);
    expect(header.textContent).toContain("run.completed");
    expect(header.textContent).toContain("4");
  });

  it("hides the folded run group's member rows and keeps its receipt", () => {
    withLaidOutViewport();
    const feed = renderFeed(openSessionStoreWithTerminalRunGroup());
    const drawn = feed.textContent ?? "";
    // The terminal row survives the fold: "header and receipt" is what folded means.
    expect(drawn).toContain("run.completed");
    // And the rows above it do not. `run.paused` is the discriminator because it is
    // a seam AND a member of the folded run group, so a fold that only hid the renderer's
    // rows would still leak it.
    expect(drawn).not.toContain("run.paused");
    // The live run group is untouched: every row of it is still mounted.
    expect(feed.querySelectorAll(VIEWPORT_ROW).length).toBeGreaterThan(0);
  });

  it("opens the fold when the header's disclosure is pressed", () => {
    withLaidOutViewport();
    const feed = renderFeed(openSessionStoreWithTerminalRunGroup());
    expect(feed.querySelector(RUN_GROUP_DISCLOSURE)?.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(feed.querySelector(RUN_GROUP_DISCLOSURE) as Element);
    expect(feed.querySelector(RUN_GROUP_DISCLOSURE)?.getAttribute("aria-expanded")).toBe("true");
    expect(feed.textContent).toContain("run.paused");
  });

  it("negative control: a session with no terminal run draws no header at all", () => {
    // Without this every case above would pass over a feed that headed every run,
    // which would fold the run group somebody is watching being written.
    withLaidOutViewport();
    const feed = renderFeed(openSessionStoreWithSystemMessage());
    expect(feed.querySelectorAll(RUN_GROUP_HEADER)).toHaveLength(0);
    expect(feed.querySelectorAll(VIEWPORT_ROW).length).toBeGreaterThan(0);
  });

  it("folds an opened run group back when the palette's collapse row is run", () => {
    withLaidOutViewport();
    contributeTranscriptCommands();
    try {
      const feed = renderFeed(openSessionStoreWithTerminalRunGroup());
      fireEvent.click(feed.querySelector(RUN_GROUP_DISCLOSURE) as Element);
      expect(feed.textContent).toContain("run.paused");

      dispatchCommand("transcript.collapseTerminalRunGroups");
      expect(feed.querySelector(RUN_GROUP_DISCLOSURE)?.getAttribute("aria-expanded")).toBe("false");
      expect(feed.textContent).not.toContain("run.paused");
    } finally {
      withdrawTranscriptCommands();
    }
  });

  it("counts a folded run group as one row against the window cap", () => {
    // The cap's own unit test pins the counting rule; this pins that the feed feeds
    // it the shape that rule is written for. In a run-only log — every row naming its
    // run and no row being it — counting every row would put a long single-run session
    // over cap before it had many run groups at all.
    withLaidOutViewport();
    const feed = renderFeed(openSessionStoreWithTerminalRunGroup());
    expect(feed.textContent).not.toContain("Older entries are no longer in this window.");
    expect(TRANSCRIPT_WINDOW_ROW_CAP).toBeGreaterThan(1);
    expect(headerByPosition(feed)).not.toBeNull();
  });
});

describe("the transcript feed — a seam is the transcript's own row", () => {
  it("draws a compaction as a seam line rather than delegating it to the row renderer", () => {
    withLaidOutViewport();
    const rendererRowTypes: string[] = [];
    const feed = renderFeed(openSessionStoreWithSystemMessage(), (mount) => {
      rendererRowTypes.push(mount.row.type);
    });
    const seamLine = feed.querySelector(".meridian-system-message");
    expect(seamLine).not.toBeNull();
    expect(seamLine?.textContent).toContain("Context compacted");
    // The boundary is the row's own run-scoped position, which the projection
    // resolved.
    expect(seamLine?.textContent).toContain("Boundary");
    // And the row renderer never saw it, which is the dispatch this case is about.
    expect(rendererRowTypes).not.toContain("usage.context_compacted");
  });

  it("negative control: an ordinary row still reaches the row renderer unchanged", () => {
    // Without this the case above would pass over a feed that had stopped delegating
    // anything, which would replace every row body in the transcript with a seam line.
    withLaidOutViewport();
    const rendererRowTypes: string[] = [];
    const feed = renderFeed(openSessionStoreWithSystemMessage(), (mount) => {
      rendererRowTypes.push(mount.row.type);
    });
    expect(rendererRowTypes).toContain("assistant.message");
    expect(feed.querySelectorAll(VIEWPORT_ROW).length).toBeGreaterThan(0);
  });
});

describe("the transcript feed — a row's disclosure leaves the row", () => {
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
    // row once any lease existed, which would fold the whole transcript on one press.
    withLaidOutViewport();
    const densities = new Set<string>();
    renderFeed(openSessionStoreWithToolRows(3), (mount) => {
      densities.add(mount.density);
    });
    expect([...densities]).toStrictEqual(["expanded"]);
  });

  it("refuses a row body mounted outside a transcript rather than swallowing its press", () => {
    // The lease channel has no no-op default: a swallowed write looks exactly like a
    // row that will not open, which is the defect the whole change closes.
    expect(() => render(<LeasingRowBody {...outsideTranscriptRowProps()} />)).toThrow(
      /retained row state provider/,
    );
  });
});
