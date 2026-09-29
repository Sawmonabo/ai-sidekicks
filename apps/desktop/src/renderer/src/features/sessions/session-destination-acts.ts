// What the four acts this destination offers actually DO, bound to one context.
//
// SPLIT FROM `SessionsSurface.tsx`, which composes the screen: that file says what is
// drawn and where, and these are what a press performs. The seam is clean because
// nothing here renders — every act below is a call on a store, a seat or a route, and
// a suite can drive one without mounting a surface.
//
// FOUR ACTS AND ONE NAVIGATION, and the navigation is shared on purpose. Opening a
// session from a row, from an attention item, and after a start are the same act —
// "open the session this thing belongs to" — so they are declared together and no two
// surfaces can drift into a second answer for where a press goes.
//
// AN ATTENTION ITEM RESOLVES NOTHING BY BEING OPENED. Resolution lives in the daemon,
// and the notification center offers no dismiss precisely because a client-side one
// would be a heuristic standing in for it.

import type { ScreenContext } from "@renderer/console/seats/index.js";
import type { AttentionItem } from "@ai-sidekicks/contracts";
import { settleSessionStart } from "./start/session-start.js";

/** Every act the sessions destination performs, already bound to its context. */
export interface SessionDestinationActs {
  readonly openSession: (sessionId: string) => void;
  readonly openAttentionItem: (item: AttentionItem) => void;
  /** What a session started HERE settles into, for both ways of starting one. */
  readonly settleStartedSession: (sessionId: string) => void;
  /** Declare the node's directory stale, so this destination's list re-reads it. */
  readonly recheckSessionDirectory: () => void;
}

/**
 * Bind the destination's acts to one surface context.
 *
 * NOT A HOOK AND NOT MEMOISED, on the rule `ScreenContext` itself states: the
 * context is composed fresh on every frame render, so a dependency array naming it
 * memoises nothing. Nothing here needs a stable identity either — every consumer is
 * rendered by the surface on every pass regardless, and the one callback that IS read
 * outside a render is read through the commit-time ref its own control holds.
 *
 * A mount-lifetime cell naming a session is the shape the console holds through its
 * one subject-keyed holder, so a callback capturing a session id would be a shape a
 * reviewer has to stop and check.
 * These capture the CONTEXT and take the session as an argument, which is why they do
 * not.
 */
export function sessionDestinationActs(
  context: ScreenContext,
  recheckDirectory: () => void,
): SessionDestinationActs {
  const openSession = (sessionId: string): void => {
    context.frameStore.navigate({ kind: "workspace", sessionId });
  };
  return {
    openSession,
    openAttentionItem: (item) => {
      openSession(item.sessionId);
    },
    // ONE SITE, because there is one act: `session-start.ts` is the three things that
    // follow a session this window started.
    settleStartedSession: (sessionId) => {
      settleSessionStart({
        sessionStoreRegistry: context.sessionStoreRegistry,
        openSession,
        recheckDirectory,
        sessionId,
      });
    },
    // The composed draft's only remaining move after a create whose reply could not be
    // read: a session may exist under a name nothing in this window holds, and the
    // directory is the read that would answer.
    recheckSessionDirectory: recheckDirectory,
  };
}
