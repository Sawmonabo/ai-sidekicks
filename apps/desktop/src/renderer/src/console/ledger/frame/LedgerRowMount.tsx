// One row's box: its own error boundary, and the element the window measures.
//
// Its own module for the one-component rule, and the split is where the viewport's
// per-row obligations stop being buried in its composition: the memo boundary, the
// index the virtualizer resolves an element back through, and the position a windowed
// list owes a screen reader are all facts about a ROW, and the viewport above only
// decides which rows exist.
//
// THE POSITION PAIR IS THE PRIMITIVE'S AND NOT THIS MODULE'S. `primitives/
// WindowedListRow` is the console's one writer of the two members that say where a
// row sits in the whole enumeration, and it writes the index attribute the
// virtualizer resolves an element back through on the same predicate. Writing the
// three here was three attributes with two owners and no compiler holding them
// together, and it dropped the primitive's fail-closed arm: the window cap prunes, so
// a row already painted at index 4 000 outlives one recomputation of a row count that
// is now 3 950, and an unconditional pair announces "entry 4 001 of 3 950". The
// primitive instead declares the set size unknown, claims no position, and writes no
// index — a reader is told less rather than told something false, and the keyboard
// cannot land on a row that withheld its position either.

import { memo } from "react";

import { WindowedListRow } from "../../primitives/index.js";
import { LedgerRowGroup } from "./LedgerRowGroup.js";
import type { LedgerViewportRow } from "./viewport-snapshot.js";

/**
 * What a ledger row is in the accessibility tree.
 *
 * Named once rather than spelled at the call below, because it is half of a pairing
 * whose other half lives one module up: `LedgerViewport` claims the WAI-ARIA feed
 * pattern's `feed` on the scroll surface, and a `feed` REQUIRES owned articles. The
 * two are one claim about one surface, so the row's half is declared where a reader
 * meets the row and the surface's half says the same thing about the container.
 */
const LEDGER_ROW_ROLE = "article" as const;

/** How a row body is drawn. Supplied by whoever owns the row vocabulary. */
export type LedgerRowRenderer = (row: LedgerViewportRow) => React.ReactNode;

export interface LedgerRowMountProps {
  /** The virtualizer reads this back off the element to identify the row. */
  readonly rowIndex: number;
  /** How long the whole log is — not how many rows are mounted. */
  readonly totalRowCount: number;
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
 * The row's own offset is NOT written here — under `directDomUpdates` the
 * virtualizer owns the transform, and a second writer would produce two answers for
 * one row's position.
 */
export const LedgerRowMount: React.MemoExoticComponent<
  (props: LedgerRowMountProps) => React.JSX.Element
> = memo(
  (props: LedgerRowMountProps): React.JSX.Element => (
    <WindowedListRow
      as="div"
      role={LEDGER_ROW_ROLE}
      className="meridian-ledger-viewport__row"
      rowIndex={props.rowIndex}
      totalRowCount={props.totalRowCount}
      rowRef={props.attachRow}
    >
      <LedgerRowGroup groupLabel="This entry">{props.renderRow(props.row)}</LedgerRowGroup>
    </WindowedListRow>
  ),
);
LedgerRowMount.displayName = "LedgerRowMount";
