// The transcript viewport: the virtualized feed, the reading anchor's pill, and the row box
// every row body is mounted in. It only turns `viewport-controller.ts`'s snapshot into elements;
// the caller owns the one binding, so the find walk and the rows read the same virtualizer.
// Markup invariants: one scroll container (a nested scroller would rival the chokepoint's
// `scrollTop`); the sizer and each row's transform are written by the virtualizer under
// `directDomUpdates`, so no style here sets them; `role="feed"` is declared on the scroll
// container and its article children by `VirtualRow`, so the relationship does not rest on
// whatever a registered row renderer draws; the sizer is `role="presentation"`. Attention is
// steered by luminance, never motion: the only transition is the pill's hover color.

import { EmptyTranscript } from "./EmptyTranscript.js";
import { VirtualRow, type ViewportRowRenderer } from "./VirtualRow.js";
import { JumpToLatest } from "./JumpToLatest.js";
import { type TranscriptViewportBinding } from "../hooks/useTranscriptViewport.js";

/** Props for `TranscriptViewport`. */
export interface TranscriptViewportProps {
  /**
   * The caller's binding, taken rather than minted: a viewport that built its own would give
   * the feed a second virtualizer, so the find walk and the rows on screen would disagree and
   * `jumpToRow` would scroll one with no element under it.
   */
  readonly binding: TranscriptViewportBinding;
  /** Stable across renders, or the memoized rows re-render with it. */
  readonly renderRow: ViewportRowRenderer;
  /** Names the feed for a screen reader walking the window. */
  readonly feedLabel: string;
  /**
   * Whether this session's first read has settled. Required so a caller decides: the empty
   * window is a claim about a session, and an inherited default would show "Nothing has
   * happened" above the pane's skeleton rows while the read is still in flight.
   */
  readonly firstReadSettled: boolean;
  /** A turn is mid-flight; the value the caller reconciled the binding with. */
  readonly hasActiveTurn?: boolean;
  /**
   * The head control that walks back into the rows before this window's head, where the caller
   * has a read to give it. Absent, nothing renders at the head.
   */
  readonly earlierHistoryControl?: React.ReactNode;
}

/** The scrolling window over one transcript's rows, with its head and tail affordances. */
export function TranscriptViewport(props: TranscriptViewportProps): React.JSX.Element {
  const { binding } = props;
  const { snapshot } = binding;

  return (
    <div className="meridian-transcript-viewport">
      {/*
       * Floats over the top of the scroll container as the tail affordance floats over the
       * bottom; both sit outside the scroll box because a control in the flow changes the
       * content height the reading position is measured against.
       */}
      {props.earlierHistoryControl}
      <div
        className="meridian-transcript-viewport__scroll-container meridian-focus-inset"
        ref={binding.attachScrollContainer}
        // The feed role is claimed only while there are rows, since `feed` requires owned
        // articles (`VirtualRow`'s half) and an empty one is invalid, which is worse for a
        // screen reader than a plain scroll container. The label and busy state go with it.
        {...(snapshot.rows.length === 0
          ? {}
          : {
              role: "feed",
              "aria-label": props.feedLabel,
              "aria-busy": props.hasActiveTurn ?? false,
            })}
        // Focusable so the log is reachable and scrollable from the keyboard.
        tabIndex={0}
      >
        <div
          className="meridian-transcript-viewport__sizer"
          ref={binding.attachSizer}
          role="presentation"
        >
          {binding.virtualItems.map((virtualItem) => {
            const row = snapshot.rows[virtualItem.index];
            return row === undefined ? null : (
              <VirtualRow
                key={virtualItem.key}
                rowIndex={virtualItem.index}
                row={row}
                totalRowCount={snapshot.rows.length}
                renderRow={props.renderRow}
                attachRow={binding.attachRow}
              />
            );
          })}
        </div>
        {/*
         * Empty only once the first read has landed: while it is in flight the pane already
         * draws skeleton rows, and a second element would talk over the loading state.
         */}
        {snapshot.rows.length === 0 && props.firstReadSettled ? <EmptyTranscript /> : null}
      </div>
      <JumpToLatest snapshot={snapshot} onJumpToTail={binding.jumpToTail} />
    </div>
  );
}
