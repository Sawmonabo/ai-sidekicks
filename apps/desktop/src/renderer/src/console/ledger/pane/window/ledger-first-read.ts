// Whether this window's first read has landed.
//
// ONE SUBSCRIPTION, TWO READERS, AND THAT IS WHY IT IS A MODULE. `initialised` is the
// store's own word for "a read response has established this window's base state", and
// two surfaces turn on it: the skeleton next door draws shells until it is true, and
// the viewport's empty window must not speak until it is. Written twice, the two would
// be free to disagree — and the way they disagreed is the reason this exists: the
// skeleton was reading the store and the empty window was reading only whether it had
// rows, so a session whose first read was in flight rendered "Nothing has happened in
// this session yet." directly above twelve loading shells. Two sentences about one
// moment, and one of them false.
//
// SUBSCRIBED RATHER THAN READ ONCE, like every other store fact this pane holds: the
// value is false at mount and true a moment later, which is precisely the transition
// both readers exist to render.

import {
  useSessionStore,
  type SessionStore,
  type SessionStoreState,
} from "../../../store/index.js";

/** Whether a read response has established this window's base state. */
function readInitialised(state: SessionStoreState): boolean {
  return state.initialised;
}

/**
 * Whether this session's first read has settled.
 *
 * `false` while it is in flight — which is not the same as a session with nothing in
 * it, and is the distinction every caller of this hook exists to draw.
 */
export function useLedgerFirstReadSettled(sessionStore: SessionStore): boolean {
  return useSessionStore(sessionStore, readInitialised);
}
