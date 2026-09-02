// The ledger viewport — the virtualized feed, the reading anchor's pill, and the
// slot every row body is mounted through.
//
// This component RENDERS. Every decision it draws was made in a class:
// `viewport-controller.ts` wires the scroll chokepoint, the reading anchor, the row
// window, and the window cap together and publishes one snapshot; this file turns
// that snapshot into elements and does nothing else. No measurement, no
// subscription, no offset arithmetic lives here — and no BINDING is minted here
// either: the caller owns the one binding this ledger has and hands it down, so the
// rail, the find walk, and the rows on screen are all reading the same virtualizer.
//
// THREE THINGS THE MARKUP HAS TO GET RIGHT:
//
//   • **One scroll container.** The surface below is the only scrollable box in the
//     ledger. A second one anywhere inside it would give the chokepoint a rival
//     `scrollTop` it does not own, and the reading anchor is an offset INSIDE this
//     box.
//   • **A sizer, and rows placed inside it.** The sizer carries the whole log's
//     height so the scrollbar is honest; each mounted row is absolutely positioned
//     and translated to its own offset, so only the rows near the fold exist in the
//     document. Both the sizer's height and each row's transform are written by the
//     virtualizer DIRECTLY, under `directDomUpdates` — which is why neither appears
//     in the style objects below and why writing one here would fight it.
//   • **`role="feed"`, and rows that ARE articles, declared here.** The log grows at
//     one end while a person reads the other, which is exactly what a feed is. The
//     role's required-children relationship is satisfied by the row box BELOW, not
//     by whatever a row body happens to draw: the body arrives through a seat a
//     different family fills, so resting a WCAG-required structural relationship on
//     it would be fail-OPEN — the feed would stay valid only for as long as that
//     family kept rendering an `<article>`, and would break silently the day it
//     stopped. The element that declares `role="feed"` owns the guarantee.
//
//     The sizer between them is `role="presentation"`: it is pure geometry whose
//     height the virtualizer writes, it names nothing, and left in the tree it
//     stands between the feed and the rows it is supposed to own.
//
// `Spec-023 §Console Design (Meridian)` §5.6: "Attention is steered by luminance,
// never by motion spikes." A lane taking catch-up rate is marked with a class the
// stylesheet answers in luminance; nothing here animates, and nothing pulses.

import { memo } from "react";

import { DerivedFigure, Nothing, formatCount } from "../../primitives/index.js";
import { LedgerErrorSlot, LedgerRowGroup, type LedgerErrorEntry } from "./ErrorSlot.js";
import { type LedgerViewportBinding } from "./viewport-binding.js";
import type { LedgerViewportRow, LedgerViewportSnapshot } from "./viewport-snapshot.js";

/** How a row body is drawn. Supplied by whoever owns the row vocabulary. */
export type LedgerRowRenderer = (row: LedgerViewportRow) => React.ReactNode;

export interface LedgerViewportProps {
  /**
   * The caller's binding — the one this ledger has.
   *
   * TAKEN rather than minted. `useLedgerViewport` builds a controller, a scroll
   * chokepoint, a reading anchor, and a virtualizer, and a viewport that minted its
   * own would give the surrounding surface a SECOND set: the rail would report a
   * following state nobody is scrolling, and `jumpToRow` would scroll a virtualizer
   * with no element under it. One binding per ledger is the whole invariant, and
   * requiring it as a prop is what makes a second one unrepresentable rather than
   * merely discouraged.
   */
  readonly binding: LedgerViewportBinding;
  /** STABLE across renders, or the memoized rows below re-render with it. */
  readonly renderRow: LedgerRowRenderer;
  /** Names the feed for a screen reader walking the window. */
  readonly feedLabel: string;
  /** A turn is mid-flight — the same value the caller reconciled the binding with. */
  readonly hasActiveTurn?: boolean;
  readonly errorEntries?: readonly LedgerErrorEntry[];
}

const NO_ERROR_ENTRIES: readonly LedgerErrorEntry[] = [];

