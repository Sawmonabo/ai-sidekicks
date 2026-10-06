import { useEffect, useRef, useState } from "react";

import type { Clock } from "#renderer/lib/clock.js";

/**
 * The instant a view draws its times against, in epoch milliseconds: read again when the drawn
 * records change, by identity, and woken once at `nextChangeAt(instant)`, the earliest moment a
 * drawn figure would read differently. A wake-up lands on the later of that moment and the clock's
 * reading, which `roundReading` may round down. One timer at most; with no change ahead
 * (`Infinity`), none.
 */
export function useDrawnInstant(
  clock: Clock,
  drawn: readonly unknown[],
  nextChangeAt: (instant: number) => number,
  roundReading: (now: number) => number = (now) => now,
): number {
  const [reading, setReading] = useState(() => ({ drawn, instant: clock.now() }));
  // New records read the clock again, so one that arrived while no timer was armed is not drawn
  // against an instant that went stale meanwhile. React's state adjusted in render: this pass is
  // thrown away and rendered again with the new reading.
  if (
    reading.drawn.length !== drawn.length ||
    reading.drawn.some((record, index) => record !== drawn[index])
  ) {
    setReading({ drawn, instant: Math.max(reading.instant, clock.now()) });
  }
  const { instant } = reading;
  const wakeAt = nextChangeAt(instant);
  // The caller's rounding, reachable from the effect without re-arming it on every render.
  const roundReadingRef = useRef(roundReading);
  roundReadingRef.current = roundReading;
  useEffect(() => {
    if (wakeAt === Number.POSITIVE_INFINITY) {
      return undefined;
    }
    const handle = clock.scheduleTimeout(
      () => {
        // Never before the deadline, so a wake-up that arrives late, after the host slept,
        // catches up in one step.
        const landedAt = Math.max(wakeAt, roundReadingRef.current(clock.now()));
        setReading((current) => ({ ...current, instant: Math.max(current.instant, landedAt) }));
      },
      Math.max(0, wakeAt - clock.now()),
    );
    return () => {
      clock.cancel(handle);
    };
  }, [clock, wakeAt]);
  return instant;
}
