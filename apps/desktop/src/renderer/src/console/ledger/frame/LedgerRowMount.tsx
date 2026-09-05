// One row's box: its own error boundary, and the element the window measures.
//
// Its own module for the one-component rule, and the split is where the viewport's
// per-row obligations stop being buried in its composition: the memo boundary, the
// index the virtualizer resolves an element back through, and the ARIA position pair
// a windowed list owes a screen reader are all facts about a ROW, and the viewport
// above only decides which rows exist.

import { memo } from "react";

import { LedgerRowGroup } from "./LedgerRowGroup.js";
import type { LedgerViewportRow } from "./viewport-snapshot.js";

/** How a row body is drawn. Supplied by whoever owns the row vocabulary. */
export type LedgerRowRenderer = (row: LedgerViewportRow) => React.ReactNode;

export interface LedgerRowMountProps {
  /** The virtualizer reads this back off the element to identify the row. */
  readonly rowIndex: number;
  /** How long the whole log is — not how many rows are mounted. See `aria-setsize`. */
  readonly rowCount: number;
  readonly row: LedgerViewportRow;
  readonly renderRow: LedgerRowRenderer;
  readonly attachRow: (element: HTMLElement | null) => void;
}

/**
 * One row's box.
 *
 * Memoized, because a streaming lane re-renders the viewport on every frame and the
 * rows above the one that is streaming have not changed. The memo only holds if the
 * caller's `renderRow` is stable, which is why the prop says so.
 *
 * `data-index` is not decoration: it is how the virtualizer resolves an observed
 * element back to a row, so a row without it is measured as row zero. The row's own
 * offset is NOT written here — under `directDomUpdates` the virtualizer owns the
 * transform, and a second writer would produce two answers for one row's position.
 */
export const LedgerRowMount: React.MemoExoticComponent<
  (props: LedgerRowMountProps) => React.JSX.Element
> = memo(
  (props: LedgerRowMountProps): React.JSX.Element => (
    <div
      className="meridian-ledger-viewport__row"
      data-index={props.rowIndex}
      ref={props.attachRow}
      role="article"
      // Only the rows near the fold exist in the document, so without these two a
      // reader is told they are on entry 3 of 9 in a log of nine thousand. They are
      // one-based because ARIA counts from one and the virtualizer counts from zero.
      aria-posinset={props.rowIndex + 1}
      aria-setsize={props.rowCount}
    >
      <LedgerRowGroup groupLabel="This entry">{props.renderRow(props.row)}</LedgerRowGroup>
    </div>
  ),
);
LedgerRowMount.displayName = "LedgerRowMount";
