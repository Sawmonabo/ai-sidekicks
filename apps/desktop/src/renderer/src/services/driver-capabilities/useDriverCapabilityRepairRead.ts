// Re-reading the node's driver declarations when a session's stream is repaired.

import { useSessionReadTriggers } from "@renderer/store/reads/hooks/useSessionReadTriggers.js";
import { type SessionStore } from "@renderer/store/session/session-store.js";
import { useBridgeClock } from "../platform/hooks/useClock.js";
import { type PlatformBridge } from "../platform/platform-bridge.js";
import { driverCapabilityReads } from "./driver-capability-read.js";

/**
 * Re-read this node's declarations when a session's stream is repaired.
 *
 * Separate from `useDriverCapabilities`, and deliberately so: `driver.listCapabilities` is
 * addressed at the NODE, and a node-scoped read has no connection state of its own to watch.
 * What the window has is the session store's sticky degraded flag, whose CLEARING says a
 * stream stopped and a completed re-pull has since re-established it — the nearest honest
 * reading of a daemon that went away and came back, which is exactly the transient that
 * leaves a refused or stale capability set standing.
 *
 * A caller that holds a session calls this beside `useDriverCapabilities`; one that does not
 * still re-reads on mount and on focus.
 */
export function useDriverCapabilityRepairRead(
  bridge: PlatformBridge,
  sessionStore: SessionStore,
): void {
  // The session half alone, deliberately: the window half is already wired by
  // `useDriverCapabilities`, which every caller of this hook also calls, and wiring
  // it twice would put two focus listeners on one window for one reading.
  const clock = useBridgeClock();
  useSessionReadTriggers(driverCapabilityReads.reading(bridge, clock), sessionStore);
}
