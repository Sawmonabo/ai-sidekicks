// The restore enumerations' named bounds, and the one window height derived from them.
//
// `console/core/constants.ts` states the rule and the split: every cap, window, and
// timeout is a named constant with a one-line rationale, and "each view family adds its
// own module beside its subtree rather than widening this one, so a bound always sits
// next to the code that spends it". This is that module for the rollback disclosure's
// two path enumerations, on `repos/artifact-pane/artifact-bounds.ts`'s precedent.
//
// ALL FOUR AND NOT THREE. The three below sat in `core/constants.ts` while the value
// derived from two of them sat in `repos/restore/restore-path-window.ts`, so one
// window's arithmetic was stated across two homes while the block they sat in said they
// "are read together … so they sit together". Their only readers are the four modules in
// this directory, which is exactly the case that placement rule sends here.

/**
 * Paths one open enumeration renders in full before it windows instead.
 *
 * Below the bound the whole list is shorter than the window a scroll container
 * would give it, so windowing would add a scrollbar, a focus stop, and a measured
 * row for no reduction in nodes. At and above it the list is longer than any pane
 * is tall, and every row past the fold is a node nobody has looked at yet.
 */
export const RESTORE_PATH_VIRTUALIZATION_THRESHOLD = 50;

/**
 * Rows one windowed enumeration shows at once.
 *
 * A dozen paths is enough to read a group of them as a group — which is what an
 * operator is doing when they open this list at all — while keeping the container
 * short enough that the disclosure it sits inside does not become the whole pane.
 */
export const RESTORE_PATH_VISIBLE_ROW_CAP = 12;

/**
 * The height one path row is estimated at, in CSS pixels.
 *
 * An ESTIMATE and not a contract: rows measure themselves once rendered, so a
 * wrapped path is placed at the height it turned out to be. It is here because the
 * window's own height cap is this times the visible-row cap, and a first paint
 * happens before any row has been measured — so the estimate is what decides how
 * many rows that first paint asks for.
 */
export const RESTORE_PATH_ROW_HEIGHT_PX = 20;

/** The tallest a windowed enumeration's scroll container may grow, in CSS pixels. */
export const RESTORE_PATH_WINDOW_MAX_BLOCK_SIZE_PX: number =
  RESTORE_PATH_VISIBLE_ROW_CAP * RESTORE_PATH_ROW_HEIGHT_PX;
