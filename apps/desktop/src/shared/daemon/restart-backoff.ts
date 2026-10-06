// The waits main holds between starts of the background service, which the renderer's re-opens of
// its daemon streams follow, so a stream is not opened faster than the service comes back.

/**
 * The waits before each start after a loss or a failed start, in milliseconds. Their count is the
 * number of failed starts in a row after which main stops trying and reports the service degraded.
 */
export const SERVICE_START_BACKOFF_MS: readonly number[] = [100, 300, 1_000, 3_000, 10_000];
