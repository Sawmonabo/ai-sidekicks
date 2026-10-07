// The kinds of height a row of the transcript's list can take before it is measured, and the
// height each kind starts from. A kind splits the row kinds `kind.ts` names where cards of one
// kind differ in height by more than their text (a tool row by its density), and adds the rows
// the feed draws itself: a run group's header, a system message and the line a row the window no
// longer holds draws. Each seed is built from the type and space scales, so it moves with them.

import {
  BODY_LINE_HEIGHT,
  READING_LINE_HEIGHT,
  TYPE_SCALE_REM,
} from "#renderer/styles/typography.js";
import { SPACE_SCALE_REM, TRANSCRIPT_ROW_GAP_REM, scaleStep } from "#renderer/styles/palette.js";

/** Every kind of height a transcript list row can take. Closed. */
export const ROW_HEIGHT_KINDS = [
  "user-message",
  "agent-message",
  "thinking",
  "tool-call-collapsed",
  "tool-call-expanded",
  "system-message",
  "run-group-header",
  "not-loaded",
] as const;

/** One row height kind. Derived from the enumeration, never restated. */
export type RowHeightKind = (typeof ROW_HEIGHT_KINDS)[number];

/** One line of a row's body: `text-sm` at the reading line height. */
const READING_LINE_REM = scaleStep(TYPE_SCALE_REM, "text-sm") * READING_LINE_HEIGHT;

/** An author's name in a row's gutter: `text-sm` at the body line height. */
const AUTHOR_LINE_REM = scaleStep(TYPE_SCALE_REM, "text-sm") * BODY_LINE_HEIGHT;

/** A time figure: `text-xs` at the body line height. */
const FIGURE_LINE_REM = scaleStep(TYPE_SCALE_REM, "text-xs") * BODY_LINE_HEIGHT;

/** The gutter of a row that names its author: the author over the time. */
const AUTHORED_GUTTER_REM = AUTHOR_LINE_REM + FIGURE_LINE_REM;

/**
 * The height each kind is estimated at before any row of it is measured, in rem: what its card
 * lays out at the type and space scales with a typical amount of text. Every row pads half the
 * one row gap above and below, so each seed carries one gap.
 */
export const ROW_HEIGHT_SEED_REM: Readonly<Record<RowHeightKind, number>> = {
  // Two lines of message beside the author and time.
  "user-message": Math.max(AUTHORED_GUTTER_REM, 2 * READING_LINE_REM) + TRANSCRIPT_ROW_GAP_REM,
  // Six lines of reply over the foot that carries its time, half a gap below the body.
  "agent-message":
    6 * READING_LINE_REM + TRANSCRIPT_ROW_GAP_REM / 2 + FIGURE_LINE_REM + TRANSCRIPT_ROW_GAP_REM,
  // Two lines of reasoning, a `space-2` apart from its control.
  thinking: 2 * READING_LINE_REM + scaleStep(SPACE_SCALE_REM, "space-2") + TRANSCRIPT_ROW_GAP_REM,
  // One line of tool header, shorter than the gutter beside it.
  "tool-call-collapsed": Math.max(AUTHORED_GUTTER_REM, READING_LINE_REM) + TRANSCRIPT_ROW_GAP_REM,
  // The header line over six lines of output.
  "tool-call-expanded": 7 * READING_LINE_REM + TRANSCRIPT_ROW_GAP_REM,
  // One line naming the act, beside the time alone.
  "system-message": Math.max(FIGURE_LINE_REM, READING_LINE_REM) + TRANSCRIPT_ROW_GAP_REM,
  // One line of header, padded by half a gap above and below.
  "run-group-header": AUTHOR_LINE_REM + TRANSCRIPT_ROW_GAP_REM,
  // One line of body text with no row padding around it.
  "not-loaded": scaleStep(TYPE_SCALE_REM, "text-md") * BODY_LINE_HEIGHT,
};
