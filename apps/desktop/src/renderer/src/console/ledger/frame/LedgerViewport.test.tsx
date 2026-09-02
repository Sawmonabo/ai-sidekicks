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

import { act, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ManualClock, refuse, type ConsoleClock } from "../../core/index.js";
import { LedgerViewport } from "./LedgerViewport.js";
import { useLedgerViewport, type LedgerViewportBinding } from "./viewport-binding.js";
import type { LedgerViewportRow } from "./viewport-controller.js";

const LONG_LOG_ROW_COUNT = 500;
const LAID_OUT_VIEWPORT_HEIGHT_PX = 400;
const LAID_OUT_CONTENT_HEIGHT_PX = 10_000;

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

/**
 * Give the box content taller than itself, for the length of one case.
 *
 * Separate from the layout stub above because the chokepoint clamps every write to
 * `scrollHeight - clientHeight`: without this a scroll assertion passes over a
 * ledger that could not have moved, and with it every case would pay for a
 * geometry only the two scroll cases read.
 */
function withScrollableContent(): void {
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(
    LAID_OUT_CONTENT_HEIGHT_PX,
  );
}

/** Somewhere for a case to keep the binding the harness minted. */
interface BindingHolder {
  binding: LedgerViewportBinding | undefined;
}

interface BoundLedgerViewportProps {
  readonly clock: ConsoleClock;
  readonly rows: readonly LedgerViewportRow[];
  readonly renderRow: (row: LedgerViewportRow) => React.ReactNode;
  readonly feedLabel: string;
  readonly hasActiveTurn?: boolean;
  readonly errorEntries?: React.ComponentProps<typeof LedgerViewport>["errorEntries"];
  /** Filled on every commit, so a case can act on the binding the viewport got. */
  readonly holder?: BindingHolder;
}

/**
 * The composition every caller of the viewport performs: mint one binding, hand it
 * down.
 *
 * The harness exists because the viewport no longer mints its own — which is the
 * property under test — so a case that rendered it bare would be asserting against
 * a component that cannot be rendered at all.
 */
function BoundLedgerViewport(props: BoundLedgerViewportProps): React.JSX.Element {
  const binding = useLedgerViewport({
    clock: props.clock,
    rows: props.rows,
    hasActiveTurn: props.hasActiveTurn ?? false,
    isRevealDraining: false,
  });
  const { holder } = props;
  useEffect(() => {
    if (holder !== undefined) {
      holder.binding = binding;
    }
  });
  return (
    <LedgerViewport
      binding={binding}
      renderRow={props.renderRow}
      feedLabel={props.feedLabel}
      {...(props.hasActiveTurn === undefined ? {} : { hasActiveTurn: props.hasActiveTurn })}
      {...(props.errorEntries === undefined ? {} : { errorEntries: props.errorEntries })}
    />
  );
}

interface DetachedBindingProps {
  readonly clock: ConsoleClock;
  readonly rows: readonly LedgerViewportRow[];
  readonly holder: BindingHolder;
}

/**
 * A viewport, and beside it a binding nobody handed to it.
 *
 * This is the shape the ledger used to have: one binding held by the surrounding
 * surface for the rail and the find walk, and a second one — the viewport's own —
 * holding the element. The case below acts on the held one and watches the element
 * not move.
 */
function DetachedBindingBeside(props: DetachedBindingProps): React.JSX.Element {
  const detachedBinding = useLedgerViewport({
    clock: props.clock,
    rows: props.rows,
    hasActiveTurn: false,
    isRevealDraining: false,
  });
  const { holder } = props;
  useEffect(() => {
    holder.binding = detachedBinding;
  });
  return (
    <BoundLedgerViewport
      clock={props.clock}
      rows={props.rows}
      renderRow={renderRow}
      feedLabel="Session timeline"
    />
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
      <BoundLedgerViewport
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
      <BoundLedgerViewport
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
      <BoundLedgerViewport
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
      <BoundLedgerViewport
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
      <BoundLedgerViewport
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
      <BoundLedgerViewport
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
  it("scrolls the surface through the binding its caller owns", () => {
    withLaidOutViewport();
    withScrollableContent();
    const holder: BindingHolder = { binding: undefined };
    const { container } = render(
      <BoundLedgerViewport
        clock={new ManualClock()}
        rows={syntheticRows(LONG_LOG_ROW_COUNT)}
        renderRow={renderRow}
        feedLabel="Session timeline"
        holder={holder}
      />,
    );
    const surface = container.querySelector<HTMLElement>(".meridian-ledger-viewport__surface");
    expect(surface).not.toBeNull();
    expect(surface?.scrollTop).toBe(0);
    act(() => {
      holder.binding?.jumpToTail();
    });
    // The caller's binding reaches the element the caller can see. Before the
    // viewport took its binding as a prop, this was the binding the surrounding
    // surface held and the element belonged to a second one nobody else could name.
    expect(surface?.scrollTop).toBeGreaterThan(0);
  });

  it("negative control: a binding the viewport was not handed scrolls nothing", () => {
    // The assertion above is only worth having if an unattached binding is visibly
    // inert — which is exactly what a second `useLedgerViewport` beside the tree is.
    withLaidOutViewport();
    withScrollableContent();
    const detachedHolder: BindingHolder = { binding: undefined };
    const { container } = render(
      <DetachedBindingBeside
        clock={new ManualClock()}
        rows={syntheticRows(LONG_LOG_ROW_COUNT)}
        holder={detachedHolder}
      />,
    );
    const surface = container.querySelector<HTMLElement>(".meridian-ledger-viewport__surface");
    expect(surface).not.toBeNull();
    act(() => {
      detachedHolder.binding?.jumpToTail();
    });
    expect(surface?.scrollTop).toBe(0);
  });
});
