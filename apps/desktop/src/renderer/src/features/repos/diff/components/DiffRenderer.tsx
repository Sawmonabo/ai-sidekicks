// THE diff renderer. One implementation, two hosts.
//
// THIS FAMILY'S OWN RULE, stated here because no committed document states it: one
// diff renderer serves both the pane and the transcript card, so a one-character edit
// reads as one character in
// both. That rule is the whole reason this file is separate from either of
// them — a second renderer written for the card would drift from the pane's in
// exactly the places nobody screenshots, and the two would disagree about what a
// change looks like without either ever being wrong on its own terms.
//
// So the split is: this file owns ROWS — the scroller, the window, the spacers,
// and the row list. The pane owns its chrome, the card owns its cap and its
// escape hatches, and neither owns a row.
//
// WHAT IT DELIBERATELY DOES NOT DO
//
//   • It holds no diff state of its own. View mode and the gap expansion arrive as
//     props, because the pane persists them and the card does not, and a renderer
//     that owned them would have to be told to forget them — which is a second state
//     machine for the same values.
//   • It never mounts diff bytes as markup. Every line is text in a `<code>`
//     span; the artifact serving posture forbids the alternative and no branch
//     here reaches for `dangerouslySetInnerHTML`.
//   • It never clips a long line into a hidden-overflow container. A long line wraps
//     onto more rows of text, and the scroller overflows on both axes for a token that
//     cannot break; the clipped-line case is this renderer's one Never.
//
// AND THE INTRALINE HIGHLIGHT IS COMPUTED FOR THE ROWS IT DRAWS, NOWHERE ELSE. The
// word diff runs when a row is materialized, out of the cache below, rather than for
// every changed pair at parse time, which is what makes the virtualization actually bound
// the cost rather than only bound the DOM.
//
// THE WINDOW IS THE ADOPTED VIRTUALIZER'S, AND THE FLATTENING IS OURS.
// `@tanstack/react-virtual` is adopted with constraints, and `row-window.ts` is the one
// place it is configured — this family windows two
// lists, the rows and the changed-file list beside them, and the bounds they share
// are stated there once. `diff-row-index.ts` still answers
// WHICH ROWS EXIST — a diff is a nested structure and no virtualizer's contract
// starts from anything but a flat count — and the virtualizer answers which of
// them a scroll position needs. A window written here with a fixed row height baked in
// would be the defect below.
//
// EVERY ROW IS MEASURED. The sheet gives a row a minimum height and lets it grow, so a
// long line becomes three rows tall and the estimate stops being the truth: every
// rendered row reports its own height through `measureElement`. A fixed-height window over
// auto-height rows is exactly the state where the offsets and the DOM diverge and
// content jumps as it scrolls.
//
// ONE SCROLL WRITE EXISTS AND IT IS THE LIBRARY'S. When a row ABOVE the fold settles
// from its estimate to a taller measurement, the virtualizer compensates the scroll
// offset by the delta so the reader's place does not slide out from under them. That is
// layout anchoring rather than a commanded scroll — the console's scroll chokepoint owns
// "take me to X", and nothing here asks for one.

import { useMemo, useRef } from "react";

import { Nothing } from "@renderer/console/primitives/index.js";
import { DIFF_ROW_HEIGHT_PX } from "../diff-measures.js";
import type { DiffModel, DiffViewMode } from "../diff-model.js";
import { DiffRowView } from "./DiffRowView.js";
import type { DiffGapExpansion } from "../diff-row-model.js";
import { DiffRowIndex } from "../diff-row-index.js";
import { IntralineSegmentCache } from "../intraline-segment-cache.js";
import { useRowWindow } from "../hooks/useRowWindow.js";

export interface DiffRendererProps {
  readonly model: DiffModel;
  readonly viewMode: DiffViewMode;
  readonly expansion: DiffGapExpansion;
  /**
   * Show only this file of the model, by its wire-verbatim path.
   *
   * A narrowing rather than a smaller model, so `fileIndex` on every row this
   * renderer hands back — and on every `onExpandGap` call — still addresses
   * `model.files`. The pane narrows; the card shows the whole change set.
   */
  readonly shownFilePath?: string | undefined;
  readonly onExpandGap: (fileIndex: number, hunkIndex: number) => void;
  /**
   * Height the scroller is capped at, in CSS pixels. The inline card supplies
   * one; the pane supplies none and fills the space it was given.
   */
  readonly heightCapPx?: number;
  /** The scroller's accessible name. Its host knows what this diff is of. */
  readonly label: string;
}

