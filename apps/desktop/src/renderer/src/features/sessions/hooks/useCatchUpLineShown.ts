import { useEffect, useState } from "react";

import { type Clock } from "@renderer/lib/clock.js";

/**
 * How long the window has to be behind before the catching-up line appears, and how
 * long the line stays once it has. One figure for both, so a repair that closes quickly
 * shows nothing and a line that does appear never flickers.
 */
export const CATCH_UP_LINE_DWELL_MS = 400;

/**
 * Whether the catching-up line is up.
 *
 * It goes up once the window has been behind for the dwell, and comes down when the
 * window has caught up and the line has stood for the dwell. Each edge arms one timeout
 * on the window's clock and nothing re-arms while the line holds still, so nothing
 * polls.
 */
export function useCatchUpLineShown(isBehind: boolean, clock: Clock): boolean {
  const [shownSinceMilliseconds, setShownSinceMilliseconds] = useState<number | undefined>(
    undefined,
  );
  useEffect(() => {
    if (isBehind && shownSinceMilliseconds === undefined) {
      const handle = clock.scheduleTimeout(() => {
        setShownSinceMilliseconds(clock.now());
      }, CATCH_UP_LINE_DWELL_MS);
      return () => {
        clock.cancel(handle);
      };
    }
    if (!isBehind && shownSinceMilliseconds !== undefined) {
      const handle = clock.scheduleTimeout(
        () => {
          setShownSinceMilliseconds(undefined);
        },
        Math.max(0, shownSinceMilliseconds + CATCH_UP_LINE_DWELL_MS - clock.now()),
      );
      return () => {
        clock.cancel(handle);
      };
    }
    return undefined;
  }, [isBehind, shownSinceMilliseconds, clock]);
  return shownSinceMilliseconds !== undefined;
}
