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
 * A fixed row height rather than a measured one, and that is the design decision
 * this file's virtualization rests on: measured rows need a `ResizeObserver` per
 * row and a re-layout pass whenever one settles, which is the cost the console's
 * frame budget cannot absorb over a forty-file change set. Every row this family
 * renders — file header, hunk header, gap, and line — is one line of mono text at
 * the same leading, so the height is a fact rather than an estimate, and a long
 * line overflows horizontally (or wraps into its own scroller) instead of growing
 * the row.
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
 * `Spec-023 §Console Design (Meridian)` rule 7 puts diff cards in the timeline at
 * a height cap with "show all" behind it, and §10.6 requires the card to open
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
 * computed against something. Deliberately generous rather than minimal: too
 * small and the first frame paints a short strip that grows a beat later, which
 * reads as a paint that did not finish. Too large costs one frame of extra rows
 * and nothing else, which is the cheaper error.
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
