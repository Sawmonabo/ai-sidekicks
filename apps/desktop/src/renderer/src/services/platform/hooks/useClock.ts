import { useLayoutEffect, useState } from "react";

import { RealClock, type Clock } from "@renderer/lib/clock.js";
import { ForwardingClock } from "@renderer/lib/forwarding-clock.js";
import type { PlatformBridge } from "../platform-bridge.js";
import { usePlatformBridge } from "./usePlatformBridge.js";

/**
 * The clock every subsystem this bridge feeds runs on.
 *
 * Under the fixture the engine's frozen clock is the only clock the renderer reads: a store
 * keeping its own `RealClock` would run refresh deadlines on wall time while scenario beats
 * advanced on frozen time, so a capture taken right after `advance()` could land on either
 * side of a drain. It reads the running engine rather than the source tag, because the
 * engine owns the frozen clock; a bridge tagged `fixture` with no engine has no frozen time
 * to share. The real arm mints a fresh `RealClock` per caller, which is not a second time
 * base: every instance reads the same wall clock.
 */
export function resolveBridgeClock(bridge: PlatformBridge): Clock {
  return bridge.scenarioEngine?.clock ?? new RealClock();
}

/**
 * The clock this window runs on, pinned to the bridge it was resolved from.
 *
 * The pin is held rather than recomputed: the real arm of `resolveBridgeClock` mints a fresh
 * `RealClock` per call, so read from a render body every consumer treating a clock as a
 * resource identity would rebuild once per render. The pin is a `ForwardingClock`
 * rather than a reading, because the provider replaces its resolution in place with no
 * remount: its methods answer from whichever clock the window holds now, and its `cancel`
 * routes to the clock that armed the work. The clock is handed over from the layout phase,
 * so every passive effect of a commit reads the clock that commit resolved.
 */
export function useClock(): Clock {
  const bridge = usePlatformBridge();
  const [clock] = useState(() => new ForwardingClock(resolveBridgeClock(bridge)));
  useLayoutEffect(() => {
    clock.holdClock(resolveBridgeClock(bridge));
  }, [clock, bridge]);
  return clock;
}
