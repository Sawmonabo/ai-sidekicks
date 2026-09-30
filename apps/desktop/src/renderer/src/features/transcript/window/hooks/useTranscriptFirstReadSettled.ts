// Whether this window's first read has landed. One subscription for two readers, the skeleton
// and the feed's empty window, so they cannot disagree and show "nothing has happened" above
// skeleton rows while the first read is in flight.

import { useSessionStore } from "@renderer/store/session/hooks/useOpenSessionStore.js";
import { type SessionStore } from "@renderer/store/session/session-store.js";
import { type SessionStoreState } from "@renderer/store/session/session-state.js";

/**
 * Whether this session's first read has settled. `false` while it is in flight, which is not the
 * same as a session with nothing in it.
 */
export function useTranscriptFirstReadSettled(sessionStore: SessionStore): boolean {
  return useSessionStore(sessionStore, readInitialized);
}

function readInitialized(state: SessionStoreState): boolean {
  return state.initialized;
}
