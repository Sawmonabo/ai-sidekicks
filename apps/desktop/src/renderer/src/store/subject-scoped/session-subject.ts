// The session a session-scoped holder is about, in the vocabulary of a session.
//
// The rule is in `lib/subject-scoped/subject-scoped-holder.ts`: a value belongs to the subject it
// was produced under. A registry outside React (`features/agents/pane/agents-pane-models.ts`)
// has a subject of two live objects (transport and projection, either replaceable alone) and needs
// only the predicate. Comparing ids would pass a rebuilt store.
import { type SessionStore } from "../session/session-store.js";

/**
 * The exact pair a session-scoped registry's contents belong to. Both members are compared by
 * reference: replacing the bridge retires every call in flight through it, and replacing the
 * store retires every read taken against it, so the session id alone would answer for both.
 */
export interface SessionSubject {
  readonly bridge: object;
  readonly sessionStore: SessionStore;
}

/**
 * Whether a held subject is still the one being rendered. `undefined` on either side answers
 * `false`: nothing is held for a mount that has resolved no bridge or no session yet.
 */
export function isCurrentSessionSubject(
  held: SessionSubject | undefined,
  bridge: object | undefined,
  sessionStore: SessionStore | undefined,
): boolean {
  return held !== undefined && held.bridge === bridge && held.sessionStore === sessionStore;
}
