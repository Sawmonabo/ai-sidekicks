// What a row is in the mounted feed: a run group header, a system message, or the row renderer's.
// Every case drives the composed feed, because each pinned model (run group fold, seam metadata,
// lease table) is derived on every pass and has to reach a component.

import { fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LeasingRowBody, renderFeed, withLaidOutViewport } from "./TranscriptFeed.test-support.js";
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
    // The header carries the daemon's terminal verbatim and how much the run group holds, the
    // whole of what a fold may say about hidden rows.
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
    // `run.paused` discriminates: it is a seam and a member of the folded run group, so a fold
    // that only hid the renderer's rows would leak it.
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
});

describe("the transcript feed — a seam is the transcript's own row", () => {
  it("draws a compaction as a system message rather than delegating it to the row renderer", () => {
    withLaidOutViewport();
    const rendererRowTypes: string[] = [];
    const feed = renderFeed(openSessionStoreWithSystemMessage(), (mount) => {
      rendererRowTypes.push(mount.row.type);
    });
    const seamLine = feed.querySelector(".meridian-system-message");
    expect(seamLine).not.toBeNull();
    expect(seamLine?.textContent).toContain("Context compacted");
    // The boundary is the row's run-scoped position, resolved by the projection.
    expect(seamLine?.textContent).toContain("Boundary");
    expect(rendererRowTypes).not.toContain("usage.context_compacted");
  });
});

describe("the transcript feed — a row's disclosure leaves the row", () => {
  it("takes a press into the list's lease and hands the answer back", () => {
    // The virtualizer mounts only the visible range, so a choice kept in the row body would be
    // lost on scroll. The write goes to the window's lease table, which the feed overlays on the
    // list's density and a prune re-parks rather than drops.
    withLaidOutViewport();
    const feed = renderFeed(openSessionStoreWithToolRows(3), undefined, LeasingRowBody);
    const rows = [...feed.querySelectorAll<HTMLElement>(".leasing-row")];
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.every((row) => row.dataset["density"] === "expanded")).toBe(true);

    fireEvent.click(rows[0] as Element);
    const densitiesAfter = [...feed.querySelectorAll<HTMLElement>(".leasing-row")].map(
      (row) => row.dataset["density"],
    );
    // Exactly one row changed, because the list answered differently; the row body holds nothing.
    expect(densitiesAfter.filter((density) => density === "collapsed")).toHaveLength(1);
  });

  it("a row nobody touched still shows the list's density", () => {
    // Without this the case above would pass over an overlay that collapsed every row once any
    // lease existed.
    withLaidOutViewport();
    const densities = new Set<string>();
    renderFeed(openSessionStoreWithToolRows(3), (mount) => {
      densities.add(mount.density);
    });
    expect([...densities]).toStrictEqual(["expanded"]);
  });
});
