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
 * THE SUBJECT IS THE BRIDGE AND THE KEY IS THE SESSION AND THE RUN. A bridge swapped
 * underneath — the live connection's reconnect — is a different world and mints a fresh
 * reading, so the round starts over rather than carrying the previous bridge's count into
 * the new one. The session and the run are the key because a window holds many of both,
 * and because the run is what this reading ADMITS frames against: a pane is retargeted
 * from one run to another without ever unmounting, so a reading keyed on the session
 * alone would go on admitting the run the pane had left and refusing the one it had
 * moved to.
 *
 * THE KEY IS DERIVED, which is `run-snapshot.ts`'s own shape for a subject compared by
 * value: one string, composed in one place, out of the facts that make this a different
 * question. A round starting over on a retarget costs nothing, because the read it
 * drives is keyed on the run as well and is a fresh question either way.
 *
 * THE STORE AXIS IS AN EFFECT AND NOT PART OF THE KEY, which is
 * `use-artifact-reading.ts`'s split: a store rebuilt for the same session keeps the
 * whole address, so the replacement is published through the seam rather than keyed
 * on. `useSessionStoreRebind` is the same rule for callers whose store is required;
 * this pane's is optional, so the check is written here against the same member name.
 *
 * @consumedBy the run pane's live refresh
 */
export function useWorkflowRunLiveRefresh(
  bridge: PlatformBridge,
  sessionStore: SessionStore | undefined,
  workflowRunId: string | undefined,
): number {
  // The window's own clock. A reading that minted a clock of its own would coalesce on
  // wall time while the world it watches ran on the window's.
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
    // THE STORE AXIS, AND ONLY IT. Disposal is the seam's, and the key already
    // carries the session — what is left is a projection rebuilt for the SAME session
    // across a reconnect, which keeps the whole address while being another object.
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
 * BOTH ABSENCES ARE SPELLED, and that is why the parts are joined rather than
 * concatenated raw: a pane with no session showing run `x` and a pane in session `x`
 * showing no run are two different readings, and a bare join would give both the same
 * key. Neither identifier can contain the separator — both are opaque wire values the
 * daemon mints — so the composition is unambiguous over the values that actually occur.
 */
function readingSubjectKey(
  sessionId: string | undefined,
  workflowRunId: string | undefined,
): string {
  return `${sessionId ?? "no-session"}#${workflowRunId ?? "no-run"}`;
}
