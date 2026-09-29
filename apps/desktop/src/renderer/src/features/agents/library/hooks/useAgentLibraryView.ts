import { useEffect, useMemo, useSyncExternalStore } from "react";

import { type ConsoleBridge } from "@renderer/console/bridge/console-bridge.js";
import { useWindowReadTriggers } from "@renderer/console/store/read/read-triggers.js";
import {
  AgentRegistryView,
  type AgentRegistryCalls,
  type AgentRegistrySnapshot,
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
export function useAgentRegistryView(
  bridge: ConsoleBridge,
  calls: AgentRegistryCalls,
): {
  readonly view: AgentRegistryView;
  readonly snapshot: AgentRegistrySnapshot;
} {
  const view = useMemo(() => new AgentRegistryView(bridge, calls), [bridge, calls]);
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
