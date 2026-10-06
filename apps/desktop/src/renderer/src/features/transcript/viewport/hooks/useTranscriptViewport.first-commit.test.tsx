// A freshly mounted viewport shows rows once its mount settles. The virtualizer computes no
// range while its rect reports zero height (`@tanstack/virtual-core`'s `calculateRange`
// returns `null` for `outerSize === 0`), and an empty window raises neither a scroll nor a
// box change, the two triggers that would publish another sample; on screen that looks like a
// session with no rows. The rect reaches the library only through the geometry chokepoint, so
// this drives the shape the real tree uses: the hook in one component, the scroll container's
// ref in a child, no scroll, resize or extra frame. `useTranscriptViewport.test.ts` attaches
// by hand after the mount, which cannot answer the ref-callback versus layout-effect ordering.

import { render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ManualClock } from "#renderer/lib/clock.js";
import { useTranscriptViewport, type TranscriptViewportBinding } from "./useTranscriptViewport.js";
import type { ViewportRow } from "../snapshot.js";
import { syntheticRows, withLaidOutViewport } from "../controller.test-support.js";

/** Comfortably more rows than a 400 px box can hold, so a window is the only answer. */
const LOG_ROW_COUNT = 200;

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
 * The hook's owner, one component above the scroll container as in the real tree: React
 * attaches a child's ref before an ancestor's layout effects, so the container is bound before
 * the library asks. The clock is minted once; a fresh one per render re-mints the controller
 * and the mount never settles.
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
    // `happy-dom` answers zero for every box, so the height is what this environment must be
    // told; everything between it and the row count is the shipped module.
    withLaidOutViewport();

    const view = render(<TranscriptUnderTest rows={syntheticRows(LOG_ROW_COUNT)} />);

    const mountedRowCount = view.container.querySelectorAll(MOUNTED_ROW_SELECTOR).length;
    expect(
      mountedRowCount,
      "the mount settled with no row on screen, so a session opened on " +
        "a log this long draws an empty transcript",
    ).toBeGreaterThan(0);
    // And it is still a window: a viewport that gave up and mounted the whole log is also wrong.
    expect(mountedRowCount).toBeLessThan(LOG_ROW_COUNT);
  });
});
