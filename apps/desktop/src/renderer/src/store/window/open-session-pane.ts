// How a screen with no pane layout of its own opens a pane: pane layouts live only inside the
// session screen, so the pane is opened in a named session's layout and the window moves there.

import type { WindowStore } from "./store.js";
import type { PaneOpenRequest } from "./pane-open-requests.js";

/**
 * Open a pane in a session's pane layout and move the window to that session. The layout opens it
 * once it has restored its saved arrangement, or focuses the pane already showing that address.
 */
export function openSessionPane(frameStore: WindowStore, request: PaneOpenRequest): void {
  frameStore.paneOpenRequests.request(request);
  frameStore.navigate({ kind: "session", sessionId: request.sessionId });
}
