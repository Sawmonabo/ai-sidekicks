// What a session-scoped holder is FOR, said in the vocabulary of a session.
//
// A DOOR, NOT A SECOND IMPLEMENTATION. `store/subject-scoped-state.ts` holds the
// rule — a value belongs to the subject it was produced under, the comparison happens
// during render, and a late settlement is dropped rather than installed. That family
// sits below `bridge/` in the console's DAG and may not name a `ConsoleBridge` or a
// `SessionStore`, so it takes an opaque object. This module names them, and adds
// nothing: every call here forwards, so there is one comparison in the console and
// two vocabularies for reaching it.
//
// WHY THE SESSION VOCABULARY EARNS A DOOR AT ALL. A session id and a composer address
// are both strings and are not interchangeable. A call site that says which key space
// it is in is one a reader can check; `useSubjectScopedState(bridge, someString, …)`
// is one they cannot.
//
// WHY IT IS A SEAT. Two view families hold one of these and view families are
// siblings that may not import each other, so the lowest home above both is this one:
// `seats/` is the highest family a view family imports and the lowest that may name a
// `ConsoleBridge` and a `SessionStore` together.
//
// AND WHY THE PAIR PREDICATE IS NOT A HOOK. A holder whose subject is TWO live
// objects — the transport a call travels through and the projection a read was taken
// against, either of which can be replaced while the other stands — has no key to
// name: a rebuilt `SessionStore` for the same session passes an id comparison on the
// first committed render after the replacement and hands back models bound to a
// projection that was just retired. Those holders are registries rather than render
// state (`collaboration/session-models.ts`, `agents/agent-console-model.ts`), they run
// outside React, and what they need is the predicate and not the storage. It states
// the same rule in the same terms and holds nothing.

import {
  useSubjectScopedState,
  type SessionStore,
  type SubjectScopedState,
} from "../store/index.js";
import type { ConsoleBridge } from "../bridge/index.js";

// Consumed by T-023p-1C-3
/**
 * Hold one value per `(bridge, sessionId)`.
 *
 * The session-named door onto the console's one subject-scoped holder, for the
 * callers whose subject IS the session. The bridge is the subject because its
 * replacement — a reconnect, a second window's own instance, the fixture's scenario
 * switch — retires every call in flight through it; the session id is the key within
 * it, because one bridge carries many sessions.
 */
export function useSessionScopedState<TValue>(
  bridge: ConsoleBridge,
  sessionId: SessionScopedKey,
  initial: () => TValue,
): SubjectScopedState<TValue> {
  return useSubjectScopedState(bridge, sessionId, initial);
}

// Consumed by T-023p-1C-3
/**
 * The session a holder is about, or `undefined` where the surface is about none.
 *
 * Named rather than written as a bare union at the parameter, so the two readings the
 * console's absence grammar keeps apart — no session on the address, and a session
 * whose read has not answered — stay distinguishable at every call site.
 */
export type SessionScopedKey = string | undefined;

// Consumed by T-023p-1C-4
/**
 * The exact pair a session-scoped registry's contents belong to.
 *
 * Both members are compared by reference and neither is reduced to a name: the bridge
 * is a transport whose replacement retires every call in flight through it, and the
 * store is a projection whose replacement retires every read taken against it. A
 * registry that carried only the session id would answer for both.
 */
export interface SessionSubject {
  readonly bridge: ConsoleBridge;
  readonly sessionStore: SessionStore;
}

// Consumed by T-023p-1C-4
/**
 * Whether a held subject is still the one being rendered.
 *
 * `undefined` on either side answers `false`, which is the honest reading of a mount
 * that has resolved no bridge or no session yet: nothing is held FOR it, so nothing
 * may be handed out under it.
 */
export function isCurrentSessionSubject(
  held: SessionSubject | undefined,
  bridge: ConsoleBridge | undefined,
  sessionStore: SessionStore | undefined,
): boolean {
  return held !== undefined && held.bridge === bridge && held.sessionStore === sessionStore;
}
