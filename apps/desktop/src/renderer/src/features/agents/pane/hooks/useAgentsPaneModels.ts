import { useEffect, useState } from "react";

import { useBridgeClock } from "@renderer/services/platform/hooks/useClock.js";
import { type PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { isCurrentSessionSubject } from "@renderer/console/seats/index.js";
import type { SessionStore } from "@renderer/store/session/session-store.js";
import { type AgentsPaneCalls } from "../../agent-reads.js";
import { AgentsPaneModels } from "../agents-pane-models.js";

/**
 * Hold one {@link AgentsPaneModels} for as long as this mount shows one session.
 *
 * A hook rather than a render body: the models open subscriptions and a scheduler,
 * and a body that built them would build a new set on every pass React discarded,
 * each leaving a subscription behind it. `undefined` in either argument is a real
 * state — an auxiliary address that named no session — and answers `undefined`, which
 * the surfaces render as the absence it is.
 *
 * A MODEL NEVER BELONGS TO A SUBJECT IT IS NOT FOR. State replaced from an effect
 * lags its own inputs by one committed frame, so a console moving directly from one
 * open session to another renders once with the previous session's models under the
 * new session's store. That frame is not merely a stale roster: the column would
 * read through the session the console has LEFT while naming the agent of the one it
 * arrived at. So the held set is answered only while it matches the subject it was
 * asked about, and the mismatched frame answers `undefined` — the absence every
 * consumer already renders.
 *
 * THE SUBJECT IS THE PAIR AND NOT THE SESSION ID. A replacement bridge or a rebuilt
 * store for the SAME session passes an id comparison, so the first committed render
 * after either replacement would hand back models whose reads are bound to the
 * transport and the projection that were just retired. `seats/session-subject.ts`
 * owns the comparison, so the predicate has one copy.
 *
 * `calls` is held stable by the caller: a new object rebuilds the models.
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
