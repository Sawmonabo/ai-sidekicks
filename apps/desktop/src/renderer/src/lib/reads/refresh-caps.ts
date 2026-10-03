// Timing windows for the refresh scheduler and for store apply coalescing.

/**
 * Trailing debounce on the refresh scheduler: long enough that a burst of events costs one
 * read, short enough that a person does not perceive the lag.
 */
export const REFRESH_DEBOUNCE_MS = 120;

/**
 * Absolute deadline from the first event of a burst. The scheduler fires at
 * `min(lastEvent + REFRESH_DEBOUNCE_MS, firstEvent + REFRESH_MAX_WAIT_MS)`, so a continuous
 * stream cannot starve the trailing debounce forever.
 */
export const REFRESH_MAX_WAIT_MS = 1000;

/**
 * Coalescing window for store applies: one animation frame at 60 Hz. Events arriving inside it
 * produce one notification, so four streaming lanes cost one render rather than four.
 */
export const APPLY_COALESCE_MS = 16;
