import { useMemo } from "react";

import { usePlatformBridge } from "@renderer/services/platform/hooks/usePlatformBridge.js";
import { useSubjectScopedState } from "@renderer/hooks/subject-scoped/useSubjectScopedState.js";
import { type ProjectedSessionEvent } from "@renderer/store/session/entities/entities.js";
import { useSessionStore } from "@renderer/store/session/hooks/useOpenSessionStore.js";
import { type SessionStore } from "@renderer/store/session/session-store.js";
import { TranscriptRowRetention } from "../row-retention.js";
import { deriveTranscriptWindow, type TranscriptWindowModel } from "../transcript-window.js";

/**
 * Subscribe to one session's log and project it with every run group's member rows unfolded, so
 * Find counts the rows a closed run group's fold would hide. Subscribes to
 * `transcript` only, which the store replaces just when it admits an event.
 */
export function useTranscriptProjection(sessionStore: SessionStore): TranscriptWindowModel {
  const transcript = useSessionStore(sessionStore, readTranscript);
  // One retention table per session, seeded during render so the first pass over a session already
  // uses that session's table and a navigation never carries the previous session's rows over.
  const bridge = usePlatformBridge();
  const retention = useSubjectScopedState(
    bridge,
    sessionStore.sessionId,
    () => new TranscriptRowRetention(),
  );
  const heldRetention = retention.value;
  return useMemo(
    () => deriveTranscriptWindow(transcript, heldRetention),
    [transcript, heldRetention],
  );
}

/** The log this window holds. A named function, so the selector identity is stable. */
function readTranscript(state: {
  readonly transcript: readonly ProjectedSessionEvent[];
}): readonly ProjectedSessionEvent[] {
  return state.transcript;
}
