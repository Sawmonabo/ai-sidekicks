// Where the composer is addressed, resolved once from the session's store. Every
// zone calls this hook rather than receiving the answer from the host; the memo over the standing
// events and the run partition is a pointer comparison because the store merges immutably.

import { useMemo } from "react";

import {
  useSessionPartition,
  useSessionStore,
} from "#renderer/store/session/hooks/useOpenSessionStore.js";
import { selectStandingEvents } from "#renderer/store/session/selectors.js";
import { type SessionStore } from "#renderer/store/session/store.js";
import { resolveComposerTarget, type ComposerTarget } from "../target.js";

/** Resolve where the composer is addressed within one session: the session or the lead's run. */
export function useComposerAddress(sessionStore: SessionStore): ComposerTarget {
  const standingEvents = useSessionStore(sessionStore, selectStandingEvents);
  const runs = useSessionPartition(sessionStore, "run");
  const sessionId = sessionStore.sessionId;
  return useMemo(
    () => resolveComposerTarget({ sessionId, standingEvents, runs }),
    [sessionId, standingEvents, runs],
  );
}
