// What a session-scoped holder was built FOR, and the one predicate that says
// whether it still is.
//
// EVERY HOLDER IN THIS CONSOLE HAS THE SAME FRAME TO GET RIGHT. A set of models is
// replaced from an effect, and an effect's state lands one committed frame after the
// render that renamed its inputs. So the frame between them draws the previous
// subject's models under the arriving subject's context — a stale roster at best,
// and at worst a control that dispatches a mutation through the session the console
// has LEFT while naming a row of the one it arrived at.
//
// THE SUBJECT IS THE PAIR, NOT THE ID. Two families each wrote that guard against
// `sessionId` alone, and a session id is not the subject: a window handed a
// replacement bridge — a reconnect, a second window's own instance — or a rebuilt
// `SessionStore` for the same session passes an id comparison on the first committed
// render after the replacement and hands back models bound to the transport and the
// projection that were just retired. The identities are what a holder actually
// depends on, so the identities are what it is stamped with.
//
// WHY IT IS A SEAT. Two VIEW families hold one of these (`agents/`, `collaboration/`)
// and view families are siblings that may not import each other, so the lowest home
// above both is this one: `seats/` is the highest family a view family imports and
// the lowest that may name a `ConsoleBridge` and a `SessionStore` together. Written
// twice it was written as two id comparisons that agreed with each other and with
// nothing else; the place two copies of a guard drift is the predicate, and a
// drifted predicate is a stale value on screen that every test still passes.
//
// NOTHING HERE HOLDS OR BUILDS ANYTHING. It states what a subject is and compares
// two of them. Which models a subject gets, when they are disposed, and how many
// leases are out belong to the holder that owns them.

import type { ConsoleBridge } from "../bridge/index.js";
import type { SessionStore } from "../store/index.js";

/**
 * The exact pair a session-scoped holder's contents belong to.
 *
 * Both members are compared by reference and neither is reduced to a name: the
 * bridge is a transport whose replacement retires every call in flight through it,
 * and the store is a projection whose replacement retires every read taken against
 * it. A holder that carried only the session id would answer for both.
 */
export interface SessionSubject {
  readonly bridge: ConsoleBridge;
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
  bridge: ConsoleBridge | undefined,
  sessionStore: SessionStore | undefined,
): boolean {
  return held !== undefined && held.bridge === bridge && held.sessionStore === sessionStore;
}
