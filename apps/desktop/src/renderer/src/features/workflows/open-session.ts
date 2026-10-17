// How a pointer into a session that may no longer exist opens it: the session is opened and its
// first read awaited before the window moves, so a pointer whose session the background service
// deleted leaves the window where it is and its control says `Session not found`.

import { sessionRoute } from "#renderer/routing/readers.js";
import type { SessionStoreRegistry } from "#renderer/store/session/registry.js";
import type { WindowStore } from "#renderer/store/window/store.js";

/** How following a pointer into a session ended: the window moved there, or the session is gone. */
export type SessionPointerOutcome = "opened" | "gone";

/**
 * Open a session and move the window there once its first read lands, with the message a cursor
 * names in view or at its foot without one; a session the background service answers no longer
 * exists moves nothing and answers `gone`. A read that failed for another cause still moves, where
 * the session's own line says it could not catch up. Rejects with a `RefusalError` once the
 * registry is disposed.
 */
export async function followSessionPointer(
  frameStore: WindowStore,
  registry: SessionStoreRegistry,
  sessionId: string,
  messageAnchorCursor?: string,
): Promise<SessionPointerOutcome> {
  if ((await registry.openAndRead(sessionId)) === "gone") {
    return "gone";
  }
  frameStore.navigate(sessionRoute(sessionId, messageAnchorCursor));
  return "opened";
}
