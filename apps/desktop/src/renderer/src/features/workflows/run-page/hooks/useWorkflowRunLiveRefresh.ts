import { useCallback, useEffect, useSyncExternalStore } from "react";

import { useBridgeClock } from "@renderer/services/platform/hooks/useClock.js";
import { type PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { CONTROLLER_DISPOSAL } from "@renderer/lib/subject-scoped/subject-scoped-disposal.js";
import { useSubjectScopedResource } from "@renderer/hooks/subject-scoped/useSubjectScopedResource.js";
import { type SessionStore } from "@renderer/store/session/session-store.js";
import { WorkflowRunLiveRefresh } from "../run-live-refresh.js";

/**
 * Mint one live-round reading for the window's bridge, the session, and the run shown.
 *
 * The subject is the bridge, so a reconnect starts the round over. The key is session plus
 * run, since a pane retargets without unmounting and the reading admits one run's frames. A
 * store rebuilt for the same session keeps the key, so an effect publishes the replacement.
 *
 * @consumedBy the run pane's live refresh
 */
export function useWorkflowRunLiveRefresh(
  bridge: PlatformBridge,
  sessionStore: SessionStore | undefined,
  workflowRunId: string | undefined,
): number {
  // The window's clock, so the reading coalesces on the same time the world it watches runs on.
  const clock = useBridgeClock();
  const openRounds = useCallback(
    () => new WorkflowRunLiveRefresh({ clock, sessionStore, workflowRunId }),
    [clock, sessionStore, workflowRunId],
  );
  const { value: rounds, settle } = useSubjectScopedResource(
    bridge,
    readingSubjectKey(sessionStore?.sessionId, workflowRunId),
    openRounds,
    CONTROLLER_DISPOSAL,
  );
  useEffect(() => {
    // Only the store axis is left: a projection rebuilt for the same session across a
    // reconnect keeps the whole address while being another object.
    if (!rounds.isReadingFor(sessionStore)) {
      settle()(openRounds());
      return;
    }
    rounds.start();
  }, [rounds, settle, sessionStore, openRounds]);
  const subscribe = useCallback(
    (onRoundChange: () => void) => rounds.subscribe(onRoundChange),
    [rounds],
  );
  const readRound = useCallback(() => rounds.round, [rounds]);
  return useSyncExternalStore(subscribe, readRound, readRound);
}

/**
 * The subject this reading is held at: the session it watches and the run it is about.
 *
 * Each absence is spelled, so a pane with no session showing run `x` and a pane in session
 * `x` showing no run get different keys.
 */
function readingSubjectKey(
  sessionId: string | undefined,
  workflowRunId: string | undefined,
): string {
  return `${sessionId ?? "no-session"}#${workflowRunId ?? "no-run"}`;
}
