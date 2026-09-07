// The pane surfaces' own values: what a browser pane reports, what a terminal pane
// streams, and how a pane says it could not open.
//
// One of the domain modules behind `growth-values/index.ts`. The barrel states the
// rules every value here obeys — why a shape earns a name, what belongs in the
// signature table instead, and what belongs in a module of its own — and publishes
// the whole set. Import from the barrel; this file is the domain's own text.

export interface GrowthNavigationState {
  readonly url: string;
  readonly title: string;
  readonly isLoading: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
}

export interface GrowthTerminalChunk {
  readonly terminalId: string;
  readonly data: string;
}

export interface GrowthPaneError {
  readonly paneId: string;
  readonly reason: string;
}

/**
 * A window that gave its pane back in an orderly way, as the shell reports it.
 *
 * A SEPARATE SHAPE FROM {@link GrowthPaneError} AND NOT A WIDENING OF IT, because
 * the two report opposite facts. A pane error is a window that stopped being open
 * without anybody asking; this is a window that was asked to close and did. Folded
 * into one shape with a nullable reason, the deck would have to read a member to
 * tell a crash from a return, and every reader that forgot would report a crash
 * that did not happen.
 *
 * It carries the WINDOW as well as the pane, and the window is the load-bearing
 * half: a pane can be detached again into a second window, so a return naming only
 * the pane cannot say which window it is about, and a late report about the first
 * would put back a pane whose body is currently in the second. The deck matches
 * the handle it recorded and ignores a return about any other.
 */
export interface GrowthPaneReturn {
  readonly windowId: string;
  readonly paneId: string;
}
