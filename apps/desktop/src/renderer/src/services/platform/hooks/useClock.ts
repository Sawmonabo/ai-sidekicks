import { useLayoutEffect, useState } from "react";

import { type Clock } from "@renderer/lib/clock.js";
import { ForwardingClock } from "@renderer/lib/forwarding-clock.js";
import { useReadyBridgeResolution } from "./useBridgeResolution.js";

/**
 * The clock the resolved bridge's window runs on. Under the fixture it is the scenario engine's
 * frozen clock, so a store cannot run refresh deadlines on wall time while beats advance on frozen
 * time; a live window resolves one `RealClock`. It moves with the bridge, so a component that
 * needs one identity across a bridge replacement takes {@link useClock}.
 */
export function useBridgeClock(): Clock {
  return useReadyBridgeResolution().clock;
}

/**
 * The clock this window runs on, as one identity for the life of the mount. The pin is a
 * `ForwardingClock` because the provider replaces its resolution in place with no remount: it
 * answers from the current clock and routes `cancel` to the clock that armed the work. It is
 * handed over in the layout phase, so every passive effect reads the clock that commit resolved.
 */
export function useClock(): Clock {
  const bridgeClock = useBridgeClock();
  const [clock] = useState(() => new ForwardingClock(bridgeClock));
  useLayoutEffect(() => {
    clock.holdClock(bridgeClock);
  }, [clock, bridgeClock]);
  return clock;
}
