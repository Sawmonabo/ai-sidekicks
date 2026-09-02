// What the viewport draws, and what it refuses to mount.
//
// WHAT IS ASSERTED HERE AND WHAT IS NOT. `happy-dom` answers zero for every
// geometry read, which `vitest.config.ts` already says out loud about the browser
// tier: "a reading-anchor or scroll-monotonicity assertion under it would pass
// vacuously". So the geometry-dependent states — the tail pill's appearance, the
// anchor holding a position across an append — are asserted where they can be
// driven honestly, in `reading-anchor.test.ts` and `viewport-controller.test.ts`,
// and this file asserts what a DOM shim can answer truthfully: that the feed is
// named, that only a slice of the log is in the document, that the two degradations
// are reported, and that a settled viewport has no timer armed.
//
// The one thing the shim is asked to stand in for is the LAYOUT ENGINE, not a module
// under test: a viewport of zero height makes the virtualizer's own range empty by
// construction, so `withLaidOutViewport` gives the scroll container a height. Every
// module in the assertion path — the viewport, the controller, the chokepoint, the
// measurement ledger, and the real `@tanstack/react-virtual` instance — is the
// shipped one.

import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ManualClock, refuse } from "../../core/index.js";
import { LedgerViewport } from "./LedgerViewport.js";
import type { LedgerViewportRow } from "./viewport-controller.js";

const LONG_LOG_ROW_COUNT = 500;
const LAID_OUT_VIEWPORT_HEIGHT_PX = 400;

/**
 * Give every element a viewport height, for the length of one case.
 *
 * `happy-dom` reports zero for `clientHeight`, and the virtualizer treats a zero
 * outer size as "no range at all" — so without this the window would be empty for a
 * reason that has nothing to do with the code under test.
 */
function withLaidOutViewport(): void {
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(
    LAID_OUT_VIEWPORT_HEIGHT_PX,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

function syntheticRows(count: number): readonly LedgerViewportRow[] {
  return Array.from({ length: count }, (_unused, index) => ({
    key: `row-${String(index)}`,
    parentKey: undefined,
    rootCursor: `cursor-${String(index)}`,
  }));
}

function renderRow(row: LedgerViewportRow): React.ReactNode {
  return <p>{row.key}</p>;
}

describe("the ledger viewport — the feed", () => {
  it("names the feed, and mounts far fewer rows than the log holds", () => {
    withLaidOutViewport();
    const { container } = render(
      <LedgerViewport
        clock={new ManualClock()}
        rows={syntheticRows(LONG_LOG_ROW_COUNT)}
        renderRow={renderRow}
        feedLabel="Session timeline"
      />,
    );
    expect(screen.getByRole("feed", { name: "Session timeline" })).toBeDefined();
    const mounted = container.querySelectorAll(".meridian-ledger-viewport__row");
    expect(mounted.length).toBeGreaterThan(0);
    expect(mounted.length).toBeLessThan(LONG_LOG_ROW_COUNT / 4);
  });

  it("negative control: every row IS reachable — the log itself is not truncated", () => {
    // Without this the case above would pass over a viewport that rendered one row
    // and dropped the rest of the session on the floor. The sizer carries the whole
    // log's height, and every mounted row names the index it stands for, so the rows
    // that are not in the document are addressable rather than gone.
    withLaidOutViewport();
    const rows = syntheticRows(LONG_LOG_ROW_COUNT);
    const { container } = render(
      <LedgerViewport
        clock={new ManualClock()}
        rows={rows}
        renderRow={renderRow}
        feedLabel="Session timeline"
      />,
    );
    const sizer = container.querySelector(".meridian-ledger-viewport__sizer");
    expect(sizer).not.toBeNull();
    expect(sizer?.getAttribute("style")).toContain("height");
    const mountedIndexes = [...container.querySelectorAll(".meridian-ledger-viewport__row")].map(
      (element) => Number(element.getAttribute("data-index")),
    );
    expect(mountedIndexes[0]).toBe(0);
    expect(mountedIndexes.at(-1)).toBeLessThan(LONG_LOG_ROW_COUNT - 1);
  });

  it("teaches rather than blames when the session has done nothing yet", () => {
    render(
      <LedgerViewport
        clock={new ManualClock()}
        rows={[]}
        renderRow={renderRow}
        feedLabel="Session timeline"
      />,
    );
    expect(screen.getByText("Nothing has happened in this session yet.")).toBeDefined();
  });

  it("arms no timer once the first paint has settled", () => {
    withLaidOutViewport();
    const clock = new ManualClock();
    render(
      <LedgerViewport
        clock={clock}
        rows={syntheticRows(20)}
        renderRow={renderRow}
        feedLabel="Session timeline"
      />,
    );
    // Row measurements coalesce onto one frame; past that a viewport nobody is
    // streaming into holds nothing armed at all.
    for (let pass = 0; pass < 4; pass += 1) {
      clock.runFrame();
    }
    expect(clock.pendingCount).toBe(0);
  });

  it("renders the ranked error slot above the feed", () => {
    withLaidOutViewport();
    render(
      <LedgerViewport
        clock={new ManualClock()}
        rows={syntheticRows(4)}
        renderRow={renderRow}
        feedLabel="Session timeline"
        errorEntries={[
          {
            kind: "row-projection",
            refusal: refuse("ledger", "renderer.row_projection_failed", "A row was unreadable."),
          },
        ]}
      />,
    );
    expect(screen.getByText("renderer.row_projection_failed")).toBeDefined();
  });

  it("reports a projection that repeated a key rather than dropping the window", () => {
    withLaidOutViewport();
    const rows: readonly LedgerViewportRow[] = [
      { key: "row-0", parentKey: undefined, rootCursor: "cursor-0" },
      { key: "row-0", parentKey: undefined, rootCursor: "cursor-1" },
    ];
    const { container } = render(
      <LedgerViewport
        clock={new ManualClock()}
        rows={rows}
        renderRow={renderRow}
        feedLabel="Session timeline"
      />,
    );
    // Degraded, never discarded: BOTH rows are in the document under keys of their
    // own, and the defect is said out loud rather than left as a mystery in the
    // scrollbar. Sharing the key would have left one row where the projection sent
    // two, because the library's caches are keyed by item key.
    expect(screen.getByText("Some entries share an identifier.")).toBeDefined();
    expect(container.querySelectorAll(".meridian-ledger-viewport__row")).toHaveLength(2);
  });
});
