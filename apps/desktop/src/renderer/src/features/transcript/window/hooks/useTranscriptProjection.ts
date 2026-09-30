import { useMemo } from "react";

import { usePlatformBridge } from "@renderer/services/platform/hooks/usePlatformBridge.js";
import { useSessionScopedState } from "@renderer/store/subject-scoped/useSessionScopedState.js";
import { type ProjectedSessionEvent } from "@renderer/store/session/entities/entities.js";
import { useSessionStore } from "@renderer/store/session/hooks/useOpenSessionStore.js";
import { type SessionStore } from "@renderer/store/session/session-store.js";
import { TranscriptRowRetention } from "../row-retention.js";
import { deriveTranscriptWindow, type TranscriptWindowModel } from "../transcript-window.js";

/**
 * Subscribe to one session's log and project it, UNFURLED.
 *
 * The subscription is the store's `timeline` and nothing else, so a
 * change to an entity partition — a run transition the transcript already saw as a row —
 * does not re-project the log. The store replaces the log's identity only when it
 * admits an event, which is what makes the memo fire exactly then.
 *
 * EVERY MEMBER ROW IS IN THE RESULT, including the ones a closed run group will fold
 * away. This is the window a narrowing is applied to, so a facet count and a
 * narrowing both see a finished run's messages, tools and users rather than
 * only the receipt its fold would have left.
 */
export function useTranscriptProjection(sessionStore: SessionStore): TranscriptWindowModel {
  const timeline = useSessionStore(sessionStore, readTimeline);
  // One table per SESSION, so a pass has a predecessor to retain from — and so a
  // pane that follows a navigation to another session starts that session with an
  // empty table rather than with the rows of the one it left. Seeded during the
  // render for the subject-scoped holder's reason: the pass that first sees a new
  // session already reads that session's own table, which a ref written in the body
  // could not promise and an effect would deliver one commit late.
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
