// The session a session-scoped holder is about, said in the vocabulary of a session.
//
// `lib/subject-scoped/subject-scoped-holder.ts` holds the rule: a value belongs to the
// subject it was produced under, the comparison happens during render, and a late
// settlement is dropped rather than installed. That holder takes an opaque subject;
// this module names the session store beside it and adds nothing.
//
// WHY THE PAIR PREDICATE IS NOT A HOOK. A holder whose subject is TWO live
// objects — the transport a call travels through and the projection a read was taken
// against, either of which can be replaced while the other stands — has no key to
// name: a rebuilt `SessionStore` for the same session passes an id comparison on the
// first committed render after the replacement and hands back models bound to a
// projection that was just retired. That holder is a registry rather than render
// state (`agents/run-console/agent-console-model.ts`), it runs outside React, and what
// it needs is the predicate and not the storage. It states the same rule in the same
// terms and holds nothing.
import { type SessionStore } from "../session/session-store.js";

/**
 * The exact pair a session-scoped registry's contents belong to.
 *
 * Both members are compared by reference and neither is reduced to a name: the bridge
 * is a transport whose replacement retires every call in flight through it, and the
 * store is a projection whose replacement retires every read taken against it. A
 * registry that carried only the session id would answer for both. The bridge is held
 * only as an identity, so it is typed as one.
 */
export interface SessionSubject {
  readonly bridge: object;
  readonly sessionStore: SessionStore;
}

/**
 * Whether a held subject is still the one being rendered.
 *
 * `undefined` on either side answers `false`, which is the honest reading of a mount
 * that has resolved no bridge or no session yet: nothing is held FOR it, so nothing
 * may be handed out under it.
 */
export function isCurrentSessionSubject(
  held: SessionSubject | undefined,
  bridge: object | undefined,
  sessionStore: SessionStore | undefined,
): boolean {
  return held !== undefined && held.bridge === bridge && held.sessionStore === sessionStore;
}
