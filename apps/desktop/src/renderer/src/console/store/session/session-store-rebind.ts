// The axis a subject key cannot carry: which SESSION STORE a held resource reads
// against.
//
// `store/subject-scoped/subject-scoped-resource.ts` holds one resource per `(subject, key)`, and every
// reading in the console that watches a session has THREE collaborators for those two
// slots — the bridge it calls through, the identity it is addressed by, and the store
// whose repair edge and named frames are two of the three reasons
// `Spec-023 §Rules every console surface obeys` admits. The bridge is the subject and
// the identity is the key, so the store is the one left over: a projection rebuilt for
// the same session under an unchanged bridge keeps the whole address, the seam holds
// the resource in place, and the resource goes on listening to a store nothing else
// reads. Every refresh the new store publishes reaches nobody, and the surface sits on
// the answer it read before the reconnect with nothing on screen saying why.
//
// THE RULE IS WRITTEN ONCE HERE BECAUSE FOUR BINDINGS WOULD OTHERWISE WRITE IT. The
// three repos act controllers reach it through `store/act/use-act-controller.ts`, which every
// act controller binds through, and the workspace execution-context reader calls it
// directly beside its own `useSubjectScopedResource`. `apps/desktop/AGENTS.md`
// §Shared code hoists on the second use, and the shape a copy of this drifts in is
// the COMPARISON: a binding that compared session ids rather than store identities
// would look identical in a diff and would never rebind at all, because the id is
// exactly what the key already carries.
//
// THE REPLACEMENT IS PUBLISHED THROUGH THE SEAM AND NEVER CONSTRUCTED IN A RENDER.
// `settle()` names the visit ON SCREEN, so the resource this mints is installed as the
// subject's own value and the retired one is disposed on the seam's terms — the same
// terms an ordinary replacement takes. A resource built in a render body would be a
// real object with a real read on the wire that no effect ever commits to end.
//
// WHAT THIS IS NOT. It is not a second holder, and it is not a disposal: the seam owns
// both. It answers one question — is the resource on screen still reading against the
// store this render is about — and publishes a fresh one where the answer is no.

import { useEffect, useLayoutEffect, useRef } from "react";

import type { SessionStore } from "./session-store.js";
import type { SubjectScopedState } from "../subject-scoped/index.js";

/**
 * A resource whose reads are taken against a session store.
 *
 * ASKED OF THE RESOURCE RATHER THAN DERIVED BY THIS HOOK, because only the resource
 * knows which store it closed over: the collaborator is private, and a hook comparing
 * something it was handed beside the resource would be comparing its own argument to
 * itself. `RepoMountsReader.isReadingFor` is where this name and its reason were
 * written first; this is that member typed, so a resource that grows the axis and
 * forgets the check stops compiling here rather than going quiet on screen.
 */
export interface SessionStoreScoped {
  isReadingFor(sessionStore: SessionStore): boolean;
}

/**
 * Replace a held resource when the store it reads against moves under an unchanged key.
 *
 * THE FACTORY IS HELD RATHER THAN DEPENDED ON. Every call site writes it as a closure
 * over the render's own collaborators, so its identity moves on every pass; taking it
 * as a dependency would re-run this effect on renders that have nothing to do with the
 * store, and dropping it from the list would rebind through a factory several renders
 * old. Held in the LAYOUT phase, which runs before any passive effect for the same
 * commit, so the factory this reaches for is the one the render that re-addressed
 * supplied.
 *
 * THE EFFECT'S DEPENDENCIES ARE THE THREE FACTS THE REBIND IS ABOUT: the resource on
 * screen, the publisher bound to its visit, and the store this render reads against.
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
