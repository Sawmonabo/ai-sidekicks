import { useDrawnInstant } from "#renderer/hooks/useDrawnInstant.js";
import type { Clock } from "#renderer/lib/clock.js";
import { ageChangesAt } from "#renderer/lib/wire/figures.js";

/**
 * The instant a list draws its rows' ages against, woken only when one of `stamps` would read
 * differently through `formatAge`, so every age on the list advances on the same beat. One timer
 * at most; with no stamps, none.
 */
export function useAgesNow(clock: Clock, stamps: readonly string[]): number {
  return useDrawnInstant(clock, stamps, (instant) =>
    stamps.reduce(
      (earliest, stamp) => Math.min(earliest, ageChangesAt(stamp, instant)),
      Number.POSITIVE_INFINITY,
    ),
  );
}
