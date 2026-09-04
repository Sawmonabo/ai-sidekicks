// The terminal pane's descriptor — what the deck mounts, and on what terms.
//
// Split from the component beside it for `panes/browser/index.ts`'s reason: the
// registration terms are assertable without rendering anything.

import type { ConsolePaneDescriptor } from "../../seats/index.js";
import { TerminalPane } from "./TerminalPane.js";

/**
 * The terminal pane, as the deck holds it.
 *
 * IT ADVERTISES NO DETACH either, and for a different reason from the browser
 * pane's: this body does not hold a host view, it holds a process lease. A torn-off
 * terminal would put the one shared shell (`Spec-023 §Console Design (Meridian)`
 * 8.8 — one per session, not one per node and not one per pane) behind two mount
 * points, while the write lease is held by one participant at a time regardless of
 * how many surfaces are showing it. `seats/pane-kinds.ts` answers that for the kind
 * through `isDetachablePaneKind`, so the reason is recorded here and the answer is
 * given once there.
 */
export const TERMINAL_PANE_DESCRIPTOR: ConsolePaneDescriptor = {
  kind: "terminal",
  owner: "terminal",
  render: TerminalPane,
};
