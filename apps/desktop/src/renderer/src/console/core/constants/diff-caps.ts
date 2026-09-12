// The diff surfaces' bounds: the inline card's height, the file list's fold, the two
// intraline cost bounds, its cache, and the largest patch the parser is handed.

/**
 * How tall an inline diff card is before it offers to grow.
 *
 * A diff card in the timeline gets a height cap and then offers "show all", and
 * `InlineDiffCard.tsx` has the card open EXPANDED to that cap rather than collapsed. The
 * figure is about fifteen rows — a hunk's worth of reading, which is what makes the card
 * useful in place — while still leaving the turn that produced it visible above and
 * below.
 */
export const INLINE_DIFF_CARD_HEIGHT_CAP_PX = 300;

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

/**
 * Characters of a fetched diff payload the console will parse into a change set.
 *
 * A DIFFERENT BOUND FROM THE ARTIFACT PREVIEW BELOW, AND DELIBERATELY MUCH LARGER. That
 * one bounds how much of a payload a person is SHOWN at once, so a screenful and a half
 * is the right size for it. This one bounds what the parser is handed, and the diff
 * surfaces are virtualized: a five-thousand-line change set renders a viewport's worth
 * of rows however long it is, so cutting the patch at preview size would throw away
 * files a reader can reach rather than text nobody would read.
 *
 * What it is protecting against is the parse itself, which is linear in the patch and
 * happens on the window's own thread. Four megabytes is far past any review a person
 * performs in one sitting — the largest patches in this repository's own history are
 * two orders of magnitude smaller — and a payload past it is a generated artifact rather
 * than a change set. Past the bound the create refuses and says so, because a diff
 * silently missing its last files is worse than one that did not render: the files it
 * dropped are exactly the ones a reader would not know to look for.
 */
export const DIFF_PATCH_CHARACTER_CAP = 4_194_304;