export function LedgerViewport(props: LedgerViewportProps): React.JSX.Element {
  const { binding } = props;
  const { snapshot } = binding;

  return (
    <div className="meridian-ledger-viewport">
      <LedgerErrorSlot entries={props.errorEntries ?? NO_ERROR_ENTRIES} />
      <div
        className="meridian-ledger-viewport__surface"
        ref={binding.attachSurface}
        // The feed role is claimed only while there is something to be a feed OF.
        // `feed` REQUIRES owned articles, so an empty one is not a quieter feed but
        // an invalid one — and a role whose contract the element is breaking is
        // worse for a screen-reader user than the plain scroll container this
        // honestly is until the first row lands. The label and the busy state go
        // with it: both describe the feed, and neither has a subject without it.
        {...(snapshot.rows.length === 0
          ? {}
          : {
              role: "feed",
              "aria-label": props.feedLabel,
              "aria-busy": props.hasActiveTurn ?? false,
            })}
        // Focusable so the log is reachable and scrollable from the keyboard: a
        // scroll container with no focusable child is unreachable by Tab, and the
        // reading anchor is a promise made to somebody who can get here.
        tabIndex={0}
      >
        <div
          className="meridian-ledger-viewport__sizer"
          ref={binding.attachSizer}
          role="presentation"
        >
          {binding.virtualItems.map((virtualItem) => {
            const row = snapshot.rows[virtualItem.index];
            return row === undefined ? null : (
              <LedgerRowMount
                key={virtualItem.key}
                rowIndex={virtualItem.index}
                row={row}
                rowCount={snapshot.rows.length}
                renderRow={props.renderRow}
                attachRow={binding.attachRow}
              />
            );
          })}
        </div>
        {snapshot.rows.length === 0 ? (
          <Nothing
            kind="empty"
            placement="surface"
            title="Nothing has happened in this session yet."
            detail="Entries appear here as people and agents work."
          />
        ) : null}
        <LedgerWindowNotices binding={binding} />
      </div>
      <LedgerTailAffordance snapshot={snapshot} onJumpToTail={binding.jumpToTail} />
    </div>
  );
}

interface LedgerRowMountProps {
  /** The virtualizer reads this back off the element to identify the row. */
  readonly rowIndex: number;
  /** How long the whole log is — not how many rows are mounted. See `aria-setsize`. */
  readonly rowCount: number;
  readonly row: LedgerViewportRow;
  readonly renderRow: LedgerRowRenderer;
  readonly attachRow: (element: HTMLElement | null) => void;
}

/**
 * One row's box: its own error boundary, and the element the window measures.
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
const LedgerRowMount = memo(function LedgerRowMount(props: LedgerRowMountProps): React.JSX.Element {
  return (
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
  );
});

interface LedgerTailAffordanceProps {
  readonly snapshot: LedgerViewportSnapshot;
  readonly onJumpToTail: () => void;
}

/**
 * The "N new" pill, and the pin's own notice.
 *
 * `Spec-023 §Console Design (Meridian)` §5.7 gives the reader two facts and one
 * act: rows arrived while they were reading, history is pinned, and the way back to
 * the tail. The pill appears only in `reading-with-new-rows`, because a pill
 * offering to jump to rows already on screen is noise; the pin notice appears
 * whenever history is pinned, because it explains why the log has stopped trimming.
 */
function LedgerTailAffordance(props: LedgerTailAffordanceProps): React.JSX.Element | null {
  const { reading } = props.snapshot;
  if (reading.mode !== "reading-with-new-rows" && reading.pinnedRootCursor === undefined) {
    return null;
  }
  return (
    <div className="meridian-ledger-viewport__tail">
      {reading.pinnedRootCursor === undefined ? null : (
        <span className="meridian-ledger-viewport__pin" role="status">
          History is pinned. Nothing is being trimmed while you read.
        </span>
      )}
      {reading.mode === "reading-with-new-rows" ? (
        <button
          type="button"
          className="meridian-ledger-viewport__pill"
          onClick={props.onJumpToTail}
        >
          <DerivedFigure text={formatCount(reading.newRowCount)} />
          <span>new</span>
        </button>
      ) : null}
    </div>
  );
}

interface LedgerWindowNoticesProps {
  readonly binding: LedgerViewportBinding;
}

/**
 * The two ways the window degrades, said out loud.
 *
 * Both are `Spec-023 §Console Design (Meridian)` §5.8 residuals, and both are the
 * kind of defect that is invisible until somebody scrolls to exactly the wrong
 * place. Rendering them costs two lines and turns a mystery into a report.
 */
function LedgerWindowNotices(props: LedgerWindowNoticesProps): React.JSX.Element | null {
  const { duplicateKeyCount } = props.binding.snapshot.keyProjection;
  const isPastElementCeiling = props.binding.isPastElementCeiling;
  if (duplicateKeyCount === 0 && !isPastElementCeiling) {
    return null;
  }
  return (
    <div className="meridian-ledger-viewport__notices">
      {duplicateKeyCount === 0 ? null : (
        <Nothing
          kind="error"
          placement="inline"
          title="Some entries share an identifier."
          detail="Each is drawn and measured on its own until the projection sends distinct keys."
        />
      )}
      {isPastElementCeiling ? (
        <Nothing
          kind="error"
          placement="inline"
          title="The log is taller than this window can draw."
          detail="Older entries below the drawable ceiling are reachable through find and the rail."
        />
      ) : null}
    </div>
  );
}
