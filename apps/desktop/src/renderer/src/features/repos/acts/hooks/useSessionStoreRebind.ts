// Rebinds a held resource when the session store it reads against changes under an unchanged
// key. The subject is the bridge and the key is the identity, so a store rebuilt for the same
// session keeps the whole address and the resource would go on listening to a dead store.
// The replacement is published through the seam's `settle()`, never constructed in a render.

import { useEffect, useLayoutEffect, useRef } from "react";

import type { SessionStore } from "#renderer/store/session/session-store.js";
import type { SubjectScopedState } from "#renderer/hooks/subject-scoped/useSubjectScopedState.js";

/**
 * A resource whose reads are taken against a session store. The resource answers, not the
 * hook, because only it knows which store it closed over; a resource that grows the axis
 * and omits the check stops compiling.
 */
export interface SessionStoreScoped {
  isReadingFor(sessionStore: SessionStore): boolean;
}

/**
 * Replace a held resource when the store it reads against moves under an unchanged key. The
 * comparison is store identity, not session id, which the key already carries. `open` is held
 * in a ref updated in the layout phase rather than listed as a dependency: call sites pass a
 * fresh closure every render, and a listed one would re-run the effect on unrelated renders.
 */
export function useSessionStoreRebind<TResource extends SessionStoreScoped>(
  held: SubjectScopedState<TResource>,
  sessionStore: SessionStore,
  open: () => TResource,
): void {
  const { value, settle } = held;
  const latestOpen = useRef(open);
  useLayoutEffect(() => {
    latestOpen.current = open;
  });
  useEffect(() => {
    if (value.isReadingFor(sessionStore)) {
      return;
    }
    settle()(latestOpen.current());
  }, [value, settle, sessionStore]);
}
