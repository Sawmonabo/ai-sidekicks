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
  terminalAcquireWriteLease: {
    request: { readonly terminalId: string };
    value: { readonly granted: boolean };
  };
  terminalReleaseWriteLease: { request: { readonly terminalId: string }; value: void };
  devServerProbe: { request: { readonly port: number }; value: { readonly listening: boolean } };
  windowDetachPane: { request: { readonly paneId: string }; value: { readonly windowId: string } };
  windowFocusAuxiliary: { request: { readonly windowId: string }; value: void };
  windowCloseAuxiliary: { request: { readonly windowId: string }; value: void };
  windowSubscribePaneErrors: {
    request: Record<string, never>;
    value: GrowthStream<GrowthPaneError>;
  };
}
