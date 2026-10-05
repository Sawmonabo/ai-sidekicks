// Which wall-clock deadline to wake at. Crossing a deadline changes what a view says (an upload
// that has gone quiet, a link code that has expired), so its owner arms one timeout at a time for
// the earliest deadline still ahead, as `hooks/useDeadlineWake.ts` does. The wake-up publishes an
// instant and reads nothing, so it is not a refresh (`reads/refresh-scheduler.ts`).

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

/**
 * The latest deadline at or behind `nowMilliseconds`, or `undefined`.
 *
 * The catch-up half of the rule above: a late wake-up has usually crossed several deadlines, and
 * publishing only the earliest settles one boundary per render, which can reach React's
 * nested-update limit after a long sleep. The result is always a deadline from the caller's list.
 */
export function latestPassedDeadline(
  deadlines: readonly number[],
  nowMilliseconds: number,
): number | undefined {
  let latestMilliseconds: number | undefined;
  for (const deadline of deadlines) {
    if (!Number.isFinite(deadline) || deadline > nowMilliseconds) {
      continue;
    }
    if (latestMilliseconds === undefined || deadline > latestMilliseconds) {
      latestMilliseconds = deadline;
    }
  }
  return latestMilliseconds;
}
