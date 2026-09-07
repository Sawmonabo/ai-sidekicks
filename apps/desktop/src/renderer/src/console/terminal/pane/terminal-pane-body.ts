// The terminal pane's body, as the deck's registry loads it.
//
// A LOADER-BACKED BODY for `browser/pane/browser-pane-body.ts`'s reason, and this pane
// is the one that makes the case hardest to argue with: the emulator chunk was already
// lazy, and everything around it — the lease line, the pane, the focus ring — was not,
// so the initial graph carried the whole terminal surface for every session that never
// opens one.
//
// Split from the component beside it for that file's reason too: the registration terms
// are assertable without rendering anything, and a module rather than a sub-module door.

// THE FAMILY'S FOUR STYLESHEETS ENTER HERE, which finishes the split the emulator
// already had half of: `@xterm/xterm/css/xterm.css` has always ridden the emulator's own
// chunk, and these four sat on the initial document beside it. The family registers one
// kind, as a loader, so this module is the only way into any of it — rules included.
// The focus ring is at the family root because two directories spend it; it travels
// here with the rest because both of them are behind this boundary.
import "./pane.css";
import "../lease/lease.css";
import "../emulator/emulator.css";
import "../focus-ring.css";

import { paneBodyForKind, type ConsolePaneContext } from "../../seats/index.js";
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
 *
 * `render` goes through `paneBodyForKind` for `browser/pane/browser-pane-body.ts`'s
 * reason, and it bites harder here: this body opens a subscription on the session's
 * one shared shell, so a mount at another kind's address would put a second surface on
 * that shell rather than merely drawing the wrong head.
 */
export const Body: (context: ConsolePaneContext) => React.ReactNode = paneBodyForKind(
  "terminal",
  TerminalPane,
);
