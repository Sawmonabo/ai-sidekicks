// The command palette's list bounds, beside the registry and the ranking that read them.

/** Commands the palette remembers. Enough to cover a working session's rhythm. */
export const COMMAND_PALETTE_RECENTS_CAP = 8;

/**
 * Ranked results the palette renders at once. The list is keyboard-walked, so
 * past this a person is scrolling rather than choosing and should refine instead.
 */
export const COMMAND_PALETTE_RESULT_CAP = 40;
