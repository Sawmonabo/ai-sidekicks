// One row the seat draws, behind the memo that keeps a frame from redrawing it.
//
// Most of the list's rows are the transcript's own — a run group header, a system message,
// and the named notice of a row the cap took mid-frame — and exactly one arm is the seat's.
// `useTranscriptRowRenderer` does the map reads that pick the arm; this component holds the
// seat's card behind a memo, because drawing it is where a frame's work is.
//
// WHY THE BOUNDARY IS HERE AND NOT ON THE VIEWPORT'S ROW. The viewport already memoizes
// each row's box, and that memo compares the `renderRow` callback — which closes over
// the whole derived window. The window is a new object on every admitted event, so
// the callback's identity moves on every admitted event, so that memo cannot hold
// across one. It was never meant to: the callback is where a row's body is LOOKED UP,
// and a lookup that could not see a changed window would draw a stale card.
//
// So the boundary is drawn one level lower, where the lookups have already happened.
// `renderRow` runs — cheap, and correct — and what it returns for the seat's arm is a
// component whose props are the values the seat is actually handed. React
// compares those and bails out of the body when none of them moved. The row's own memo
// keeps the box; this one keeps the CARD, which is where a frame's work is.
//
// EVERY ONE OF THEM IS IDENTITY-STABLE WHEN NOTHING MOVED, which is what makes the
// comparison meaningful rather than decorative:
//
//   • `row` — held across projections by the window's retention table. Without
//     that this memo would compare a fresh object every event and never hold.
//   • `actorHue` — the store's own assignment object, read and never minted.
//   • `isSuperseded` and `density` — a boolean and a two-value union.
//
// AND THE RENDERER IS THE SEAT'S, handed down from the pane and stable for the life of
// the registration. A caller that rebuilt it per render would move this memo on every
// render, which is the defect `TranscriptFeed.renders.test.tsx` drives one level up.

import { memo } from "react";

import { type TimelineRowFooterRenderer } from "../../transcript-row-footer-renderer.js";
import {
  type TimelineRowRenderer,
  type TimelineRowSlotProps,
} from "../../transcript-row-renderer.js";
import { TranscriptRowFooter } from "./TranscriptRowFooter.js";

/** What one row hands the seat's renderer and the footer seat. */
export interface TranscriptFeedRowProps extends TimelineRowSlotProps {
  /** The seat's renderer. STABLE across renders, or this memo moves with it. */
  readonly renderTimelineRow: TimelineRowRenderer;
  /** The footer seat's renderer, or `undefined` while nobody has filled it. */
  readonly renderTimelineRowFooter: TimelineRowFooterRenderer | undefined;
}

/**
 * Draw one row through the seat.
 *
 * Adds no BOX of its own: the row box, the error boundary and the ARIA position are
 * the viewport's, and a wrapper element here would put a second box between the feed
 * and the article the row role is declared on. The footer is a SIBLING of the body
 * inside that article rather than a wrapper around it, which is why it does not
 * break that rule — and it is drawn under the body because that is where the design
 * puts a row-level control.
 *
 * An ARROW WITH A DECLARED RETURN TYPE rather than a named function expression, so
 * this module resolves as the one component it declares: the one-component rule is
 * read off declarations, and a function
 * EXPRESSION inside `memo(...)` is neither a declaration nor an arrow, so the module
 * would declare none — clean against a rule that was never applied to it.
 */
export const TranscriptFeedRow: React.NamedExoticComponent<TranscriptFeedRowProps> = memo(
  (props: TranscriptFeedRowProps): React.ReactNode => (
    <>
      {props.renderTimelineRow({
        row: props.row,
        actorHue: props.actorHue,
        isSuperseded: props.isSuperseded,
        density: props.density,
      })}
      <TranscriptRowFooter
        row={props.row}
        isSuperseded={props.isSuperseded}
        renderFooter={props.renderTimelineRowFooter}
      />
    </>
  ),
);
TranscriptFeedRow.displayName = "TranscriptFeedRow";
