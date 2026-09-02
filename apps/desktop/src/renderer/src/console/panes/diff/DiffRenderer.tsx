// THE diff renderer. One implementation, two hosts.
//
// `Spec-023 §Console Design (Meridian)` §10.6: "One diff renderer serves both the
// pane and the timeline card, so a one-character edit reads as one character in
// both." That sentence is the whole reason this file is separate from either of
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
//   • It holds no diff state of its own. View mode, wrap, attribution marks, and
//     the gap expansion all arrive as props, because the pane persists them and
//     the card does not, and a renderer that owned them would have to be told to
//     forget them — which is a second state machine for the same values.
//   • It never mounts diff bytes as markup. Every line is text in a `<code>`
//     span; the artifact serving posture forbids the alternative and no branch
//     here reaches for `dangerouslySetInnerHTML`.
//   • It never clips a long line into a hidden-overflow container. The scroller
//     overflows on both axes and the wrap toggle is the other answer; §10.6 names
//     the clipped-line case as the one that must not happen.
//
// THE WINDOW IS A COMPUTATION, NOT AN EFFECT. `hunk-virtualization.ts` answers
// which rows a scroll position needs; this file measures the scroller and asks.
// The measurement is the only stateful thing here and it lives in a hook, because
// a render body that read `scrollTop` would be reading a value React had not
// caused and could not re-render for.

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

import { Nothing } from "../../primitives/index.js";
import { DIFF_ROW_HEIGHT_PX, DIFF_VIEWPORT_FALLBACK_HEIGHT_PX } from "./diff-bounds.js";
import type { ConsoleDiffModel, DiffViewMode } from "./diff-model.js";
import { DiffRowView } from "./DiffRows.js";
import {
  DiffRowIndex,
  type DiffGapExpansion,
  type DiffViewportMetrics,
} from "./hunk-virtualization.js";

export interface DiffRendererProps {
  readonly model: ConsoleDiffModel;
  readonly viewMode: DiffViewMode;
  readonly showAttributionMarks: boolean;
  readonly wrapLongLines: boolean;
  /**
   * Whether a whitespace-only intraline change is drawn as changed. Off, such a
   * segment renders as carried-over text — a render rule, never a recomputation.
   */
  readonly showWhitespaceChanges: boolean;
  readonly expansion: DiffGapExpansion;
  readonly onExpandGap: (fileIndex: number, hunkIndex: number) => void;
  /**
   * Height the scroller is capped at, in CSS pixels. The inline card supplies
   * one; the pane supplies none and fills the space it was given.
   */
  readonly heightCapPx?: number;
  /** The scroller's accessible name. Its host knows what this diff is of. */
  readonly label: string;
}

/**
 * Measure a scroller, and keep measuring it.
 *
 * A `ResizeObserver` rather than a window listener: the pane is resized by the
 * deck's splitter and by a window move between displays, and neither raises a
 * window resize. The observer is created once, disconnected on unmount, and never
 * writes `scrollTop` — the console's scroll chokepoint owns programmatic scroll
 * and this hook only ever reads.
 */
function useDiffViewport(): {
  readonly scrollerRef: React.RefObject<HTMLDivElement | null>;
  /**
   * What the scroller currently measures. One state rather than two, so a scroll
   * and a resize landing in one frame produce one render — the reason the store
   * coalesces its applies.
   */
  readonly viewport: DiffViewportMetrics;
  readonly onScroll: () => void;
} {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState<DiffViewportMetrics>({
    scrollTopPx: 0,
    viewportHeightPx: DIFF_VIEWPORT_FALLBACK_HEIGHT_PX,
  });

  const measure = useCallback(() => {
    const scroller = scrollerRef.current;
    if (scroller === null) {
      return;
    }
    const scrollTopPx = scroller.scrollTop;
    const viewportHeightPx = scroller.clientHeight;
    setViewport((previous) =>
      previous.scrollTopPx === scrollTopPx && previous.viewportHeightPx === viewportHeightPx
        ? previous
        : { scrollTopPx, viewportHeightPx },
    );
  }, []);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller === null) {
      return undefined;
    }
    measure();
    // `ResizeObserver` is absent in no environment this console runs in, and the
    // test environments provide it; a guard here would be a branch nothing takes
    // and nothing covers.
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    return () => {
      observer.disconnect();
    };
  }, [measure]);

  return { scrollerRef, viewport, onScroll: measure };
}

export function DiffRenderer(props: DiffRendererProps): React.JSX.Element {
  const { scrollerRef, viewport, onScroll } = useDiffViewport();

  // Re-flattened only when the diff or its expansion changes, never per scroll
  // tick: the index is what a scroll READS and a scroll changes neither of its
  // inputs.
  const index = useMemo(
    () => new DiffRowIndex(props.model, props.expansion),
    [props.model, props.expansion],
  );
  const rowWindow = useMemo(() => index.windowFor(viewport), [index, viewport]);

  if (index.rowCount === 0) {
    return (
      <div className="meridian-diff meridian-diff--empty">
        <Nothing
          kind="empty"
          placement="surface"
          title="These states are identical."
          detail="The daemon compared the two named states and found no changed lines between them."
        />
      </div>
    );
  }

  const rows: React.JSX.Element[] = [];
  for (let rowIndex = rowWindow.startIndex; rowIndex < rowWindow.endIndex; rowIndex += 1) {
    const row = index.rowAt(rowIndex);
    if (row === undefined) {
      continue;
    }
    rows.push(
      <DiffRowView
        key={rowIndex}
        rowIndex={rowIndex}
        row={row}
        index={index}
        viewMode={props.viewMode}
        showAttributionMarks={props.showAttributionMarks}
        showWhitespaceChanges={props.showWhitespaceChanges}
        onExpandGap={props.onExpandGap}
      />,
    );
  }

  const className = [
    "meridian-diff",
    `meridian-diff--${props.viewMode}`,
    props.wrapLongLines ? "meridian-diff--wrap" : "",
  ]
    .filter((part) => part !== "")
    .join(" ");

  return (
    <div
      className={className}
      ref={scrollerRef}
      onScroll={onScroll}
      // A scroller is only keyboard-reachable if it can take focus, and a diff
      // that can be read with a mouse and not with a keyboard is a diff half the
      // operators cannot read.
      tabIndex={0}
      role="table"
      aria-label={props.label}
      aria-rowcount={index.rowCount}
      // The row height has ONE home, `diff-bounds.ts`, and the sheet reads it from
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
          a virtualized list unreadable to a screen reader that walks it. */}
      <div className="meridian-diff__content" style={{ blockSize: rowWindow.totalHeightPx }}>
        <div
          className="meridian-diff__window"
          style={{ transform: `translateY(${String(rowWindow.leadingSpacerPx)}px)` }}
        >
          {rows}
        </div>
      </div>
    </div>
  );
}
