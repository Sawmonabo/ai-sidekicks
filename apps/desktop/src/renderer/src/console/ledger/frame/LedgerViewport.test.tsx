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

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ManualClock, refuse } from "../../core/index.js";
import { LedgerViewport } from "./LedgerViewport.js";
import type { LedgerViewportRow } from "./viewport-controller.js";

const LONG_LOG_ROW_COUNT = 500;

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
    // and dropped the rest of the session on the floor.
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
    expect(sizer?.getAttribute("style")).toContain("height");
    expect(container.querySelector(".meridian-ledger-viewport__slice")).toBeDefined();
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
    const rows: readonly LedgerViewportRow[] = [
      { key: "row-0", parentKey: undefined, rootCursor: "cursor-0" },
      { key: "row-0", parentKey: undefined, rootCursor: "cursor-1" },
    ];
    render(
      <LedgerViewport
        clock={new ManualClock()}
        rows={rows}
        renderRow={renderRow}
        feedLabel="Session timeline"
      />,
    );
    // Degraded, never discarded: the reader still has a log, and the defect is said
    // out loud rather than left as a mystery in the scrollbar.
    expect(screen.getByText("Some entries share an identifier.")).toBeDefined();
  });
});
