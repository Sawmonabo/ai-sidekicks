// The diff surfaces' named MEASURES.
//
// Row heights, an overscan count, an expansion unit, and a pre-measurement
// viewport height — the five numbers the diff renderer, the pane, and the inline
// card compute WITH. Nothing is checked against any of them, which is what keeps
// them here: `console/core/constants.ts` is the one home for a CEILING, and the
// diff surfaces' five ceilings sit there and are imported through `core/index.ts`.
// `test/console/architecture/cap-constant-home.test.ts` draws that line and
// enforces it.
//
// One home for the five below all the same, so a number cannot be re-derived
// differently in the pane and in the card, and each rationale says what the number
// is trading against.

/**
 * The height of one rendered diff row, in CSS pixels.
 *
 * Spent twice, and the two spendings are the same number for a reason. The sheet
 * paints every unwrapped row at exactly this height — file header, hunk header,
 * gap, and line are each one line of mono text at the same leading — and the
 * virtualizer takes it as the size it ESTIMATES an unmeasured row at. With wrap
 * off the estimate is therefore exact and nothing is ever measured, which is what
 * keeps the offsets and the painted rows in step to the pixel; with wrap on the
 * sheet releases the height, a long line grows the row, and the rows report their
 * measured heights instead. One value under one owner, so the two cannot drift.
 */
export const DIFF_ROW_HEIGHT_PX = 20;

/**
 * Rows rendered above and below the viewport.
 *
 * Enough that a fast flick does not expose the unrendered band before the next
 * scroll event lands, and small enough that the rendered row count stays a
 * constant multiple of the viewport rather than a fraction of the file. At the
 * row height above this is about two-thirds of a 400 px viewport in each
 * direction.
 */
export const DIFF_WINDOW_OVERSCAN_ROWS = 14;

/**
 * Context lines one activation of a hunk gap reveals.
 *
 * The unit a person reads in: enough to see the surrounding block, few enough
 * that a gap of several hundred lines is not expanded into the viewport by a
 * misclick. Expansion is cumulative — the rows a previous activation revealed
 * stay revealed — so a wider view is reached by pressing again rather than by a
 * second control.
 */
export const DIFF_GAP_EXPANSION_LINE_COUNT = 20;

/**
 * The viewport height the renderer assumes before its container has been
 * measured.
 *
 * A first paint happens before any layout callback runs, so the window has to be
 * computed against something — the virtualizer's `initialRect`, which its own
 * rect observer replaces on the next tick. Deliberately generous rather than
 * minimal: too small and the first frame paints a short strip that grows a beat
 * later, which reads as a paint that did not finish. Too large costs one frame of
 * extra rows and nothing else, which is the cheaper error.
 */
export const DIFF_VIEWPORT_FALLBACK_HEIGHT_PX = 640;

/**
 * The height of one changed-file entry, in CSS pixels.
 *
 * Spent twice, as `DIFF_ROW_HEIGHT_PX` is and for the same reason: the sheet paints
 * every entry at exactly this height and the window takes it as the size it estimates
 * an unmeasured row at, so the offsets and the painted rows stay in step to the pixel
 * with nothing measured. The figure is WCAG 2.2's 2.5.8 target size — a row in a dense
 * list is still a pointer target, and this list is the diff pane's only way to move
 * between files — which the entry's padding alone did not reach at this text size.
 */
export const DIFF_FILE_ROW_HEIGHT_PX = 24;
