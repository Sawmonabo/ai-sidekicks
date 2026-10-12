// The two ends of a scroller's window, which the transcript's window, its reading anchor and its
// history reader each name a side by, and how far past each end the drawn band reaches, which
// every window nested in a conversation row draws its items within.

/** An end of the window: `head` toward the log's first row, `tail` toward its last. */
export type WindowSide = "head" | "tail";

/** The band beyond each edge of the viewport, in screen heights. */
export type DrawnBandScreenHeights = Readonly<Record<WindowSide, number>>;
