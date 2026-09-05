// The windowed list the roving-index cases drive.
//
// Not a test file — no `include` glob reaches it; the three co-located suites import
// it, the way `live-region.test-support.ts` is imported. One list for all of them: two
// lists differing in which element carries the stop would let one suite pass on a
// shape the other rejects. The scans that read it live in
// `windowed-row-index.test-support.ts`; the list with a neighbour to tab to is
// `ListWithNeighbour.test-support.tsx`.
//
// THE FIXTURE HANDS THE HOOK THE SHAPE A VIRTUALIZER HANDS BACK: the mounted row
// array itself, rebuilt every render. A stable derivation of it — a joined string —
// makes the expiry cases pass against an implementation that compares the option's
// identity, which is a property of the fixture and not of the hook. The array is the
// harder value and the real one.

import { useRef } from "react";

import { WindowedListRow } from "./WindowedListRow.js";
import { useWindowedRovingIndex } from "./windowed-row-index.js";

/** A windowed list reduced to what the hook touches: a slice, an anchor, a reveal. */
export function RovingList(props: {
  readonly rowCount: number;
  readonly windowStart: number;
  readonly windowLength: number;
  /** Where the keyboard starts. Zero unless a case is about the anchor itself. */
  readonly anchorIndex?: number;
  readonly onReveal: (rowIndex: number) => void;
}): React.JSX.Element {
  const containerRef = useRef<HTMLUListElement | null>(null);
  const mountedIndexes = Array.from(
    { length: Math.min(props.windowLength, Math.max(props.rowCount - props.windowStart, 0)) },
    (unused, offset) => props.windowStart + offset,
  );
  const { activeIndex, onKeyDown } = useWindowedRovingIndex({
    rowCount: props.rowCount,
    anchorIndex: props.anchorIndex ?? 0,
    containerRef,
    revealIndex: props.onReveal,
    windowRevision: mountedIndexes,
  });
  return (
    <ul ref={containerRef} onKeyDown={onKeyDown} data-active-index={activeIndex}>
      {mountedIndexes.map((rowIndex) => (
        <WindowedListRow
          key={rowIndex}
          as="li"
          rowIndex={rowIndex}
          totalRowCount={props.rowCount}
          isTabbable={rowIndex === activeIndex}
        >
          {(targetProps) => (
            <button type="button" {...targetProps}>{`row ${String(rowIndex)}`}</button>
          )}
        </WindowedListRow>
      ))}
    </ul>
  );
}
