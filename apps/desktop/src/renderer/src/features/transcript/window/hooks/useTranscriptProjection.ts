import { useMemo } from "react";

import { usePlatformBridge } from "#renderer/services/platform/hooks/usePlatformBridge.js";
import { useSubjectScopedState } from "#renderer/hooks/subject-scoped/useSubjectScopedState.js";
import {
  useSessionPartition,
  useSessionStore,
} from "#renderer/store/session/hooks/useOpenSessionStore.js";
import { selectTranscript } from "#renderer/store/session/selectors.js";
import { type SessionStore } from "#renderer/store/session/store.js";
import { type RunEntitiesByRunId } from "../../runs/groups.js";
import { TranscriptWindowDerivation, type TranscriptWindowModel } from "../transcript-window.js";

/** One session's unfurled window, and the derivation that keeps it across the store's revisions. */
export interface TranscriptProjection {
  readonly unfurledWindow: TranscriptWindowModel;
  /** The store's run entities the window's run groups read, for a reader deriving a window too. */
  readonly runEntities: RunEntitiesByRunId;
  /**
   * The session's one derivation, which a reader of the store's transcript derives through: the
   * transcript derived before the feed's render is not derived again in it.
   */
  readonly derivation: TranscriptWindowDerivation;
}

/**
 * Subscribe to one session's log and project it with every run group's member rows unfurled, so
 * Find counts the rows a closed run group's fold would hide. Subscribes to `transcript`, which the
 * store replaces just when it admits an event, and to the run partition, whose facts the run
 * groups' headers read.
 */
export function useTranscriptProjection(sessionStore: SessionStore): TranscriptProjection {
  const transcript = useSessionStore(sessionStore, selectTranscript);
  const runEntities = useSessionPartition(sessionStore, "run");
  // One derivation per session, seeded during render so the first pass over a session already
  // uses that session's and a navigation never carries the previous session's rows over.
  const bridge = usePlatformBridge();
  const derivation = useSubjectScopedState(
    bridge,
    sessionStore.sessionId,
    () => new TranscriptWindowDerivation(),
  );
  const heldDerivation = derivation.value;
  return useMemo(
    () => ({
      unfurledWindow: heldDerivation.derive(transcript, runEntities),
      runEntities,
      derivation: heldDerivation,
    }),
    [transcript, runEntities, heldDerivation],
  );
}
