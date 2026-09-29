// The terminal pane's body, as the pane layout's registry loads it.
//
// A LOADER-BACKED BODY for `features/preview/preview-pane-body.ts`'s reason, and this pane
// is the one that makes the case hardest to argue with: the emulator chunk was already
// lazy, and everything around it — the lease line, the pane, its frame — was not,
// so the initial graph carried the whole terminal pane for every session that never
// opens one.
//
// Split from the component beside it for that file's reason too: the registration terms
// are assertable without rendering anything, and it is a module of its own rather than
// an export of a sub-module's entry.

// THE FEATURE'S STYLESHEETS ENTER HERE, which finishes the split the emulator
// already had half of: `@xterm/xterm/css/xterm.css` has always ridden the emulator's own
// chunk, and these sat on the initial document beside it. The feature registers one
// kind, as a loader, so this module is the only way into any of it — rules included.
import "./pane.css";
import "../lease/lease.css";
import "../emulator/emulator.css";

import { paneBodyForKind } from "@renderer/registries/panes/pane-body-for-kind.js";
import { type PaneContext } from "@renderer/registries/panes/pane-context.js";
import { TerminalPane } from "./components/TerminalPane.js";

/**
 * The terminal pane, as the pane layout holds it.
 *
 * IT ADVERTISES NO DETACH either, and for a different reason from the browser
 * pane's: this body does not hold a host view, it holds a process lease. A torn-off
 * terminal would put the one shared shell — one per session, not one per node and not
 * one per pane — behind two mount points, while the write lease is held from one device
 * at a time regardless of how many panes are showing it.
 * `routing/panes/pane-kinds.ts` answers that for the kind
 * through `isDetachablePaneKind`, so the reason is recorded here and the answer is
 * given once there.
 *
 * `render` goes through `paneBodyForKind` for `features/preview/preview-pane-body.ts`'s
 * reason, and it bites harder here: this body opens a subscription on the session's
 * one shared shell, so a mount at another kind's address would put a second view on
 * that shell rather than merely drawing the wrong head.
 */
export const Body: (context: PaneContext) => React.ReactNode = paneBodyForKind(
  "terminal",
  TerminalPane,
);
