// The transcript viewport's named figures: how much of the log the window holds and draws, in
// screen heights of its own viewport, and the measures the viewport spends. The scroll
// chokepoint's are in `lib/scroll/`, the reveal engine's in `../reveal/caps.ts`.

/**
 * How much of the log one admission brings into the window, in screen heights.
 *
 * A screen height is the viewport's own height, never a count of rows, so a short pane and a tall
 * one each hold the same number of screens however tall their rows are.
 */
export const TRANSCRIPT_STRETCH_SCREEN_HEIGHTS = 3;

/**
 * How near an edge of the window the reader comes, in screen heights, before the next stretch
 * beyond that edge is admitted.
 */
export const TRANSCRIPT_APPROACH_SCREEN_HEIGHTS = 2;

/**
 * How far from the reading position the window keeps rows on each side, in screen heights: the
 * approach distance plus one stretch.
 *
 * An admission happens with the edge at most the approach distance away and moves it one stretch
 * further, so a share any smaller would let go, on the same pass, rows the admission just brought.
 */
export const TRANSCRIPT_RETAINED_SCREEN_HEIGHTS: number =
  TRANSCRIPT_APPROACH_SCREEN_HEIGHTS + TRANSCRIPT_STRETCH_SCREEN_HEIGHTS;

/**
 * How far an edge of the window must sit from the reading position, in screen heights, before the
 * rows past the retained share on that side are let go: the retained share plus one stretch.
 *
 * The gap between this and the retained share is the hysteresis. A cut takes about a stretch at
 * once, and a window whose edge sits exactly where an admission left it is never cut by a height
 * estimate that moved, so admitting and letting go never trade the same rows back and forth.
 */
export const TRANSCRIPT_LET_GO_SCREEN_HEIGHTS: number =
  TRANSCRIPT_RETAINED_SCREEN_HEIGHTS + TRANSCRIPT_STRETCH_SCREEN_HEIGHTS;

/**
 * The rows drawn beyond each edge of the viewport, in screen heights.
 *
 * Drawn ahead of the reader, so a fast scroll meets rows already measured rather than a blank band.
 * Measured in pixels from the viewport's own height, so a pane of short rows draws as far ahead as
 * a pane of tall ones.
 */
export const TRANSCRIPT_DRAWN_BAND_SCREEN_HEIGHTS = 1;

/**
 * How far the drawn band widens beyond each edge of the viewport per task after a land, in screen
 * heights.
 *
 * A land (a page at the head, a landing on a row or the tail, the opening) draws only the rows on
 * screen in its own task, then the band grows by this much a task until it reaches
 * `TRANSCRIPT_DRAWN_BAND_SCREEN_HEIGHTS`, so no one task mounts a whole band beside the land.
 */
export const TRANSCRIPT_BAND_WIDENING_SCREEN_HEIGHTS = 0.5;

/**
 * The pause between two of the reader's scroll samples, in milliseconds, that ends one gesture and
 * starts the next.
 *
 * Compared against the samples' scroll-event time stamps, never armed. A wheel or a fling delivers
 * a sample every frame while it moves, so a pause of several frames is a hand that let go; one
 * gesture admits at most one stretch, so a fling brings a stretch and not the whole log. A scroll
 * sample this soon after the reader's wheel, key or touch is that input's, which is what lets it
 * end following.
 */
export const TRANSCRIPT_GESTURE_GAP_MS = 150;

/**
 * How long the transcript must have been still for the next activity to trim first, in
 * milliseconds.
 *
 * Compared against the clock, never armed: `idle-trim.ts` runs on the first activity after the
 * gap because an idle frame arms no timer. Two minutes is longer than every pause inside ordinary
 * reading (scrolling back, a long tool result, checking another window) and short enough that
 * the pause after a working session returns what it accumulated.
 */
export const TRANSCRIPT_IDLE_TRIM_DWELL_MS = 120_000;
