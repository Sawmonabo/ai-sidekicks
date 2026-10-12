// Bounds for the diff views: file list scrolling, the intraline register, and the largest patch
// handed to the parser.

/**
 * Files a change set may hold before the file list scrolls instead of rendering every row.
 * Past it a person filters rather than scans, so the filter sits above the list.
 */
export const DIFF_FILE_LIST_SCROLL_THRESHOLD = 12;

/**
 * Computed intraline segmentations held before the oldest is dropped. Rows compute intraline
 * on materialization, so scrolling a long change set would otherwise retain one list per
 * changed line. Several screens of scrollback stay cached; retention follows the cap.
 */
export const DIFF_INTRALINE_CACHE_ENTRY_CAP = 512;

/**
 * Characters of a fetched diff payload parsed into a change set. Much larger than the
 * artifact preview bound, which limits what a person is shown at once: the diff views are
 * virtualized, and this bounds the parse itself (linear, on the window's own thread). Past
 * it the create refuses rather than silently dropping the last files.
 *
 * @consumedBy the diff pane's patch read
 */
export const DIFF_PATCH_CHARACTER_CAP = 4_194_304;
