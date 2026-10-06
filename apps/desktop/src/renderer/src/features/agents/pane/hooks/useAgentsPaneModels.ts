import { useEffect, useState } from "react";

import { useBridgeClock } from "#renderer/services/platform/hooks/useClock.js";
import { type PlatformBridge } from "#renderer/services/platform/bridge.js";
import { isCurrentSessionSubject } from "#renderer/store/session/subject.js";
import type { SessionStore } from "#renderer/store/session/store.js";
import { type AgentsPaneCalls } from "../../reads.js";
import { AgentsPaneModels } from "../models.js";

/**
 * Hold one {@link AgentsPaneModels} for as long as this mount shows one session. A hook, not a
 * render body, so a discarded render leaves no subscription behind. `undefined` in either
 * argument answers `undefined`.
 *
 * The held set is answered only while it matches the (bridge, store) pair it was asked about:
 * state replaced from an effect lags its inputs by a frame, and that frame would read through
 * the session the console has left. The pair, not the session id, is compared, because a
 * replacement bridge or rebuilt store under one session passes an id check. `calls` is held
 * stable by the caller: a new object rebuilds the models.
 */
export function useAgentsPaneModels(
  bridge: PlatformBridge | undefined,
  sessionStore: SessionStore | undefined,
  calls: AgentsPaneCalls,
): AgentsPaneModels | undefined {
  const clock = useBridgeClock();
  const [models, setModels] = useState<AgentsPaneModels | undefined>(undefined);

  useEffect(() => {
    if (bridge === undefined || sessionStore === undefined) {
      setModels(undefined);
      return undefined;
    }
    const built = new AgentsPaneModels(bridge, clock, sessionStore, calls);
    setModels(built);
    return () => {
      built.dispose();
      setModels(undefined);
    };
  }, [bridge, clock, sessionStore, calls]);

  return isCurrentSessionSubject(models?.subject, bridge, sessionStore) ? models : undefined;
}
