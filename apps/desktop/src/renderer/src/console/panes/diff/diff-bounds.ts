// The diff surfaces' named bounds.
//
// `console/core/constants.ts` states the rule and the split: every cap, window,
// and timeout is a named constant with a one-line rationale, and "each view
// family adds its own module beside its subtree rather than widening this one, so
// a bound always sits next to the code that spends it". This is that module for
// the diff renderer, the pane, and the inline card — three spenders, one home, so
// a number cannot be re-derived differently in the pane and in the card.
//
// Every bound here is a MEASURE, not a preference: each one is spent by a
// computation whose result changes when it changes, and each rationale says what
// the number is trading against.

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
 * How tall an inline diff card is before it offers to grow.
 *
 * `Spec-023 §Meridian, the design language` rule 7 puts diff cards in the timeline at
 * "a height cap and then offer 'show all'", and `InlineDiffCard.tsx` has the card open
 * EXPANDED to that cap rather than collapsed. The figure is about fifteen rows —
 * a hunk's worth of reading, which is what makes the card useful in place — while
 * still leaving the turn that produced it visible above and below.
 */
export const INLINE_DIFF_CARD_HEIGHT_CAP_PX = 300;

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
 * Files a change set may hold before the file list virtualizes rather than
 * rendering every row.
 *
 * The file list is a different scroller from the row list and is bounded by the
 * change set rather than by the diff's line count, so it gets its own bound. Past
 * this the list is long enough that a person filters instead of scanning, which
 * is why the filter sits above it and not behind a disclosure.
 */
export const DIFF_FILE_LIST_SCROLL_THRESHOLD = 12;

/**
 * The longest line an intraline word diff is computed for, in characters.
 *
 * jsdiff's word diff is O(n·m) in TOKENS, so the cost of one pair grows with the
 * PRODUCT of the two lines' lengths and not with their sum. A line past this bound is
 * a minified bundle, a vendored data row, or a lockfile entry — text a word-level
 * highlight does not help anybody read — and computing one costs more than the whole
 * rest of the change set: a single 18,889-character pair inside a 5,000-line patch
 * measured 831 ms on its own (2026-09-02). Past the bound the row keeps its whole-line
 * highlight and says so, rather than the renderer stalling on it.
 */
export const DIFF_INTRALINE_LINE_CHARACTER_CAP = 2_000;

/**
 * The largest product of a pair's two line lengths an intraline diff is computed for.
 *
 * The cap above bounds ONE line; this one bounds the pair, which is what the algorithm
 * is actually quadratic in — two 1,000-character lines are each admissible and their
 * comparison is not. Stated as the product rather than as a second length so the bound
 * is the same quantity the cost is.
 */
export const DIFF_INTRALINE_PAIR_CHARACTER_PRODUCT_CAP = 1_000_000;

/**
 * Computed intraline segmentations held before the oldest is dropped.
 *
 * Intraline is computed when a row is materialised, so a reader who scrolls a
 * five-thousand-line change set end to end would otherwise accumulate one segment list
 * per changed line and hold them for as long as the diff is open. A viewport plus its
 * overscan is tens of rows; this holds several screens of scrollback, so scrolling back
 * up is free while retention stays a function of the cap rather than of the diff.
 */
export const DIFF_INTRALINE_CACHE_ENTRY_CAP = 512;
