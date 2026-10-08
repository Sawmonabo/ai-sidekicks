// The daemon's one schedule of waits between the tries of a step that failed for a passing cause,
// such as a reader holding the database busy; each wait doubles the one before.

const LONGEST_RETRY_WAIT_MS = 32_000;

/**
 * The waits, in milliseconds, before each retry: seven tries over 63 s. A step that must end gives
 * up after the last wait.
 */
export const RETRY_WAITS_MS: readonly number[] = [
  1_000,
  2_000,
  4_000,
  8_000,
  16_000,
  LONGEST_RETRY_WAIT_MS,
];

/**
 * The wait, in milliseconds, before the retry that follows `failedTries` failures in a row, for a
 * step that never gives up: the schedule's, then its longest.
 */
export function retryWaitMs(failedTries: number): number {
  return RETRY_WAITS_MS[failedTries] ?? LONGEST_RETRY_WAIT_MS;
}
