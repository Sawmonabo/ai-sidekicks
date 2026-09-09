// The terminal family's bounds.

// Spent by three different modules under `console/terminal/`, and two of them are
// also read by a test tier that must not construct an emulator to learn a number.
// One of them is spent by that tier ALONE — the width a terminal is measured at —
// and it lives here rather than beside the harness because the budget row's meaning
// depends on it exactly as it depends on the scrollback depth below, and the two
// files that price the row's two halves have to read one number, not two.

/**
 * Lines of scrollback one terminal keeps.
 *
 * `Spec-023 §Console Libraries` records that a buffer line eagerly allocates twelve
 * bytes per cell regardless of content, and §Budgets bounds one pane's retained
 * memory. Ten thousand lines at a working width is the figure that budget was
 * measured at, so moving this moves what the budget means.
 */
export const TERMINAL_DEFAULT_SCROLLBACK_LINES = 10_000;

/**
 * Columns a terminal is driven at when this budget's halves are measured.
 *
 * A buffer line allocates twelve bytes per cell eagerly, so the width is a
 * multiplier on everything the `terminal-instance-memory` row bounds — changing it
 * changes the figure without changing a line of the code being measured. A working
 * width rather than a wide one: the row bounds a terminal someone is using, and a
 * width chosen to make the number small would be measuring a different pane.
 */
export const TERMINAL_BUDGET_MEASUREMENT_COLUMNS = 120;

/**
 * How many terminals may hold a WebGL renderer at once.
 *
 * Chromium keeps sixteen contexts per page and drops the oldest past that, and a
 * disposed addon does not give its context back — so the ceiling is not "how many
 * terminals are open" but "how many contexts this page has ever created". Twelve
 * leaves four for the rest of the page and still covers every layout V1 ships,
 * since 8.8 gives a session exactly one shared shell.
 */
export const TERMINAL_WEBGL_POOL_CAP = 12;

/**
 * How many lease transitions the ledger keeps.
 *
 * The lease changes hands a handful of times in a working session, and the
 * disclosure that renders them is read to answer "who had it, and why did it
 * move" — a question the recent past answers. Bounded rather than unbounded
 * because this list is rebuilt on every fold, and an unbounded one would grow
 * with the session's whole log for a panel that shows the last few lines.
 */
export const TERMINAL_LEASE_LEDGER_CAP = 32;
