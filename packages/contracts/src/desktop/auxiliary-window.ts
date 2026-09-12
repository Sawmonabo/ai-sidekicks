// The auxiliary-window namespace of the desktop bridge — shapes, channel names, and
// the control surface, for all three processes.
//
// ITS OWN MODULE rather than another section of `../desktop-bridge.ts`, because it is
// the one namespace that is SERVED rather than stubbed: `apps/desktop/src/main/`
// registers handlers for these channels and the preload replaces the throwing stub
// with a real `ipcRenderer` implementation, so this file is read by main, by preload,
// and by the renderer, while the rest of that module is a declaration nobody
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
 * The key a pane belonging to no session is filed under.
 *
 * A named value rather than an empty string, because it is a KEY and not an absent
 * one: a workspace opened at a bare auxiliary route still holds panes of its own, and
 * they must not share a record with whichever session happens to be first.
 *
 * The unit-separator prefix is `apps/desktop`'s own rule for a synthetic key — a
 * control character no wire-minted id carries — written as an ESCAPE so the source
 * file stays text: a raw control byte in one made git read a whole module as binary.
 */
const NO_SESSION_KEY = "\u001fno-session";

/**
 * The session a pane belongs to, as a key.
 *
 * Here rather than beside either reader because BOTH processes key on it and the two
 * answers must be one: the renderer files its hand-offs by session so a returning
 * visit reads the record its own deck wrote, and the main process files its held
 * windows by the same session so two decks' identically-named panes are two panes.
 * Spelled twice, the two would drift and the drift would be silent — a detach
 * answering with another session's window.
 */
export function auxiliaryWindowSessionKey(sessionId: string | undefined): string {
  return sessionId ?? NO_SESSION_KEY;
}

/**
 * The identity of one pane across every session the shell is serving.
 *
 * WHY A PANE ID ALONE IS NOT ONE. Every deck mints its panes as `pane-N` from its own
 * layout, so two sessions both hold a `pane-1`; a registry keyed on that name alone
 * answers the second session's detach with the first session's window, focuses it,
 * and leaves the second deck suppressing a pane whose body was never opened.
 *
 * RENDERED THROUGH `JSON.stringify` rather than through the separator-joined key
 * `deck-model.ts` uses, and the difference is the inputs rather than taste: that rule
 * is injective because every field before the last comes from a closed set, and here
 * both fields are strings a renderer supplies over IPC. A pair rendered as JSON is
 * injective whatever either field contains, because the encoding escapes the
 * separator it uses.
 */
export function auxiliaryPaneIdentity(sessionId: string | undefined, paneId: string): string {
  return JSON.stringify([auxiliaryWindowSessionKey(sessionId), paneId]);
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
 * It names the PANE because the deck slot is what has to hear about it, and carries
 * the reason because a pane that silently reappears tells the person nothing.
 *
 * IT NAMES THE WINDOW FOR THE REASON {@link AuxiliaryWindowPaneReturn} DOES, and the
 * report used to carry only the pane. One renderer holds every session's hand-off and
 * the shell reports to a renderer, so every hand-off in a window reads every report;
 * every deck mints its panes as `pane-N` from its own layout, so a report naming only
 * the pane matched a session that had nothing to do with the crash — and that session
 * took its own still-open window's placeholder down and filed a crash note about a
 * window that never died. The handle is what tells one report's subject from another.
 */
export interface AuxiliaryWindowPaneError {
  readonly windowId: string;
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
 * The two carry the same two identities, and the window is the load-bearing half of
 * both: a pane can be detached again into a second window, so a return naming only
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
