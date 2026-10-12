// Whether this window's first read has landed. One subscription for the feed, which draws its
// loading line until then and its empty sentence after, so the two cannot both be on screen.

import { useSessionStore } from "#renderer/store/session/hooks/useOpenSessionStore.js";
import { type SessionStore } from "#renderer/store/session/store.js";
import { type SessionStoreState } from "#renderer/store/session/state.js";

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
