// One row the row renderer draws, behind the memo that keeps a frame from redrawing it. The
// viewport's row memo cannot hold, since its `renderRow` callback closes over a window that is new
// on every admitted event; the boundary is drawn lower, so React compares the props the row
// renderer is handed and bails out of the card when none moved.

import { memo } from "react";

import {
  type TranscriptRowRenderer,
  type TranscriptRowProps,
} from "../../transcript-row-renderer.js";

/** What one row hands the row renderer. */
export interface TranscriptFeedRowProps extends TranscriptRowProps {
  /** The registered row renderer. STABLE across renders, or this memo moves with it. */
  readonly renderTranscriptRow: TranscriptRowRenderer;
}

/**
 * Draw one row through the row renderer. It adds no box of its own: the row box, error boundary
 * and ARIA position are the viewport's. Every prop is identity-stable when nothing moved: `row`
 * is held by the window's retention table and `actorHue` is the store's own assignment object.
 *
 * An arrow with a declared return type rather than a function expression inside `memo(...)`,
 * so this module resolves as the one component it declares.
 */
export const TranscriptFeedRow: React.NamedExoticComponent<TranscriptFeedRowProps> = memo(
  (props: TranscriptFeedRowProps): React.ReactNode =>
    props.renderTranscriptRow({
      row: props.row,
      actorHue: props.actorHue,
      isSuperseded: props.isSuperseded,
      density: props.density,
    }),
);
TranscriptFeedRow.displayName = "TranscriptFeedRow";
