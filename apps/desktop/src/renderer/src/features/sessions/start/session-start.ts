// What happens when starting a session settles. The new-session draft creates a session on its
// own send and hands out the id; this module is where that id goes, in order:
//   1. The store opens. The all-sessions list merges the daemon's directory with the registry's own
//      set, so a create the directory has not yet answered still shows because the registry holds
//      it. Opening is idempotent, so it does not fight the route's own open.
//   2. The daemon's directory is declared stale, scheduling a read of something that happened.
//   3. The window navigates, last: it is the step a person sees, and it ends this screen's mount.

import type { ScreenContext } from "#renderer/registries/screens/screen-context.js";

/** What the destination hands this act, and everything the act touches. */
export interface SessionStartSettlement {
  readonly sessionStoreRegistry: ScreenContext["sessionStoreRegistry"];
  /** Where a settled start goes. */
  readonly openSession: (sessionId: string) => void;
  /** Declares the daemon's directory stale, so the sessions list reads it again. */
  readonly recheckDirectory: () => void;
  /** The session the daemon minted; never a guess made at the press. */
  readonly sessionId: string;
}

/** Settles one start, given the session it produced. Runs after a settled create only. */
export function settleSessionStart(settlement: SessionStartSettlement): void {
  const { sessionStoreRegistry, openSession, recheckDirectory, sessionId } = settlement;
  // `open` raises on a disposed registry, and a settlement landing after the registry was
  // replaced must not lose the rest of the act. Skipping it loses nothing: a disposed registry
  // belongs to a bridge this window has left.
  if (!sessionStoreRegistry.isDisposed) {
    sessionStoreRegistry.open(sessionId);
  }
  recheckDirectory();
  openSession(sessionId);
}
