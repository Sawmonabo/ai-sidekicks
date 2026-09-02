// The browser pane's descriptor — what the deck mounts, and on what terms.
//
// Separate from the component beside it because the two answer different questions
// and change at different times: the component is what renders, the descriptor is
// what the deck is allowed to do with it. Splitting them is what lets the
// registration terms below be asserted without rendering anything.

import type { ConsolePaneDescriptor } from "../../workspace/index.js";
import { BrowserPane } from "./BrowserPane.js";

/**
 * The browser pane, as the deck holds it.
 *
 * `openInWindow: false` is a property of the KIND, and it is not provisional. The
 * pane's eventual body is a main-process view hosted in the window that owns the
 * pane; following a detach would mean moving that host view between two windows,
 * which `Spec-023 §Console Design (Meridian)` ships no mechanism for and the
 * embedded-browser Type-2 ADR has not decided. False is therefore the fail-closed
 * answer AND the answer that ADR is expected to keep — a tear-off is a decision it
 * makes, not a default this console falls into.
 *
 * `render` is the component itself rather than a closure over the pane context: the
 * shell reads no context, and a wrapper that accepted one would claim otherwise.
 * A later lane widens the component's parameter list and this reference with it.
 */
export const BROWSER_PANE_DESCRIPTOR: ConsolePaneDescriptor = {
  kind: "browser",
  owner: "browser",
  render: BrowserPane,
  openInWindow: false,
};
