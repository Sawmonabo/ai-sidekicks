// One row's box: its own error boundary and the element the window measures. A boundary per row
// rather than per feed, so a single row that throws does not blank the log around it. The position
// pair (`aria-posinset`, `aria-setsize`) and the index attribute the virtualizer resolves an
// element through are written by `WindowedListRow`, whose fail-closed arm declares the set size
// unknown when a painted row's index outlives a pruned row count, so a reader is never told
// "entry 4 001 of 3 950".

import { memo, useCallback } from "react";

import { WindowedListRow } from "#renderer/components/WindowedListRow/WindowedListRow.js";
import { ErrorBoundary } from "#renderer/components/ErrorBoundary/ErrorBoundary.js";
import { usePreservedRowSelection } from "../hooks/selection/usePreservedRowSelection.js";
import type { ViewportRow } from "../snapshot.js";

/**
 * What a transcript row is in the accessibility tree: the other half of the `feed` role
 * `TranscriptViewport` claims on the sizer, which requires owned articles.
 */
const TRANSCRIPT_ROW_ROLE = "article" as const;

/** How a row body is drawn. Supplied by whoever owns the row vocabulary. */
export type ViewportRowRenderer = (row: ViewportRow) => React.ReactNode;

/** Props for `VirtualRow`. */
export interface VirtualRowProps {
  /** The virtualizer reads this back off the element to identify the row. */
  readonly rowIndex: number;
  /** How long the whole log is — not how many rows are mounted. */
  readonly totalRowCount: number;
  readonly row: ViewportRow;
  readonly renderRow: ViewportRowRenderer;
  readonly attachRow: (element: HTMLElement | null) => void;
}

/**
 * One row's box. Memoized because a streaming row re-renders the viewport every frame; that
 * only holds if the caller's `renderRow` is stable. The row's offset is not written here:
 * under `directDomUpdates` the virtualizer owns the transform.
 */
export const VirtualRow: React.MemoExoticComponent<(props: VirtualRowProps) => React.JSX.Element> =
  memo((props: VirtualRowProps): React.JSX.Element => {
    // The virtualizer measures the row and the viewport's selection tracker keeps a reader's
    // highlight inside it; `WindowedListRow` takes one ref, so both are composed here.
    const attachPreservedSelection = usePreservedRowSelection();
    const attachRow = props.attachRow;
    const attachRowElement = useCallback(
      (element: HTMLElement | null): void => {
        attachRow(element);
        attachPreservedSelection(element);
      },
      [attachRow, attachPreservedSelection],
    );

    return (
      <WindowedListRow
        as="div"
        role={TRANSCRIPT_ROW_ROLE}
        className="meridian-transcript-viewport__row"
        rowIndex={props.rowIndex}
        totalRowCount={props.totalRowCount}
        rowRef={attachRowElement}
      >
        <ErrorBoundary regionName="This entry">{props.renderRow(props.row)}</ErrorBoundary>
      </WindowedListRow>
    );
  });
VirtualRow.displayName = "VirtualRow";
