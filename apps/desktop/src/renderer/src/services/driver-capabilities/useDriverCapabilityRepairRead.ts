// Re-reading the service's driver declarations when a session's stream is repaired.

import { useSessionReadTriggers } from "@renderer/store/reads/hooks/useSessionReadTriggers.js";
import { type SessionStore } from "@renderer/store/session/session-store.js";
import { useBridgeClock } from "../platform/hooks/useClock.js";
import { type PlatformBridge } from "../platform/platform-bridge.js";
import { driverCapabilityReads } from "./driver-capability-read.js";

/**
 * Re-reads the service's declarations when a session's stream is repaired.
 *
 * A machine-scoped read has no connection state of its own, so this watches the session store's
 * sticky degraded flag: its clearing means a stream stopped and a re-pull re-established it, the
 * transient that leaves a refused or stale capability set standing. A caller holding a session
 * calls this beside `useDriverCapabilities`.
 */
export function useDriverCapabilityRepairRead(
  bridge: PlatformBridge,
  sessionStore: SessionStore,
): void {
  // The session half alone: `useDriverCapabilities` already wires the window half, and wiring it
  // twice would put two focus listeners on one window.
  const clock = useBridgeClock();
  useSessionReadTriggers(driverCapabilityReads.reading(bridge, clock), sessionStore);
}
