// What a freshly mounted transcript viewport has on screen when its mount settles.
//
// THE PROPERTY, AND WHY IT NEEDS A CASE OF ITS OWN. The virtualizer computes NO range
// at all while its rect reports zero height — measured, `@tanstack/virtual-core`'s
// `calculateRange` returns `null` for `outerSize === 0` — so a viewport that never
// receives a real height mounts no row, renders as an empty log, and stays that way:
// nothing about a window with nothing in it raises a scroll or changes a box, and
// those are the two triggers that would publish another sample. That failure is
// indistinguishable on screen from a session that has no rows, which is exactly why
// the endurance tier now reads the window rather than counting elements.
//
// The rect reaches the library through one path and one only — the geometry
// chokepoint, replayed into `observeElementRect` — so this file drives the binding
// through the shape the real tree uses: the hook in one component, the scroll container's ref
// in a child, and no scroll, resize, or extra frame anywhere. What it asserts is that
// the mount settles with rows, and the control is a box the layout gives no height,
// which settles with none.
//
// `useTranscriptViewport.test.tsx` attaches the scroll container by hand AFTER the mount, which is
// the right shape for what it drives (a prune the window refused, re-asked) and
// cannot answer this: the ordering being checked here is the ref callback against the
// library's own layout effect, and an attach performed from a test body has already
// lost it.

import { render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ManualClock } from "@renderer/lib/clock.js";
import { useTranscriptViewport, type TranscriptViewportBinding } from "./useTranscriptViewport.js";
import type { ViewportRow } from "../viewport-snapshot.js";

const VIEWPORT_HEIGHT_PX = 400;
const CONTENT_HEIGHT_PX = 10_000;
/** Comfortably more rows than a 400 px box can hold, so a window is the only answer. */
const LOG_ROW_COUNT = 200;

function syntheticRows(count: number): readonly ViewportRow[] {
  return Array.from({ length: count }, (_unused, index) => ({
    key: `row-${String(index)}`,
    parentKey: undefined,
    rootCursor: `cursor-${String(index)}`,
  }));
}

/** The row a mounted window draws, reduced to the one fact this file counts. */
const MOUNTED_ROW_SELECTOR = ".transcript-first-commit-row";

function MountedTranscriptViewport(props: {
  readonly binding: TranscriptViewportBinding;
}): React.JSX.Element {
  return (
    <div ref={props.binding.attachScrollContainer}>
      <div ref={props.binding.attachSizer}>
        {props.binding.virtualItems.map((virtualItem) => (
          <div className="transcript-first-commit-row" key={virtualItem.key} />
        ))}
      </div>
    </div>
  );
}

/**
 * The hook's owner, one component ABOVE the scroll container — which is the real arrangement
 * and is the whole point: React attaches a child's ref before it runs an ancestor's
 * layout effects, so the scroll container is bound before the library asks for it. The clock
 * is minted once; a fresh one per render re-mints the controller the hook keys on and
 * the mount never settles.
 */
function TranscriptUnderTest(props: { readonly rows: readonly ViewportRow[] }): React.JSX.Element {
  const [clock] = useState(() => new ManualClock());
  const binding = useTranscriptViewport({
    clock,
    rows: props.rows,
    hasActiveTurn: false,
    isRevealDraining: false,
  });
  return <MountedTranscriptViewport binding={binding} />;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the transcript viewport's first commit", () => {
  it("mounts rows on a box the layout has measured", () => {
    // `happy-dom` answers zero for every box, so the height is the one thing this
    // environment has to be told. Every module between it and the row count — the
    // binding, the controller, the chokepoint, the seams, and the real virtualizer —
    // is the shipped one.
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(VIEWPORT_HEIGHT_PX);
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(CONTENT_HEIGHT_PX);

    const view = render(<TranscriptUnderTest rows={syntheticRows(LOG_ROW_COUNT)} />);

    const mountedRowCount = view.container.querySelectorAll(MOUNTED_ROW_SELECTOR).length;
    expect(
      mountedRowCount,
      "the mount settled with no row on screen, so a session opened on a log this long draws an empty transcript",
    ).toBeGreaterThan(0);
    // AND IT IS STILL A WINDOW. Without this the case passes over a viewport that
    // gave up and mounted the whole log, which is the other way a first commit can
    // be wrong.
    expect(mountedRowCount).toBeLessThan(LOG_ROW_COUNT);
  });

  it("negative control: a box with no height mounts nothing", () => {
    // The zero the case above would report if the rect never reached the library.
    // Without it that case proves only that this harness renders divs — and the
    // state being ruled out is the one the endurance tier saw: rows in the window,
    // none of them on screen.
    const view = render(<TranscriptUnderTest rows={syntheticRows(LOG_ROW_COUNT)} />);

    expect(view.container.querySelectorAll(MOUNTED_ROW_SELECTOR)).toHaveLength(0);
  });
});
