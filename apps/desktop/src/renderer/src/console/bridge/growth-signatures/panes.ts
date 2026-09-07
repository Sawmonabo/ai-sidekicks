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
   * forbids deriving the holder from the last observed claim and says what the
   * holder is instead — a wire field — so this reply is read as the settlement of
   * one claim and `terminalControlHolderRead` below is what any surface asks when
   * it needs to know who holds the lease.
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
  /**
   * Who holds this session's one shared-terminal write lease.
   *
   * SESSION-SCOPED, because the lease is: V1 has exactly one shared terminal per
   * session, so a request naming a pane or a node would be naming something the
   * lease is not keyed by.
   *
   * `null` is a REAL answer and not an absence — the registered member resolves to
   * null both when nobody holds the lease and when the holding node reads offline,
   * and a surface that rendered those as "not read yet" would be hiding the one
   * state 8.8 requires it to draw distinctly.
   */
  terminalControlHolderRead: {
    request: { readonly sessionId: string };
    value: { readonly controlHolder: string | null };
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
