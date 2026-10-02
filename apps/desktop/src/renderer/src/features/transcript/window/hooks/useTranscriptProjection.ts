import { useMemo } from "react";

import { usePlatformBridge } from "@renderer/services/platform/hooks/usePlatformBridge.js";
import { useSessionScopedState } from "@renderer/store/subject-scoped/useSessionScopedState.js";
import { type ProjectedSessionEvent } from "@renderer/store/session/entities/entities.js";
import { useSessionStore } from "@renderer/store/session/hooks/useOpenSessionStore.js";
import { type SessionStore } from "@renderer/store/session/session-store.js";
import { TranscriptRowRetention } from "../row-retention.js";
import { deriveTranscriptWindow, type TranscriptWindowModel } from "../transcript-window.js";

/**
 * Subscribe to one session's log and project it with every run group's member rows unfolded, so
 * Find counts the rows a closed run group's fold would hide. Subscribes to
 * `timeline` only, which the store replaces just when it admits an event.
 */
export function useTranscriptProjection(sessionStore: SessionStore): TranscriptWindowModel {
  const timeline = useSessionStore(sessionStore, readTimeline);
  // One retention table per session, seeded during render so the first pass over a session already
  // uses that session's table and a navigation never carries the previous session's rows over.
  const bridge = usePlatformBridge();
  const retention = useSessionScopedState(
    bridge,
    sessionStore.sessionId,
    () => new TranscriptRowRetention(),
  );
  const heldRetention = retention.value;
  return useMemo(() => deriveTranscriptWindow(timeline, heldRetention), [timeline, heldRetention]);
}

/** The log this window holds. A named function, so the selector identity is stable. */
function readTimeline(state: {
  readonly timeline: readonly ProjectedSessionEvent[];
}): readonly ProjectedSessionEvent[] {
  return state.timeline;
}
