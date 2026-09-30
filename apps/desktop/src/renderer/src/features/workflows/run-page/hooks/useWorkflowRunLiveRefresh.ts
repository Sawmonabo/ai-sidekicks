import { useBridgeClock } from "@renderer/services/platform/hooks/useClock.js";
import { type PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { useStoreBoundReader } from "@renderer/hooks/subject-scoped/useStoreBoundReader.js";
import { type SessionStore } from "@renderer/store/session/session-store.js";
import { WorkflowRunLiveRefresh } from "../run-live-refresh.js";

/**
 * Mint one live-round reading for the window's bridge, the session, and the run shown.
 *
 * The subject is the bridge, so a reconnect starts the round over. The key is session plus
 * run, since a pane retargets without unmounting and the reading admits one run's frames. A
 * store rebuilt for the same session keeps the key, so the reader is replaced in place.
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
  return useStoreBoundReader(
    bridge,
    readingSubjectKey(sessionStore?.sessionId, workflowRunId),
    sessionStore,
    () => new WorkflowRunLiveRefresh({ clock, sessionStore, workflowRunId }),
  ).reading;
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
