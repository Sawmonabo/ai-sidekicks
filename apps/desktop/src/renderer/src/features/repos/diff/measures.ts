// Named measures the diff pane, renderer and inline card compute with. Nothing is checked
// against them; ceilings live in `features/repos/diff/caps.ts`.

import { scaleStep } from "#renderer/styles/palette.js";
import { BODY_LINE_HEIGHT, TYPE_SCALE_REM } from "#renderer/styles/typography.js";

/**
 * The height of one rendered diff row, in rem: one `text-12` line box at the body line height, so
 * it follows `Text size`. The sheet gives every row this as its line height and minimum height and
 * a window estimates an unmeasured row at it; a wrapped long line grows its row and reports its
 * measured height.
 */
export const DIFF_ROW_HEIGHT_REM: number = scaleStep(TYPE_SCALE_REM, "text-12") * BODY_LINE_HEIGHT;

/**
 * Rows rendered above and below the viewport. Enough that a fast flick does not expose the
 * unrendered band, small enough that the rendered count stays a multiple of the viewport.
 */
export const DIFF_WINDOW_OVERSCAN_ROWS = 14;

/**
 * Context lines one activation of a hunk gap reveals. Expansion is cumulative, so a wider
 * view is reached by pressing again; a gap of hundreds of lines is not opened by a misclick.
 */
export const DIFF_GAP_EXPANSION_LINE_COUNT = 20;

/**
 * The viewport height assumed before the container is measured, used as the virtualizer's
 * `initialRect`. Generous on purpose: too small paints a short strip that grows a beat
 * later, too large costs one frame of extra rows.
 */
export const DIFF_VIEWPORT_FALLBACK_HEIGHT_PX = 640;

/**
 * The height of one changed-file entry, in CSS pixels, used for painting and for the
 * window's estimate as `DIFF_ROW_HEIGHT_REM` is. It is the WCAG 2.2 target-size (2.5.8)
 * minimum, which the entry's padding alone did not reach at this text size.
 */
export const DIFF_FILE_ROW_HEIGHT_PX = 24;

/** How much of the visible flow a diff block's rows take before its cut: one part in this many. */
export const DIFF_FLOW_SHARE_DIVISOR = 3;

/** How many screens of the flow a call's diff blocks fill before its other files fold. */
export const DIFF_FLOW_FILE_BLOCK_SCREENS = 2;

/** The fewest figures a line-number gutter is wide, so a short change's numbers still align. */
export const DIFF_GUTTER_MIN_DIGITS = 2;

/**
 * Rows one task mounts while a block opens whole past what the flow shows: few enough that a
 * task stays inside one frame on a slow machine, many enough that the rows land faster than a
 * person scrolls to them.
 */
export const DIFF_FLOW_FILL_STEP_ROWS = 48;
