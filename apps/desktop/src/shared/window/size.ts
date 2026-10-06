// A window's sizes as the renderer hands them to main.

/** A window's size, in CSS pixels. */
export interface WindowSize {
  readonly width: number;
  readonly height: number;
}

/**
 * The widths a pane's own window with no kept place opens at, which the renderer reads from its
 * tokens, keyed by the pane kind as its frame name carries it.
 */
export interface WindowDefaultSizes {
  readonly paneWidths: Readonly<Record<string, number>>;
}
