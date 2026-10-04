// Where the window size on a `usage.context_window_update` row came from: the closed set both the
// daemon and the renderer read.

/**
 * Where a context window's figures came from: the provider reported them, or the window is the
 * model's declared default. The set is closed.
 */
export const CONTEXT_WINDOW_SOURCES = ["provider_reported", "model_default"] as const;

/** One context-window source. Derived, so the vocabulary has exactly one home. */
export type ContextWindowSource = (typeof CONTEXT_WINDOW_SOURCES)[number];
