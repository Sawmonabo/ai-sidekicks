// Which wall-clock deadline to wake at. Crossing a deadline changes what a view says (an upload
// that has gone quiet), so its owner arms one timeout at a time for the earliest deadline still
// ahead. The wake-up publishes an instant and reads nothing, so it is not a refresh
// (`reads/refresh-scheduler.ts`).

/**
 * The soonest deadline still ahead of `nowMilliseconds`, or `undefined`.
 *
 * A deadline already behind needs no wake-up, and a non-finite value is skipped because a timer
 * scheduled against `NaN` fires immediately and forever.
 */
export function earliestFutureDeadline(
  deadlines: readonly number[],
  nowMilliseconds: number,
): number | undefined {
  let earliestMilliseconds: number | undefined;
  for (const deadline of deadlines) {
    if (!Number.isFinite(deadline) || deadline <= nowMilliseconds) {
      continue;
    }
    if (earliestMilliseconds === undefined || deadline < earliestMilliseconds) {
      earliestMilliseconds = deadline;
    }
  }
  return earliestMilliseconds;
}
