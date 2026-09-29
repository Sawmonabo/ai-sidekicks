// The bound drivers' declared capability flags, read through the bridge's one shared reading.

import { useCallback, useSyncExternalStore } from "react";

import { useWindowReadTriggers } from "@renderer/store/reads/hooks/useWindowReadTriggers.js";
import type { DriverCapabilityReadout } from "@renderer/store/driver-capabilities/driver-capability-readout.js";
import { type ConsoleBridge } from "../platform/platform-bridge.js";
import { driverCapabilityReads } from "./driver-capability-read.js";

/**
 * Read the bound drivers' declared capability flags.
 *
 * Every consumer on one bridge is served by one reading. The snapshot is the stored
 * readout object, so `useSyncExternalStore` compares a pointer and a surface that
 * asked second re-renders once, when the answer lands, and never on a poll.
 *
 * The two window-scoped refresh reasons are wired here, because both are properties
 * of this window rather than of a session: a surface mounting is `subscribe`, and
 * the window regaining focus is `window-focus`. The session-scoped one is
 * `useDriverCapabilityRepairRead`.
 */
export function useDriverCapabilities(bridge: ConsoleBridge): DriverCapabilityReadout | undefined {
  const reading = driverCapabilityReads.reading(bridge);
  const subscribe = useCallback(
    (onReadoutChanged: () => void) => reading.watch(onReadoutChanged),
    [reading],
  );
  const readSnapshot = useCallback(() => reading.readout, [reading]);
  useWindowReadTriggers(reading, bridge.transportReconnect);

  return useSyncExternalStore(subscribe, readSnapshot, readSnapshot);
}
