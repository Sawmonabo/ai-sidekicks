import { useDrawnInstant } from "#renderer/hooks/useDrawnInstant.js";
import type { Clock } from "#renderer/lib/clock.js";
import { relativeTimeChangesAt } from "#renderer/lib/wire/figures.js";

/**
 * The instant a view draws its relative times against, woken only when one of `stamps` would read
 * differently through `formatRelativeTime`, `2 minutes ago` becoming `3 minutes ago`. One timer at
 * most; with no stamps, none.
 */
export function useRelativeTimesNow(clock: Clock, stamps: readonly string[]): number {
  return useDrawnInstant(clock, stamps, (instant) =>
    stamps.reduce(
      (earliest, stamp) => Math.min(earliest, relativeTimeChangesAt(stamp, instant)),
      Number.POSITIVE_INFINITY,
    ),
  );
}
