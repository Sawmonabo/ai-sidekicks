// The auxiliary-window namespace of the desktop bridge — shapes, channel names, and
// the control surface, for all three processes.
//
// ITS OWN MODULE rather than another section of `../desktop-bridge.ts`, because it is
// the one namespace that is SERVED rather than stubbed: `apps/desktop/src/main/`
// registers handlers for these channels and the preload replaces the throwing stub
// with a real `ipcRenderer` implementation, so this file is read by main, by preload,
// and by the renderer, while the rest of that module is a Tier-1 declaration nobody
// implements yet. Keeping it here means a shell change touches a file about the shell.
//
// AND IN THIS PACKAGE RATHER THAN IN `apps/desktop/src/shared/`, because the preload
// may import exactly two things — `electron` and this package — and all three
// processes need these shapes. The channel names travel with them for the same
// reason: a channel string spelled once in main and once in preload is two places for
// one wire to be edited, and the drift is silent — `invoke` on an unhandled channel
// rejects with a message about a handler that does not exist, which reads like a
// missing feature rather than a typo.

import type { Unsubscribe } from "../desktop-bridge.js";

/**
 * Which pane to move into a window of its own, and what that window is a view of.
 *
 * `route` is typed `string` rather than a union, deliberately: the closed
 * auxiliary-route set is a desktop-package fact (`apps/desktop/src/shared/auxiliary-routes.ts`,
 * which the renderer and the main process both read and which this package cannot
 * import without inverting the dependency). The main process validates the value
 * against that set before constructing anything and refuses an unknown one, which
 * is where the check belongs anyway — a renderer-supplied route is untrusted input
 * whatever its static type says.
 */
export interface AuxiliaryWindowDetachRequest {
  readonly paneId: string;
  readonly route: string;
  readonly sessionId?: string;
  readonly agentId?: string;
}

/**
 * The shell's handle for one auxiliary window.
 *
 * OPAQUE to the renderer: focus, close, and the orderly-return report are all
 * addressed by it and nothing above the main process parses it.
 */
export interface AuxiliaryWindowHandle {
  readonly windowId: string;
}

/**
 * A window that stopped being open without anybody asking, as the shell reports it.
 *
 * Keyed by PANE because the deck slot is what has to hear about it, and carrying
 * the reason because a pane that silently reappears tells the person nothing.
 */
export interface AuxiliaryWindowPaneError {
  readonly paneId: string;
  readonly reason: string;
}

/**
 * A window that was asked to close and did, as the shell reports it.
 *
 * A separate shape from {@link AuxiliaryWindowPaneError} and not a widening of it:
 * the two report opposite facts, and folded into one shape with a nullable reason
 * the deck would have to read a member to tell a crash from a return.
 *
 * It carries the WINDOW as well as the pane, and the window is the load-bearing
 * half: a pane can be detached again into a second window, so a return naming only
 * the pane cannot say which window it is about.
 */
export interface AuxiliaryWindowPaneReturn {
  readonly windowId: string;
  readonly paneId: string;
}

/** The IPC channel each auxiliary-window operation and report travels on. */
export interface AuxiliaryWindowChannels {
  readonly detachPane: string;
  readonly focusAuxiliary: string;
  readonly closeAuxiliary: string;
  readonly paneError: string;
  readonly paneReturn: string;
}

/**
 * The channel names, spelled once for both sides of the boundary.
 *
 * Namespaced so a channel this package declares cannot collide with one another
 * plan registers on the same `ipcMain`.
 */
export const AUXILIARY_WINDOW_CHANNELS: AuxiliaryWindowChannels = {
  detachPane: "sidekicks:window/detach-pane",
  focusAuxiliary: "sidekicks:window/focus-auxiliary",
  closeAuxiliary: "sidekicks:window/close-auxiliary",
  paneError: "sidekicks:window/pane-error",
  paneReturn: "sidekicks:window/pane-return",
};

/**
 * The shell's auxiliary-window controls, as the renderer reaches them.
 *
 * Named as a type of its own so the preload can annotate the object it builds
 * against the same declaration the bridge carries — an object literal handed
 * straight to `exposeInMainWorld` is checked against nothing.
 */
export interface AuxiliaryWindowControls {
  detachPane(request: AuxiliaryWindowDetachRequest): Promise<AuxiliaryWindowHandle>;
  focusAuxiliary(request: AuxiliaryWindowHandle): Promise<void>;
  closeAuxiliary(request: AuxiliaryWindowHandle): Promise<void>;
  subscribePaneErrors(handler: (event: AuxiliaryWindowPaneError) => void): Unsubscribe;
  subscribePaneReturns(handler: (event: AuxiliaryWindowPaneReturn) => void): Unsubscribe;
}
