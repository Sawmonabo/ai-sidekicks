// The bound drivers' declared capability flags, read through the bridge's one shared reading.

import { useCallback, useSyncExternalStore } from "react";

import { useWindowReadTriggers } from "#renderer/store/reads/hooks/useWindowReadTriggers.js";
import type { DriverCapabilityReadout } from "#renderer/store/driver-capabilities/driver-capability-readout.js";
import { useBridgeClock } from "../platform/hooks/useClock.js";
import { type PlatformBridge } from "../platform/platform-bridge.js";
import { driverCapabilityReads } from "./driver-capability-read.js";

/**
 * Reads the bound drivers' declared capability flags; every consumer on one bridge shares one
 * reading. The snapshot is the stored readout object, so a component that asked second re-renders
 * once when the answer lands. Mount (`subscribe`) and window focus are wired here; the
 * session-scoped repair reason is `useDriverCapabilityRepairRead`.
 */
export function useDriverCapabilities(bridge: PlatformBridge): DriverCapabilityReadout | undefined {
  const clock = useBridgeClock();
  const reading = driverCapabilityReads.reading(bridge, clock);
  const subscribe = useCallback(
    (onReadoutChanged: () => void) => reading.watch(onReadoutChanged),
    [reading],
  );
  const readSnapshot = useCallback(() => reading.readout, [reading]);
  useWindowReadTriggers(reading, bridge.transportReconnect);

  return useSyncExternalStore(subscribe, readSnapshot, readSnapshot);
}
