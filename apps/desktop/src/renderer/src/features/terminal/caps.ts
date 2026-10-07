// The terminal feature's bounds, spent by two modules. Two of the numbers are also read by a
// test tier that must not construct an emulator to learn one; the measurement width is spent
// by that tier alone, and lives here so the two files pricing the budget row's halves read one
// number, not two.

/**
 * Lines of scrollback one terminal keeps.
 *
 * A buffer line allocates twelve bytes per cell regardless of content, and the
 * `terminal-instance-memory` budget was measured at this depth, so changing it changes what
 * the budget means.
 */
export const TERMINAL_DEFAULT_SCROLLBACK_LINES = 10_000;

/**
 * Columns a terminal is driven at when the memory budget's halves are measured.
 *
 * A multiplier on the `terminal-instance-memory` figure (twelve bytes per cell), kept at a
 * working width rather than a wide one so the row measures a pane someone is using.
 */
export const TERMINAL_BUDGET_MEASUREMENT_COLUMNS = 120;

/**
 * How many WebGL contexts the page's terminals may create over its life.
 *
 * Chromium keeps sixteen contexts per page and drops the oldest past that, and a disposed
 * addon does not give its context back, so the ceiling counts contexts the page has ever
 * created. Twelve leaves four for the rest of the page. Each pane drawing a shell takes its own
 * context, so past twelve a terminal draws with the DOM renderer.
 */
export const TERMINAL_WEBGL_POOL_CAP = 12;
