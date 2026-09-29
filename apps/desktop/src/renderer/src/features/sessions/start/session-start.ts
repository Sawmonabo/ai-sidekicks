// What happens when starting a session settles.
//
// The composed new-session draft creates a session on its own send and hands the
// session's id out. This module is what that id reaches, so a session started here is
// on screen and a person is in it.
//
// THREE THINGS, IN THIS ORDER, AND EACH ONE IS ONE FACT.
//
//   1. THE STORE OPENS. A session this window created is a session this window has
//      open, and the registry is where that is true. It matters before the navigation
//      rather than as a consequence of it: the all-sessions list merges the node's
//      directory with the registry's own set, so a create the node's directory has
//      not answered yet is on screen because the registry holds it. Opening is
//      idempotent, so this is not a rival of the route's own open one layer up.
//   2. THE NODE'S DIRECTORY IS DECLARED STALE. The act has settled and carries the
//      session it produced, so this schedules a read of something that HAPPENED.
//   3. THE WINDOW NAVIGATES. Last, because it is the one step a person sees, and
//      because it is the step that ends this surface's mount.

import type { ConsoleSurfaceContext } from "@renderer/console/seats/index.js";

/** What the destination hands this act, and everything the act touches. */
export interface SessionStartSettlement {
  readonly sessionStoreRegistry: ConsoleSurfaceContext["sessionStoreRegistry"];
  /** Where a settled start goes. */
  readonly openSession: (sessionId: string) => void;
  /** Declare the node's directory stale, so the sessions list reads it again. */
  readonly recheckDirectory: () => void;
  /** The session the daemon minted. Never a guess, and never a press. */
  readonly sessionId: string;
}

/**
 * Settle one start, having been told which session it produced.
 *
 * FOR A SETTLED CREATE AND NEVER FOR A PRESS. Every step below names a session, and
 * at the press there is no session to name.
 */
export function settleSessionStart(settlement: SessionStartSettlement): void {
  const { sessionStoreRegistry, openSession, recheckDirectory, sessionId } = settlement;
  // The disposed check is the remount window `frame/session/session-lifecycle.ts` names:
  // `open` is the one registry call that raises rather than returning a refusal, and
  // a settlement landing after this window's registry was replaced must not take the
  // rest of the act with it. Nothing is lost by skipping it — a disposed registry
  // belongs to a bridge this window has already left.
  if (!sessionStoreRegistry.isDisposed) {
    sessionStoreRegistry.open(sessionId);
  }
  recheckDirectory();
  openSession(sessionId);
}
