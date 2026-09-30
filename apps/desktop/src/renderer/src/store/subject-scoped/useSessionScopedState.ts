// The session-keyed entry to the one subject-scoped holder. A session id and a composer address
// are both strings, and a call site that names its key space is one a reader can check.

import {
  useSubjectScopedState,
  type SubjectScopedState,
} from "@renderer/hooks/subject-scoped/useSubjectScopedState.js";

/**
 * The session a holder is about, or `undefined` where the view is about none. Named so the two
 * absences the console keeps apart (no session on the address, a read not yet answered) stay
 * distinguishable at every call site.
 */
export type SessionScopedKey = string | undefined;

/**
 * Hold one value per `(bridge, sessionId)`. The bridge is the subject because replacing it (a
 * reconnect, a second window's instance, the fixture's scenario switch) retires every call in
 * flight through it; the session id is the key within it.
 */
export function useSessionScopedState<TValue>(
  bridge: object,
  sessionId: SessionScopedKey,
  initial: () => TValue,
): SubjectScopedState<TValue> {
  return useSubjectScopedState(bridge, sessionId, initial);
}
