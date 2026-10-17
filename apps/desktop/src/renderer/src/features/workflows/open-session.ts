// How a pointer into a session that may no longer exist opens it: the session is opened and its
// first read awaited before the window moves, so a pointer whose session the background service
// deleted leaves the window where it is and its control says `Session not found`. The move names
// the control pressed, so a session deleted after it opened can say so on that control once the
// window steps back.

import type { BlockPaneAddress } from "#renderer/routing/panes/address.js";
import { sessionRoute } from "#renderer/routing/readers.js";
import type { SessionStoreRegistry } from "#renderer/store/session/registry.js";
import { openSessionPane } from "#renderer/store/window/open-session-pane.js";
import type { WindowStore } from "#renderer/store/window/store.js";

/** How following a pointer into a session ended: the window moved there, or the session is gone. */
export type SessionPointerOutcome = "opened" | "gone";

/**
 * The workflows screen's controls that point into a session: the run header's link to the message
 * that started the run, its link to the fix session, `Open the workflow` and `Open in Review`, and
 * the step's `Fix in a fresh session` and an approval step's `Open in Review`.
 */
export type SessionPointerControl =
  | "run-started-by-message"
  | "run-fix-session"
  | "run-open-workflow"
  | "run-open-review"
  | "step-fix-session"
  | "step-open-review";

/**
 * Where in the session a pointer lands: the message a cursor names, or its foot without one; or a
 * pane its pane layout opens.
 */
export type SessionPointerLanding =
  | { readonly messageAnchorCursor: string | undefined }
  | { readonly paneAddress: BlockPaneAddress };

/**
 * Open a session and move the window there once its first read lands, to where `landing` says; a
 * session the background service answers no longer exists moves nothing and answers `gone`. A
 * read that failed for another cause still moves, where the session's own line says it could not
 * catch up. Rejects with a `RefusalError` once the registry is disposed.
 */
export async function followSessionPointer(
  frameStore: WindowStore,
  registry: SessionStoreRegistry,
  pressedControl: SessionPointerControl,
  sessionId: string,
  landing: SessionPointerLanding = { messageAnchorCursor: undefined },
): Promise<SessionPointerOutcome> {
  if ((await registry.openAndRead(sessionId)) === "gone") {
    return "gone";
  }
  if ("paneAddress" in landing) {
    openSessionPane(frameStore, { sessionId, address: landing.paneAddress }, pressedControl);
  } else {
    frameStore.navigate(sessionRoute(sessionId, landing.messageAnchorCursor), { pressedControl });
  }
  return "opened";
}
