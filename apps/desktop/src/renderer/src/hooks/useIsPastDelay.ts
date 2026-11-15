import { useEffect, useState } from "react";

import type { Clock } from "#renderer/lib/clock.js";

/**
 * Whether `delayMs` has run out on `clock` since the clock was handed in: one timer, armed while a
 * clock is given and canceled when it is taken back or changes, so several lines can read one
 * delay. `undefined` arms nothing and reads `false`, and a clock handed in again starts over.
 */
export function useIsPastDelay(clock: Clock | undefined, delayMs: number): boolean {
  const [isPastDelay, setIsPastDelay] = useState(false);
  useEffect(() => {
    if (clock === undefined) {
      return undefined;
    }
    const handle = clock.scheduleTimeout(() => {
      setIsPastDelay(true);
    }, delayMs);
    return () => {
      clock.cancel(handle);
      setIsPastDelay(false);
    };
  }, [clock, delayMs]);
  return clock !== undefined && isPastDelay;
}
