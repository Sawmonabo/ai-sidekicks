// Named measures the diff pane, renderer and inline card compute with. Nothing is checked
// against them; ceilings live in `features/repos/diff-caps.ts`.

/**
 * The height of one rendered diff row, in CSS pixels. The sheet gives every row this as its
 * minimum height and the virtualizer estimates an unmeasured row at it; a wrapped long line
 * grows its row and reports its measured height.
 */
export const DIFF_ROW_HEIGHT_PX = 20;

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
 * window's estimate as `DIFF_ROW_HEIGHT_PX` is. It is the WCAG 2.2 target-size (2.5.8)
 * minimum, which the entry's padding alone did not reach at this text size.
 */
export const DIFF_FILE_ROW_HEIGHT_PX = 24;
