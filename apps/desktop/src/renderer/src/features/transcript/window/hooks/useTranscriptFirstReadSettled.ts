// Whether this window's first read has landed.
//
// ONE SUBSCRIPTION, TWO READERS, AND THAT IS WHY IT IS A MODULE. `initialized` is the
// store's own word for "a read response has established this window's base state", and
// two views turn on it: `TranscriptWindowSkeleton.tsx` draws skeleton rows until it
// is true, and the viewport's empty window must not speak until it is. Written twice,
// the two would be free to disagree: a skeleton reading the store and an empty window
// reading only whether it had rows would render "Nothing has happened in this session
// yet." directly above twelve skeleton rows while the first read was in flight. Two
// sentences about one moment, and one of them false.
//
// SUBSCRIBED RATHER THAN READ ONCE, like every other store fact this pane holds: the
// value is false at mount and true a moment later, which is precisely the transition
// both readers exist to render.

import { useSessionStore } from "@renderer/store/session/hooks/useOpenSessionStore.js";
import { type SessionStore } from "@renderer/store/session/session-store.js";
import { type SessionStoreState } from "@renderer/store/session/session-state.js";

/**
 * Whether this session's first read has settled.
 *
 * `false` while it is in flight — which is not the same as a session with nothing in
 * it, and is the distinction every caller of this hook exists to draw.
 */
export function useTranscriptFirstReadSettled(sessionStore: SessionStore): boolean {
  return useSessionStore(sessionStore, readInitialized);
}

/** Whether a read response has established this window's base state. */
function readInitialized(state: SessionStoreState): boolean {
  return state.initialized;
}
