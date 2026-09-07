// The pane plane's ledger rows: the browser namespace and its tool relay, the
// terminal namespace and its write lease, the dev-server probe, and the window
// operations that detach a pane and report the errors it raises.
//
// One plane of `GROWTH_OPERATIONS`, composed into it by `index.ts`.

import type { GrowthOperationEntry, GrowthOperationId } from "../growth-port/growth-entry.js";
import { op } from "./operation-entry.js";

/**
 * The ids this plane carries, DERIVED from the id union rather than listed again.
 *
 * `Extract` against the plane's own name pattern is what makes the annotation below
 * exhaustive in both directions: a row this plane owns and forgot fails here, and a
 * key that is not an operation id fails here too. A hand-written list would be a
 * second copy of the id set — the thing `growth-entry.ts` exists to prevent.
 */
type PaneOperationId = Extract<
  GrowthOperationId,
  `browser${string}` | `terminal${string}` | `window${string}` | "devServerProbe"
>;

/** The pane rows, in the order the single table carried them. */
export const PANE_GROWTH_OPERATIONS: Readonly<Record<PaneOperationId, GrowthOperationEntry>> = {
  browserNavigate: op(
    "browserNavigate",
    "browser-pane-namespace",
    "method",
    "navigate the embedded browser pane to a URL",
  ),
  browserReload: op(
    "browserReload",
    "browser-pane-namespace",
    "method",
    "reload the embedded browser pane",
  ),
  browserStopLoading: op(
    "browserStopLoading",
    "browser-pane-namespace",
    "method",
    "stop an in-flight page load",
  ),
  browserGoBack: op(
    "browserGoBack",
    "browser-pane-namespace",
    "method",
    "step back in the pane's history",
  ),
  browserGoForward: op(
    "browserGoForward",
    "browser-pane-namespace",
    "method",
    "step forward in the pane's history",
  ),
  browserSubscribeNavigation: op(
    "browserSubscribeNavigation",
    "browser-pane-namespace",
    "subscription",
    "navigation state for the pane's chrome (URL, title, loading, history depth)",
  ),
  browserSubscribeToolCalls: op(
    "browserSubscribeToolCalls",
    "browser-tool-relay",
    "subscription",
    "daemon-to-desktop relay of agent browser tool calls awaiting execution",
  ),
  browserRespondToToolCall: op(
    "browserRespondToToolCall",
    "browser-tool-relay",
    "method",
    "return a browser tool call's result to the daemon",
  ),
  terminalSubscribeOutput: op(
    "terminalSubscribeOutput",
    "terminal-pane",
    "subscription",
    "terminal output stream for a shared terminal session",
  ),
  terminalWrite: op(
    "terminalWrite",
    "terminal-pane",
    "method",
    "write participant keystrokes, subject to the write lease",
  ),
  terminalResize: op(
    "terminalResize",
    "terminal-pane",
    "method",
    "report the pane's column and row count",
  ),
  terminalAcquireWriteLease: op(
    "terminalAcquireWriteLease",
    "terminal-pane",
    "method",
    "take the shared-terminal write lease",
  ),
  terminalReleaseWriteLease: op(
    "terminalReleaseWriteLease",
    "terminal-pane",
    "method",
    "give the write lease back",
  ),
  // The holder READ, which is neither of the two lease verbs above and is not the
  // pane's at all: it is what every surface that renders presence needs in order to
  // mark the holder without opening the terminal. It names no wire method because the
  // holder is a member of the runtime-node roster reply rather than a method, and the
  // shipped strict schema drops it — so a caller reading the roster today gets every
  // node and no holder.
  terminalControlHolderRead: op(
    "terminalControlHolderRead",
    "terminal-control-holder",
    "method",
    "read which participant holds this session's one shared-terminal write lease, so the holder can be marked wherever presence renders rather than only inside the pane",
  ),
  devServerProbe: op(
    "devServerProbe",
    "dev-server-probe",
    "method",
    "probe whether a local dev server is listening, for the browser pane's chip",
  ),
  windowDetachPane: op(
    "windowDetachPane",
    "window-control-namespace",
    "method",
    "detach a pane into an auxiliary window",
  ),
  windowFocusAuxiliary: op(
    "windowFocusAuxiliary",
    "window-control-namespace",
    "method",
    "focus an auxiliary window",
  ),
  windowCloseAuxiliary: op(
    "windowCloseAuxiliary",
    "window-control-namespace",
    "method",
    "close an auxiliary window",
  ),
  windowSubscribePaneErrors: op(
    "windowSubscribePaneErrors",
    "window-control-namespace",
    "subscription",
    "the crashed-window pane-error signal",
  ),
};
