// The session-keyed entry to the one subject-scoped holder.
//
// A session id and a composer address are both strings and are not interchangeable. A
// call site that says which key space it is in is one a reader can check;
// `useSubjectScopedState(bridge, someString, …)` is one they cannot.

import {
  useSubjectScopedState,
  type SubjectScopedState,
} from "@renderer/hooks/subject-scoped/useSubjectScopedState.js";

/**
 * The session a holder is about, or `undefined` where the view is about none.
 *
 * Named rather than written as a bare union at the parameter, so the two readings the
 * console's absence grammar keeps apart — no session on the address, and a session
 * whose read has not answered — stay distinguishable at every call site.
 */
export type SessionScopedKey = string | undefined;

/**
 * Hold one value per `(bridge, sessionId)`.
 *
 * The bridge is the subject because its replacement — a reconnect, a second window's
 * own instance, the fixture's scenario switch — retires every call in flight through
 * it; the session id is the key within it, because one bridge carries many sessions.
 * The bridge is held only as an identity, so it is typed as one.
 */
export function useSessionScopedState<TValue>(
  bridge: object,
  sessionId: SessionScopedKey,
  initial: () => TValue,
): SubjectScopedState<TValue> {
  return useSubjectScopedState(bridge, sessionId, initial);
}
