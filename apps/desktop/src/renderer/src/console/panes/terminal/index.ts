// The terminal pane's descriptor — what the deck mounts, and on what terms.
//
// Split from the component beside it for `panes/browser/index.ts`'s reason: the
// registration terms are assertable without rendering anything.

import type { ConsolePaneDescriptor } from "../../workspace/index.js";
import { TerminalPane } from "./TerminalPane.js";

/**
 * The terminal pane, as the deck holds it.
 *
 * `openInWindow: false`, and for a different reason from the browser pane's: this
 * body does not hold a host view, it holds a process lease. A torn-off terminal
 * would put the one shared shell (`Spec-023 §Console Design (Meridian)` 8.8 — one
 * per session, not one per node and not one per pane) behind two mount points, and
 * the write lease is held by one participant at a time regardless of how many
 * surfaces are showing it. Until `Spec-003`'s renderer obligations say how a detach
 * carries a lease, false is the only answer that cannot be wrong.
 */
export const TERMINAL_PANE_DESCRIPTOR: ConsolePaneDescriptor = {
  kind: "terminal",
  owner: "terminal",
  render: TerminalPane,
  openInWindow: false,
};
