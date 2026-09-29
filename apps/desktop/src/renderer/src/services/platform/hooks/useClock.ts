import { useLayoutEffect, useState } from "react";

import { RealClock, type ConsoleClock } from "@renderer/lib/clock.js";
import { ForwardingConsoleClock } from "@renderer/lib/forwarding-clock.js";
import type { ConsoleBridge } from "../platform-bridge.js";
import { useConsoleBridge } from "./usePlatformBridge.js";

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
export function consoleClockFor(bridge: ConsoleBridge): ConsoleClock {
  return bridge.scenarioEngine?.clock ?? new RealClock();
}

/**
 * The clock this window runs on, pinned to the bridge it was resolved from.
 *
 * The pin is held rather than recomputed: the real arm of `consoleClockFor` mints a fresh
 * `RealClock` per call, so read from a render body every consumer treating a clock as a
 * resource identity would rebuild once per render. The pin is a `ForwardingConsoleClock`
 * rather than a reading, because the provider replaces its resolution in place with no
 * remount: its methods answer from whichever clock the window holds now, and its `cancel`
 * routes to the clock that armed the work. The clock is handed over from the layout phase,
 * so every passive effect of a commit reads the clock that commit resolved.
 */
export function useConsoleClock(): ConsoleClock {
  const bridge = useConsoleBridge();
  const [clock] = useState(() => new ForwardingConsoleClock(consoleClockFor(bridge)));
  useLayoutEffect(() => {
    clock.holdClock(consoleClockFor(bridge));
  }, [clock, bridge]);
  return clock;
}
