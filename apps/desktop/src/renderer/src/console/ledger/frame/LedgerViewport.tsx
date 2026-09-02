// The ledger viewport — the virtualized feed, the reading anchor's pill, and the
// slot every row body is mounted through.
//
// This component RENDERS. Every decision it draws was made in a class:
// `viewport-controller.ts` wires the scroll chokepoint, the reading anchor, the row
// window, and the window cap together and publishes one snapshot; this file turns
// that snapshot into elements and does nothing else. No measurement, no
// subscription, no offset arithmetic lives here.
//
// THREE THINGS THE MARKUP HAS TO GET RIGHT:
//
//   • **One scroll container.** The surface below is the only scrollable box in the
//     ledger. A second one anywhere inside it would give the chokepoint a rival
//     `scrollTop` it does not own, and the reading anchor is an offset INSIDE this
//     box.
//   • **A sizer and a slice.** The sizer carries the whole log's height so the
//     scrollbar is honest; the slice is translated to the first mounted row's
//     offset so only the rows near the fold exist in the document. `translateY`
//     rather than `top`, because a transform is composited and does not invalidate
//     layout for the rows that did not move.
//   • **`role="feed"`, and rows that are `<article>`s.** The log grows at one end
//     while a person reads the other, which is exactly what a feed is. `LedgerRow`
//     renders an `<article>`, so the nesting is valid without this file asserting
//     anything about what a row body draws.
//
// `Spec-023 §Console Design (Meridian)` §5.6: "Attention is steered by luminance,
// never by motion spikes." A lane taking catch-up rate is marked with a class the
// stylesheet answers in luminance; nothing here animates, and nothing pulses.

import { memo, useCallback, useMemo } from "react";

import { type ConsoleClock } from "../../core/index.js";
import { DerivedFigure, Nothing, formatCount } from "../../primitives/index.js";
import { LedgerErrorSlot, LedgerRowGroup, type LedgerErrorEntry } from "./ErrorSlot.js";
import {
  useLedgerViewport,
  type LedgerViewportRow,
  type LedgerViewportSnapshot,
} from "./viewport-controller.js";

/** How a row body is drawn. Supplied by whoever owns the row vocabulary. */
export type LedgerRowRenderer = (row: LedgerViewportRow) => React.ReactNode;

export interface LedgerViewportProps {
  /** The clock every timer in this frame is minted through. Fixed for the mount. */
  readonly clock: ConsoleClock;
  /** MEMOIZED by the caller — see `useLedgerViewport`. */
  readonly rows: readonly LedgerViewportRow[];
  /** STABLE across renders, or the memoized rows below re-render with it. */
  readonly renderRow: LedgerRowRenderer;
  /** Names the feed for a screen reader walking the window. */
  readonly feedLabel: string;
  /** A turn is mid-flight. Prune waits rather than moving rows under a stream. */
  readonly hasActiveTurn?: boolean;
  /** The reveal engine still has characters queued. Prune waits for that too. */
  readonly isRevealDraining?: boolean;
  readonly errorEntries?: readonly LedgerErrorEntry[];
}

const NO_ERROR_ENTRIES: readonly LedgerErrorEntry[] = [];

export function LedgerViewport(props: LedgerViewportProps): React.JSX.Element {
  const { snapshot, attachSurface, measureRow, jumpToTail } = useLedgerViewport({
    clock: props.clock,
    rows: props.rows,
    hasActiveTurn: props.hasActiveTurn ?? false,
    isRevealDraining: props.isRevealDraining ?? false,
  });
  const mountedRows = useMemo(
    () => snapshot.rows.slice(snapshot.range.startIndex, snapshot.range.endIndex),
    [snapshot],
  );

  return (
    <div className="meridian-ledger-viewport">
      <LedgerErrorSlot entries={props.errorEntries ?? NO_ERROR_ENTRIES} />
      <div
        className="meridian-ledger-viewport__surface"
        ref={attachSurface}
        role="feed"
        aria-label={props.feedLabel}
        aria-busy={props.hasActiveTurn ?? false}
        // Focusable so the log is reachable and scrollable from the keyboard: a
        // scroll container with no focusable child is unreachable by Tab, and the
        // reading anchor is a promise made to somebody who can get here.
        tabIndex={0}
      >
        <div
          className="meridian-ledger-viewport__sizer"
          style={{ height: `${String(snapshot.range.totalHeightPx)}px` }}
        >
          <div
            className="meridian-ledger-viewport__slice"
            style={{ transform: `translateY(${String(snapshot.range.offsetBeforeStartPx)}px)` }}
          >
            {mountedRows.map((row) => (
              <LedgerRowMount
                key={row.key}
                row={row}
                renderRow={props.renderRow}
                measureRow={measureRow}
              />
            ))}
          </div>
        </div>
        {snapshot.rows.length === 0 ? (
          <Nothing
            kind="empty"
            placement="surface"
            title="Nothing has happened in this session yet."
            detail="Entries appear here as people and agents work."
          />
        ) : null}
        <LedgerWindowNotices snapshot={snapshot} />
      </div>
      <LedgerTailAffordance snapshot={snapshot} onJumpToTail={jumpToTail} />
    </div>
  );
}

interface LedgerRowMountProps {
  readonly row: LedgerViewportRow;
  readonly renderRow: LedgerRowRenderer;
  readonly measureRow: (rowKey: string, element: HTMLElement | null) => void;
}

/**
 * One row's box: its own error boundary, and the measurement the window learns from.
 *
 * Memoized, because a streaming lane re-renders the viewport on every frame and the
 * rows above the one that is streaming have not changed. The memo only holds if the
 * caller's `renderRow` is stable, which is why the prop says so.
 *
 * The measurement is taken on mount and on every re-mount rather than on a schedule:
 * a row's height changes when its content does, and its content changing is what
 * re-renders it.
 */
const LedgerRowMount = memo(function LedgerRowMount(props: LedgerRowMountProps): React.JSX.Element {
  const { measureRow, row } = props;
  const attachRow = useCallback(
    (element: HTMLDivElement | null) => {
      measureRow(row.key, element);
    },
    [measureRow, row.key],
  );
  return (
    <div className="meridian-ledger-viewport__row" ref={attachRow}>
      <LedgerRowGroup groupLabel="This entry">{props.renderRow(row)}</LedgerRowGroup>
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
  readonly snapshot: LedgerViewportSnapshot;
}

/**
 * The two ways the window degrades, said out loud.
 *
 * Both are `Spec-023 §Console Design (Meridian)` §5.8 residuals, and both are the
 * kind of defect that is invisible until somebody scrolls to exactly the wrong
 * place. Rendering them costs two lines and turns a mystery into a report.
 */
function LedgerWindowNotices(props: LedgerWindowNoticesProps): React.JSX.Element | null {
  const { range } = props.snapshot;
  if (range.duplicateKeyCount === 0 && !range.isClampedToElementCeiling) {
    return null;
  }
  return (
    <div className="meridian-ledger-viewport__notices">
      {range.duplicateKeyCount === 0 ? null : (
        <Nothing
          kind="error"
          placement="inline"
          title="Some entries share an identifier."
          detail="They are drawn at an estimated height until the projection sends distinct keys."
        />
      )}
      {range.isClampedToElementCeiling ? (
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