/** The diff as one virtualized scroller of file headers and rows. */
export function DiffRenderer(props: DiffRendererProps): React.JSX.Element {
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  // Re-flattened only when the diff, its expansion, or the layout changes, never
  // per scroll tick: the index is what a scroll READS and a scroll changes none
  // of its inputs. The view mode is one of them because split view pairs a
  // deletion with the insertion that follows it into ONE row, so the two layouts
  // do not agree on how many rows a hunk has.
  const index = useMemo(
    () => new DiffRowIndex(props.model, props.expansion, props.shownFilePath, props.viewMode),
    [props.model, props.expansion, props.shownFilePath, props.viewMode],
  );

  // KEYED ON THE MODEL AND NOT ON THE INDEX, which is the whole reason it is a second
  // memo. A gap expansion, a file narrowing, and a view-mode toggle each build a new
  // index and change no line's text, so a cache tied to the index would throw away
  // every segmentation on a keystroke that moved nothing.
  const intraline = useMemo(() => new IntralineSegmentCache(props.model), [props.model]);

  const virtualizer = useRowWindow({
    rowCount: index.rowCount,
    getScrollElement: () => scrollerRef.current,
    estimatedRowHeightPx: DIFF_ROW_HEIGHT_PX,
  });

  if (index.rowCount === 0) {
    return (
      <div className="meridian-diff meridian-diff--empty">
        <Nothing kind="empty" placement="block" title="nothing to review" />
      </div>
    );
  }

  const virtualRows = virtualizer.getVirtualItems();
  const rows: React.JSX.Element[] = [];
  for (const virtualRow of virtualRows) {
    const row = index.rowAt(virtualRow.index);
    if (row === undefined) {
      continue;
    }
    rows.push(
      <DiffRowView
        key={virtualRow.index}
        rowIndex={virtualRow.index}
        row={row}
        index={index}
        intraline={intraline}
        viewMode={props.viewMode}
        onExpandGap={props.onExpandGap}
        rowElementRef={virtualizer.measureElement}
      />,
    );
  }

  const className = `meridian-diff meridian-diff--${props.viewMode}`;

  return (
    <div
      className={className}
      ref={scrollerRef}
      // A scroller is only keyboard-reachable if it can take focus, and a diff
      // that can be read with a mouse and not with a keyboard is a diff half the
      // operators cannot read.
      tabIndex={0}
      role="table"
      aria-label={props.label}
      aria-rowcount={index.rowCount}
      // The row height has ONE home, `diff-measures.ts`, and the sheet reads it from
      // here. A `20px` written in CSS beside a `20` written in TypeScript is the
      // same value under two owners, and the day one moves the window arithmetic
      // and the painted rows disagree with nothing to catch it.
      style={
        {
          "--meridian-diff-row-height": `${String(DIFF_ROW_HEIGHT_PX)}px`,
          ...(props.heightCapPx === undefined ? {} : { maxBlockSize: props.heightCapPx }),
        } as React.CSSProperties
      }
    >
      {/* The content box holds the full height so the scrollbar reports the whole
          diff, and the leading spacer puts the rendered window at its true
          offset. Two boxes rather than absolute positioning: a positioned row
          would leave the rows out of the document's own flow, which is what makes
          a virtualized list unreadable to a screen reader that walks it. The
          rendered rows are contiguous and stack at the heights the virtualizer
          measured them at, so the flow and the offsets are the same arithmetic. */}
      <div className="meridian-diff__content" style={{ blockSize: virtualizer.getTotalSize() }}>
        <div
          className="meridian-diff__window"
          style={{ transform: `translateY(${String(virtualRows[0]?.start ?? 0)}px)` }}
        >
          {rows}
        </div>
      </div>
    </div>
  );
}
