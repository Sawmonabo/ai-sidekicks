// What the React binding asks the controller for, beyond the reconcile.
//
// The controller's own cases drive it directly — `viewport-controller.test.ts` owns
// the prune, the reading floor, and the refusals. What only THIS file can say is
// that a mounted ledger ever re-asks: the reconcile effect keys on the row set and
// the two activity flags, so a window the cap refused while somebody was reading
// above the tail is re-asked only if something in the tree calls for it. Without the
// second effect every case here passes the first half and fails the second, which is
// the shape the defect had — a window over its cap for as long as the session stayed
// quiet.
//
// The layout engine is stubbed the way `LedgerViewport.test.tsx` stubs it and for
// the same reason: `happy-dom` reports zero for `clientHeight` and `scrollHeight`,
// and a viewport with no box is at its tail by construction, so the reading state
// this file drives would never leave `following`. Every module in the assertion path
// — the binding, the controller, the chokepoint, the window cap, and the real
// virtualizer — is the shipped one.

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ManualClock } from "../../core/index.js";
import { LEDGER_WINDOW_ROW_CAP } from "./frame-bounds.js";
import { useLedgerViewport, type LedgerViewportBinding } from "./viewport-binding.js";
import type { LedgerViewportRow } from "./viewport-snapshot.js";

const VIEWPORT_HEIGHT_PX = 400;
const CONTENT_HEIGHT_PX = 10_000;
const TAIL_OFFSET_PX = CONTENT_HEIGHT_PX - VIEWPORT_HEIGHT_PX;
const SETTLED_ROW_COUNT = 20;
const OVER_CAP_ROW_COUNT = LEDGER_WINDOW_ROW_CAP + 40;

function syntheticRows(count: number): readonly LedgerViewportRow[] {
  return Array.from({ length: count }, (_unused, index) => ({
    key: `row-${String(index)}`,
    parentKey: undefined,
    rootCursor: `cursor-${String(index)}`,
  }));
}

/** A box taller than nothing, so the reader can be somewhere other than the tail. */
function withLaidOutViewport(): void {
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(VIEWPORT_HEIGHT_PX);
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(CONTENT_HEIGHT_PX);
}

/** A mounted binding over a surface a case can scroll. */
function mountBinding(rows: readonly LedgerViewportRow[]): {
  binding: ReturnType<typeof renderHook<LedgerViewportBinding, readonly LedgerViewportRow[]>>;
  surface: HTMLElement;
} {
  const clock = new ManualClock();
  const binding = renderHook(
    (currentRows: readonly LedgerViewportRow[]) =>
      useLedgerViewport({
        clock,
        rows: currentRows,
        hasActiveTurn: false,
        isRevealDraining: false,
      }),
    { initialProps: rows },
  );
  const surface = document.createElement("div");
  act(() => {
    binding.result.current.attachSurface(surface);
  });
  return { binding, surface };
}

/** Move the reader, the way a finger does: the offset, then the event. */
function scrollTo(surface: HTMLElement, offsetPx: number): void {
  act(() => {
    surface.scrollTop = offsetPx;
    surface.dispatchEvent(new Event("scroll"));
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the ledger viewport binding — a prune the window refused", () => {
  it("is re-asked when the reader returns to the tail, with no new rows", () => {
    withLaidOutViewport();
    const { binding, surface } = mountBinding(syntheticRows(SETTLED_ROW_COUNT));
    // Above the tail first, so the log that arrives next meets a reading floor.
    scrollTo(surface, 0);
    expect(binding.result.current.snapshot.reading.mode).toBe("reading");

    act(() => {
      binding.rerender(syntheticRows(OVER_CAP_ROW_COUNT));
    });
    expect(binding.result.current.snapshot.lastPrune?.deferredBecause).toBe("reading-floor");
    expect(binding.result.current.snapshot.rows).toHaveLength(OVER_CAP_ROW_COUNT);

    // THE RETURN, and nothing else. No row arrives, no turn starts, no reveal drains
    // — so the reconcile effect's own dependencies are all untouched.
    scrollTo(surface, TAIL_OFFSET_PX);

    expect(binding.result.current.snapshot.reading.mode).toBe("following");
    expect(binding.result.current.snapshot.rows).toHaveLength(LEDGER_WINDOW_ROW_CAP);
  });

  it("negative control: a re-render that changes nothing leaves the reader's window whole", () => {
    // Without this the second effect could be re-asking on every render, which would
    // take rows out from under somebody who is still reading them.
    withLaidOutViewport();
    const { binding, surface } = mountBinding(syntheticRows(SETTLED_ROW_COUNT));
    scrollTo(surface, 0);
    const overCapRows = syntheticRows(OVER_CAP_ROW_COUNT);
    act(() => {
      binding.rerender(overCapRows);
    });

    act(() => {
      binding.rerender(overCapRows);
    });

    expect(binding.result.current.snapshot.reading.mode).not.toBe("following");
    expect(binding.result.current.snapshot.lastPrune?.deferredBecause).toBe("reading-floor");
    expect(binding.result.current.snapshot.rows).toHaveLength(OVER_CAP_ROW_COUNT);
  });
});
