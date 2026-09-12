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
  browserNavigate: op("browserNavigate", "browser-pane-namespace", "method"),
  browserReload: op("browserReload", "browser-pane-namespace", "method"),
  browserStopLoading: op("browserStopLoading", "browser-pane-namespace", "method"),
  browserGoBack: op("browserGoBack", "browser-pane-namespace", "method"),
  browserGoForward: op("browserGoForward", "browser-pane-namespace", "method"),
  browserSubscribeNavigation: op(
    "browserSubscribeNavigation",
    "browser-pane-namespace",
    "subscription",
  ),
  browserSubscribeToolCalls: op("browserSubscribeToolCalls", "browser-tool-relay", "subscription"),
  browserRespondToToolCall: op("browserRespondToToolCall", "browser-tool-relay", "method"),
  browserSelect: op("browserSelect", "browser-pane-namespace", "method"),
  browserReorder: op("browserReorder", "browser-pane-namespace", "method"),
  browserShow: op("browserShow", "browser-pane-namespace", "method"),
  browserHide: op("browserHide", "browser-pane-namespace", "method"),
  browserCreate: op("browserCreate", "browser-pane-namespace", "method"),
  browserClose: op("browserClose", "browser-pane-namespace", "method"),
  browserDevtools: op("browserDevtools", "browser-pane-namespace", "method"),
  browserSubscribePages: op("browserSubscribePages", "browser-pane-namespace", "subscription"),
  browserCapture: op("browserCapture", "browser-pane-namespace", "method"),
  browserProducedArtifacts: op("browserProducedArtifacts", "browser-pane-namespace", "method"),
  browserPickElement: op("browserPickElement", "browser-pane-namespace", "method"),
  browserOpenFile: op("browserOpenFile", "browser-pane-namespace", "method"),
  browserRevealPageFile: op("browserRevealPageFile", "browser-pane-namespace", "method"),
  browserPaneAttach: op("browserPaneAttach", "browser-pane-namespace", "method"),
  browserPaneDetach: op("browserPaneDetach", "browser-pane-namespace", "method"),
  browserPublishChordMirror: op("browserPublishChordMirror", "browser-pane-namespace", "method"),
  browserSubscribeAccelerators: op(
    "browserSubscribeAccelerators",
    "browser-pane-namespace",
    "subscription",
  ),
  browserPolicyRead: op("browserPolicyRead", "browser-pane-namespace", "method"),
  browserPolicyWrite: op("browserPolicyWrite", "browser-pane-namespace", "method"),
  browserSiteDataList: op("browserSiteDataList", "browser-pane-namespace", "method"),
  browserSiteDataClear: op("browserSiteDataClear", "browser-pane-namespace", "method"),
  terminalSubscribeOutput: op("terminalSubscribeOutput", "terminal-pane", "subscription"),
  terminalWrite: op("terminalWrite", "terminal-pane", "method"),
  terminalResize: op("terminalResize", "terminal-pane", "method"),
  terminalAcquireWriteLease: op(
    "terminalAcquireWriteLease",
    "terminal-pane",
    "method",
    // The registered pair, named here rather than left to a scenario to invent: the
    // terminal-control method registry declares both, and a scenario scripting either
    // is held to these names.
    "session.takeControl",
  ),
  terminalReleaseWriteLease: op(
    "terminalReleaseWriteLease",
    "terminal-pane",
    "method",
    "session.releaseControl",
  ),
  // The holder READ, which is neither of the two lease verbs above and is not the
  // pane's at all: it is what every surface that renders presence needs in order to
  // mark the holder without opening the terminal. It names no wire method because the
  // holder is a member of the runtime-node roster reply rather than a method, and the
  // shipped strict schema drops it — so a caller reading the roster today gets every
  // node and no holder.
  terminalControlHolderRead: op("terminalControlHolderRead", "terminal-control-holder", "method"),
  devServerProbe: op("devServerProbe", "dev-server-probe", "method"),
};
