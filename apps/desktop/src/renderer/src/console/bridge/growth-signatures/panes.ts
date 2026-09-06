// The pane plane: what a browser pane, a terminal pane, and the auxiliary windows
// that host them take and give back.
//
// One plane of `GrowthOperationSignatures`, composed into it by `index.ts`. The
// rows here are the ones addressed to a PANE rather than to the session behind it:
// the browser namespace and its tool relay, the terminal namespace and its write
// lease, the dev-server probe a browser pane makes before it navigates, and the
// window operations that detach a pane into an auxiliary window and report the
// errors it raises there.

import type { GrowthStream } from "../growth-port/growth-outcome.js";
import type {
  GrowthNavigationState,
  GrowthPaneError,
  GrowthTerminalChunk,
  GrowthToolCall,
} from "../growth-values/index.js";

export interface PaneGrowthSignatures {
  browserNavigate: { request: { readonly paneId: string; readonly url: string }; value: void };
  browserReload: { request: { readonly paneId: string }; value: void };
  browserStopLoading: { request: { readonly paneId: string }; value: void };
  browserGoBack: { request: { readonly paneId: string }; value: void };
  browserGoForward: { request: { readonly paneId: string }; value: void };
  browserSubscribeNavigation: {
    request: { readonly paneId: string };
    value: GrowthStream<GrowthNavigationState>;
  };
  browserSubscribeToolCalls: {
    request: { readonly sessionId: string };
    value: GrowthStream<GrowthToolCall>;
  };
  browserRespondToToolCall: {
    request: { readonly toolCallId: string; readonly resultJson: string };
    value: void;
  };
  /**
   * The two node-wide browser switches, keyed by the console's own switch ids.
   *
   * A record rather than a pair of named booleans, so a third switch is a value the
   * daemon sends rather than a shape change here — and the console's own closed
   * `BROWSER_POLICY_SWITCHES` tuple decides which of them it draws a row for, which
   * is where that set is already declared once.
   */
  browserPolicyRead: { request: Record<string, never>; value: Readonly<Record<string, boolean>> };
  browserPolicyWrite: {
    request: { readonly switchId: string; readonly enabled: boolean };
    value: void;
  };
  /**
   * The partitions this node stores, one per session that has opened a browser pane.
   *
   * `storedByteLength` is optional rather than zero-defaulted: a partition the node
   * could not measure is a different fact from an empty one, and the settings page
   * renders the two differently — a zero standing in for an unmeasured partition is
   * the one claim a clear control must not make falsely.
   */
  browserSiteDataList: {
    request: Record<string, never>;
    value: readonly {
      readonly sessionId: string;
      readonly sessionTitle: string;
      readonly storedByteLength?: number | undefined;
      readonly hasOpenPane: boolean;
    }[];
  };
  browserSiteDataClear: { request: { readonly sessionId: string }; value: void };
  terminalSubscribeOutput: {
    request: { readonly terminalId: string };
    value: GrowthStream<GrowthTerminalChunk>;
  };
  terminalWrite: { request: { readonly terminalId: string; readonly data: string }; value: void };
  terminalResize: {
    request: { readonly terminalId: string; readonly columns: number; readonly rows: number };
    value: void;
  };
  /**
   * Take the shared-terminal write lease.
   *
   * The registered pair, not a console invention: `api-payload-contracts.md
   * §Session Terminal-Control Method Registry` declares `SessionTakeControlRequest
   * { sessionId }` answering `SessionTakeControlResponse { controlHolder }`, and a
   * session has exactly one shared terminal, so the session IS the lease's subject
   * on the wire. A pane-keyed request would be refused by the strict schema before
   * either lease operation could run.
   *
   * `controlHolder` is carried because the reply carries it, and is deliberately
   * NOT what moves the holder line: `Spec-023 §Console Design (Meridian)` 8.8
   * forbids deriving the holder from the last observed claim, so the surface folds
   * the `pty.control_changed` transition and reads this only as the reply it was.
   */
  terminalAcquireWriteLease: {
    request: { readonly sessionId: string };
    value: { readonly controlHolder: string };
  };
  /** Give the lease back. The registered response frees it, so the holder is null. */
  terminalReleaseWriteLease: {
    request: { readonly sessionId: string };
    value: { readonly controlHolder: null };
  };
  devServerProbe: { request: { readonly port: number }; value: { readonly listening: boolean } };
  windowDetachPane: { request: { readonly paneId: string }; value: { readonly windowId: string } };
  windowFocusAuxiliary: { request: { readonly windowId: string }; value: void };
  windowCloseAuxiliary: { request: { readonly windowId: string }; value: void };
  windowSubscribePaneErrors: {
    request: Record<string, never>;
    value: GrowthStream<GrowthPaneError>;
  };
}
