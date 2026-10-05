// A window's sizes as the renderer hands them to main.

/** A window's size, in CSS pixels. */
export interface WindowSize {
  readonly width: number;
  readonly height: number;
}

/**
 * The widths a window with no kept place opens at, which the renderer sums from tokens: a window
 * of session views (its floor and one side pane's default width), and each pane kind's own
 * window, keyed by the pane kind as its frame name carries it.
 */
export interface WindowDefaultSizes {
  readonly consoleWindowWidth: number;
  readonly paneWidths: Readonly<Record<string, number>>;
}
