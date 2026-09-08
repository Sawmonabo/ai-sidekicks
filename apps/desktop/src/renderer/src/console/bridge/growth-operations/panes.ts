// The pane plane's ledger rows: the browser namespace and its tool relay, the
// terminal namespace and its write lease, and the dev-server probe.
//
// The auxiliary-window operations that used to sit here are gone from the ledger,
// which is what a wire landing looks like: `SidekicksBridge.window` is registered
// and `src/main/auxiliary-window-ipc.ts` serves it, so they are reached through
// `bridge/auxiliary-window-port.ts` and no longer through anything that refuses.
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
  `browser${string}` | `terminal${string}` | "devServerProbe"
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
  browserSelect: op(
    "browserSelect",
    "browser-pane-namespace",
    "method",
    "pin an owned page as the pane's selected tab, without showing it",
  ),
  browserReorder: op(
    "browserReorder",
    "browser-pane-namespace",
    "method",
    "move a page to an index in the list that excludes the moved page",
  ),
  browserShow: op(
    "browserShow",
    "browser-pane-namespace",
    "method",
    "show one owned page in the pane",
  ),
  browserHide: op(
    "browserHide",
    "browser-pane-namespace",
    "method",
    "hide whatever page the pane is showing",
  ),
  browserCreate: op(
    "browserCreate",
    "browser-pane-namespace",
    "method",
    "create a blank page the pane owns",
  ),
  browserClose: op("browserClose", "browser-pane-namespace", "method", "close one owned page"),
  browserDevtools: op(
    "browserDevtools",
    "browser-pane-namespace",
    "method",
    "open developer tools on one owned page",
  ),
  browserSubscribePages: op(
    "browserSubscribePages",
    "browser-pane-namespace",
    "subscription",
    "the pages this session owns and the browsing context's name, for the strip and the picker",
  ),
  browserCapture: op(
    "browserCapture",
    "browser-pane-namespace",
    "method",
    "screenshot the visible page into the session's artifacts",
  ),
  browserProducedArtifacts: op(
    "browserProducedArtifacts",
    "browser-pane-namespace",
    "method",
    "which of the session's artifacts came out of the browser, for the produced-object shelf",
  ),
  browserPickElement: op(
    "browserPickElement",
    "browser-pane-namespace",
    "method",
    "arm hover-highlight so the next click composes an element reference",
  ),
  browserOpenFile: op(
    "browserOpenFile",
    "browser-pane-namespace",
    "method",
    "open a local file, subject to the daemon's mount-envelope containment check",
  ),
  browserRevealPageFile: op(
    "browserRevealPageFile",
    "browser-pane-namespace",
    "method",
    "show a page's own local file in the file manager, resolving the path where the page is",
  ),
  browserPaneAttach: op(
    "browserPaneAttach",
    "browser-pane-namespace",
    "method",
    "attach a view to this pane, optionally at a destination",
  ),
  browserPaneDetach: op(
    "browserPaneDetach",
    "browser-pane-namespace",
    "method",
    "detach the pane's view and tear it down; idempotent, because window teardown fires it too",
  ),
  browserPublishChordMirror: op(
    "browserPublishChordMirror",
    "browser-pane-namespace",
    "method",
    "publish the console's installed chords so the view's host can claim them from a page",
  ),
  browserSubscribeAccelerators: op(
    "browserSubscribeAccelerators",
    "browser-pane-namespace",
    "subscription",
    "claimed keystrokes handed back from a page for the renderer to replay",
  ),
  browserPolicyRead: op(
    "browserPolicyRead",
    "browser-pane-namespace",
    "method",
    "the two node-wide browser switches — the file boundary and the page-tool grant",
  ),
  browserPolicyWrite: op(
    "browserPolicyWrite",
    "browser-pane-namespace",
    "method",
    "flip one node-wide browser switch",
  ),
  browserSiteDataList: op(
    "browserSiteDataList",
    "browser-pane-namespace",
    "method",
    "the per-session site-data partitions this node holds, with the bytes each one stores",
  ),
  browserSiteDataClear: op(
    "browserSiteDataClear",
    "browser-pane-namespace",
    "method",
    "clear one session's stored site data, after its browser panes have been closed",
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
    // The registered pair, named here rather than left to a scenario to invent:
    // `api-payload-contracts.md §Session Terminal-Control Method Registry` declares
    // both, and a scenario scripting either is held to these names.
    "session.takeControl",
  ),
  terminalReleaseWriteLease: op(
    "terminalReleaseWriteLease",
    "terminal-pane",
    "method",
    "give the write lease back",
    "session.releaseControl",
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
};
