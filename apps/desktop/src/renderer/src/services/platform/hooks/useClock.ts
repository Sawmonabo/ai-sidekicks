import { useLayoutEffect, useState } from "react";

import { type Clock } from "@renderer/lib/clock.js";
import { ForwardingClock } from "@renderer/lib/forwarding-clock.js";
import { useReadyBridgeResolution } from "./useBridgeResolution.js";

/**
 * The clock the resolved bridge's window runs on.
 *
 * Under the fixture it is the scenario engine's frozen clock, the only clock the renderer
 * reads: a store keeping its own `RealClock` would run refresh deadlines on wall time while
 * scenario beats advanced on frozen time, so a capture taken right after `advance()` could
 * land on either side of a drain. A live window resolves one `RealClock`.
 *
 * It moves with the bridge, so a resource keyed on the bridge is built on that bridge's
 * clock. A component that needs one identity across a bridge replacement takes
 * {@link useClock}.
 */
export function useBridgeClock(): Clock {
  return useReadyBridgeResolution().clock;
}

/**
 * The clock this window runs on, as one identity for the life of the mount.
 *
 * The pin is a `ForwardingClock` rather than a reading, because the provider replaces its
 * resolution in place with no remount: its methods answer from whichever clock the window
 * holds now, and its `cancel` routes to the clock that armed the work. The clock is handed
 * over from the layout phase, so every passive effect of a commit reads the clock that
 * commit resolved.
 */
export function useClock(): Clock {
  const bridgeClock = useBridgeClock();
  const [clock] = useState(() => new ForwardingClock(bridgeClock));
  useLayoutEffect(() => {
    clock.holdClock(bridgeClock);
  }, [clock, bridgeClock]);
  return clock;
}
