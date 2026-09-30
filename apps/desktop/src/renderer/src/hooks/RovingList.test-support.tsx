// The windowed list the roving-index suites drive.
//
// Not a test file: no `include` glob reaches it. One list serves every suite, so two lists
// differing in which element carries the stop cannot let one suite pass on a shape another
// rejects. The scans that read it are in `useWindowedRovingIndex.test-support.ts`; the list
// with a neighbor to tab to is `ListWithNeighbor.test-support.tsx`.
//
// It hands the hook what a virtualizer hands back: the mounted row array itself, rebuilt
// every render. A stable derivation of it (a joined string) would let the expiry cases pass
// against an implementation that compares the option's identity, a property of the fixture
// and not of the hook.

import { useRef } from "react";

import { WindowedListRow } from "@renderer/components/WindowedListRow/WindowedListRow.js";
import { useWindowedRovingIndex } from "./useWindowedRovingIndex.js";

/** A windowed list reduced to what the hook touches: a slice, an anchor, a reveal. */
export function RovingList(props: {
  readonly rowCount: number;
  readonly windowStart: number;
  readonly windowLength: number;
  /** Where the keyboard starts. Zero unless a case is about the anchor itself. */
  readonly anchorIndex?: number;
  /**
   * The drawn sequence's identity. Absent unless a case is about a redrawn set.
   *
   * Passed through untouched rather than derived from `rowCount`, so a case decides for
   * itself whether two renders are the same sequence.
   */
  readonly rowSetIdentity?: unknown;
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
    rowSetIdentity: props.rowSetIdentity,
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
