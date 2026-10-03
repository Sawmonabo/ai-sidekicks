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
 * Build the library view and let it read. Built in a memo and started in an effect, so a memo
 * React discards costs an object and no request: the read must not happen during render.
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
  // Window triggers only: the registry has no session-scoped read triggers.
  useWindowReadTriggers(view, bridge.transportReconnect);
  const snapshot = useSyncExternalStore(
    (onStoreChange: () => void) => view.subscribe(onStoreChange),
    () => view.snapshot(),
    () => view.snapshot(),
  );
  return { view, snapshot };
}
