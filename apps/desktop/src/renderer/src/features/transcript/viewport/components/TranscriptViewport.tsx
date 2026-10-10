// The transcript viewport: the virtualized feed with the history line above its first row, the
// reading anchor's pill, and the row box every row body is mounted in. It only turns
// `features/transcript/viewport/controller.ts`'s snapshot into elements; the caller owns the one
// binding, so the find walk and the rows read the same virtualizer. Markup invariants: one scroll
// container (a nested scroller would rival the chokepoint's `scrollTop`); the sizer and each
// row's transform are written by the virtualizer under `directDomUpdates`, so no style here sets
// them; `role="feed"` is declared on the sizer and its article children by `VirtualRow`, so the
// relationship does not rest on whatever a registered row renderer draws, and the history line
// above the sizer is no entry of it. Attention is steered by luminance, never motion: the only
// transition is the pill's hover color. The viewport's one selection tracker lives with the
// scroll container and reaches the rows through context, beside what a long markdown body reads
// to draw only the blocks near the reader.

import { useMemo } from "react";

import { EmptyTranscript } from "./EmptyTranscript.js";
import { VirtualRow, type ViewportRowRenderer } from "./VirtualRow.js";
import { JumpToLatest } from "./JumpToLatest.js";
import { type TranscriptViewportBinding } from "../hooks/useTranscriptViewport.js";
import { useTrackViewportSelection } from "../hooks/selection/useTrackViewportSelection.js";
import { ViewportSelectionTrackerContext } from "../selection/context.js";
import {
  TranscriptBodyViewportContext,
  type TranscriptBodyViewport,
} from "#renderer/components/TranscriptBodyViewport/context.js";

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
  /** Names the feed, and the scroll region holding it, for a screen reader walking the window. */
  readonly feedLabel: string;
  /**
   * Whether this session's first read has settled. Required so a caller decides: the empty
   * window is a claim about a session, and an inherited default would show "Nothing has
   * happened" above the pane's skeleton rows while the read is still in flight.
   */
  readonly firstReadSettled: boolean;
  /** A run is still being written, which marks the log busy for a screen reader. */
  readonly hasActiveTurn?: boolean;
  /**
   * The head control that walks back into the rows before this window's head, drawn above the
   * first row where the caller has a read to give it. Absent, nothing renders at the head.
   */
  readonly earlierHistoryControl?: React.ReactNode;
}

/** The scrolling window over one transcript's rows, with its head and tail affordances. */
export function TranscriptViewport(props: TranscriptViewportProps): React.JSX.Element {
  const { binding } = props;
  const { snapshot } = binding;
  const selection = useTrackViewportSelection(binding.attachScrollContainer);
  const { tracker } = selection;
  const { scrollController, rowStartPx } = binding;
  // One value for the viewport's life: each windowed body holds it while it is mounted.
  const transcriptBodyViewport = useMemo<TranscriptBodyViewport>(
    () => ({
      scrollController,
      rowStartPx,
      subscribeToSelection: (listener) => tracker.subscribe(listener),
      readSelectionRange: () => tracker.selectionRange,
    }),
    [scrollController, rowStartPx, tracker],
  );

  return (
    <ViewportSelectionTrackerContext value={tracker}>
      <TranscriptBodyViewportContext value={transcriptBodyViewport}>
        <div className="meridian-transcript-viewport">
          <div
            className="meridian-transcript-viewport__scroll-container meridian-focus-inset"
            ref={selection.attachScrollContainer}
            // Focusable so the log is reachable and scrollable from the keyboard, and so a region
            // with a name, which is what a screen reader announces when the focus lands on it.
            tabIndex={0}
            role="region"
            aria-label={props.feedLabel}
          >
            {/*
             * In the flow, above the rows: the virtualizer counts its height as the space before
             * the list, and the viewport holds the reader's row when that height changes.
             */}
            {props.earlierHistoryControl === undefined ? null : (
              <div className="meridian-transcript-viewport__head" ref={binding.attachHead}>
                {props.earlierHistoryControl}
              </div>
            )}
            <div
              className="meridian-transcript-viewport__sizer"
              ref={binding.attachSizer}
              // The feed role is claimed only while there are rows, since `feed` requires owned
              // articles (`VirtualRow`'s half) and an empty one is invalid, which is worse for a
              // screen reader than none. The label and busy state go with it. On the row box
              // rather than the scroll container, so the history line above it is no feed entry.
              {...(snapshot.rows.length === 0
                ? { role: "presentation" }
                : {
                    role: "feed",
                    "aria-label": props.feedLabel,
                    "aria-busy": props.hasActiveTurn ?? false,
                  })}
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
      </TranscriptBodyViewportContext>
    </ViewportSelectionTrackerContext>
  );
}
