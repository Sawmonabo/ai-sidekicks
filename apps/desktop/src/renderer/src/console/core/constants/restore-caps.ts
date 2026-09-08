// The rollback disclosure's path enumerations: when one windows, how much it shows,
// and the height its first paint asks for before a row has measured itself.

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
