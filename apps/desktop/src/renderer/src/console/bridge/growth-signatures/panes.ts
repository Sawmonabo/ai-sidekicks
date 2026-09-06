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
  GrowthAcceleratorChord,
  GrowthBrowserPage,
  GrowthBrowserPageList,
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
   * The page-lifecycle acts the strip and the picker dispatch.
   *
   * One row each rather than one `browserAct` row taking an action name, because the
   * navigation verbs that landed first are one row each and a mixed table would be two
   * ways to say the same thing. What the wire eventually spells is the owning
   * document's; what this table owes is a request shape per act, and these are the
   * shapes the pane's own controls have arguments for.
   */
  browserSelect: { request: { readonly paneId: string; readonly pageId: string }; value: void };
  /**
   * Move one page to an index in the list WITHOUT that page in it.
   *
   * The index convention is the registry's and it is stated here because it is the
   * request member's meaning: the renderer's drop slot is a position among the tabs
   * as drawn, and the translation between the two runs at the strip's one call site.
   */
  browserReorder: {
    request: { readonly paneId: string; readonly pageId: string; readonly toIndex: number };
    value: void;
  };
  browserShow: { request: { readonly paneId: string; readonly pageId: string }; value: void };
  /** Hide whatever page the pane is showing. Addresses no page: there is one shown. */
  browserHide: { request: { readonly paneId: string }; value: void };
  browserCreate: { request: { readonly paneId: string }; value: { readonly pageId: string } };
  browserClose: { request: { readonly paneId: string; readonly pageId: string }; value: void };
  browserDevtools: { request: { readonly paneId: string; readonly pageId: string }; value: void };
  /** The strip's and the picker's reading: every page, and the context's own name. */
  browserSubscribePages: {
    request: { readonly paneId: string };
    value: GrowthStream<GrowthBrowserPageList>;
  };
  /**
   * Screenshot the visible page into the session's artifacts.
   *
   * It answers with the artifact id and nothing else: the bytes go through the ingest
   * pipeline, and the row a person reads is the artifact row the timeline already
   * carries. No scope member — the human control captures what is on screen, and the
   * viewport / clip / full-page choice belongs to the page tool that offers it.
   */
  browserCapture: {
    request: { readonly paneId: string };
    value: {
      readonly artifactId: string;
      /** The encoded type the pipeline stored, wire-verbatim. Never checked here. */
      readonly mediaType: string;
      /** What was stored, so the row can state a size without a second read. */
      readonly byteLength: number;
    };
  };
  /** Arm hover-highlight. The chip the next click composes travels as a tool result. */
  browserPickElement: { request: { readonly paneId: string }; value: void };
  /**
   * Open a local file, subject to the mount envelope's containment check.
   *
   * The check is the daemon's and never this renderer's: the request carries what the
   * person chose and the answer is the daemon's admission or its refusal, which is
   * why nothing here narrows the path.
   */
  browserOpenFile: { request: { readonly paneId: string; readonly path: string }; value: void };
  /** Clear this session's partition. Session-keyed because the partition is. */
  browserClearSiteData: { request: { readonly sessionId: string }; value: void };
  /**
   * Show a page's own local file in the file manager.
   *
   * The request names the pane and the page and carries no path, which is the whole
   * point: the resolution happens where the page is, and a raw path never crosses the
   * bridge in either direction.
   */
  browserRevealPageFile: {
    request: { readonly paneId: string; readonly pageId: string };
    value: void;
  };
  /** Attach a view to this pane, optionally at a destination. */
  browserPaneAttach: {
    request: { readonly paneId: string; readonly url?: string };
    value: { readonly page: GrowthBrowserPage };
  };
  /** Tear the view down. Idempotent, because window teardown fires it too. */
  browserPaneDetach: { request: { readonly paneId: string }; value: void };
  /**
   * Publish the chords the console has installed, so the view's host can claim them.
   *
   * A LIST OF CHORDS AND NOT A TABLE OF COMMANDS. The mirror holds which chords exist
   * and never what they mean; a claimed keystroke comes back and is replayed here,
   * where the `when` grammar, the operator's rebindings, and the palette are all the
   * same code path they are anywhere else.
   */
  browserPublishChordMirror: {
    request: { readonly paneId: string; readonly chords: readonly string[] };
    value: void;
  };
  /** The claimed keystrokes coming back, for the renderer to replay. */
  browserSubscribeAccelerators: {
    request: { readonly paneId: string };
    value: GrowthStream<GrowthAcceleratorChord>;
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
