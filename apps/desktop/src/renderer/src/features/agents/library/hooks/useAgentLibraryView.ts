import { useEffect, useMemo, useSyncExternalStore } from "react";

import { useBridgeClock } from "@renderer/services/platform/hooks/useClock.js";
import { type PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { useWindowReadTriggers } from "@renderer/store/reads/hooks/useWindowReadTriggers.js";
import {
  AgentLibraryView,
  type AgentRegistryCalls,
  type AgentLibrarySnapshot,
} from "../library-view.js";

/**
 * Build the view and let it read.
 *
 * Constructed in a memo and STARTED in an effect, the split
 * `frame/session/session-lifecycle.ts` states one level up: building it owns nothing — no
 * timer, no subscription, no call in flight — and the read is the side effect that
 * must not happen during render, so a memo React discards costs a discarded object
 * and no request.
 */
export function useAgentLibraryView(
  bridge: PlatformBridge,
  calls: AgentRegistryCalls,
): {
  readonly view: AgentLibraryView;
  readonly snapshot: AgentLibrarySnapshot;
} {
  const clock = useBridgeClock();
  const view = useMemo(() => new AgentLibraryView(clock, calls), [clock, calls]);
  useEffect(() => {
    view.start();
    return () => {
      view.dispose();
    };
  }, [view]);
  // The window half only: this registry has no session and no triggering event kind,
  // so the session half would have nothing to listen to.
  useWindowReadTriggers(view, bridge.transportReconnect);
  const snapshot = useSyncExternalStore(
    (onStoreChange: () => void) => view.subscribe(onStoreChange),
    () => view.snapshot(),
    () => view.snapshot(),
  );
  return { view, snapshot };
}
