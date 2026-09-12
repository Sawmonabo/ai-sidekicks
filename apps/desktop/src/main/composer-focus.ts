// The composer chord, answered in the one process that can answer it.
//
// The detached timeline window is the same pane at full width and no composer,
// and the rule this module exists for follows from that: a composer chord
// pressed there focuses the main window's composer. Before it, pressing the
// chord in an auxiliary window did nothing at all and said nothing about why —
// the keystroke reached a renderer with no composer bound to it.
//
// WHY MAIN. An auxiliary window is its own renderer process with its own preload,
// its own bridge instance, and no store shared with the main window. Nothing
// inside it can reach another window: the bridge's `window` namespace
// addresses auxiliary windows — detach, focus, close — and no namespace
// reaches into the main window's composer. The main process owns both windows, so
// it is the only party that can act on the press, and `before-input-event` is how
// it sees a keystroke: the event
// is delivered to the main process BEFORE the page sees it, so the chord is
// answered and consumed without the auxiliary renderer needing a binding for a
// control it does not have.
//
// BOTH HALVES OF THE ACT, AND WHY THE SECOND ONE IS A REQUEST. Bringing the window
// forward is main's own act. Moving the caret is not: the composer's input element
// belongs to the window that draws one, is created and destroyed by its own mount,
// and `focus()` on a `BrowserWindow` keys the WINDOW rather than an element inside
// it — so a person whose main window was last on a ledger row or a sidebar control
// was returned to that control and not to the line they had asked for. So main asks,
// on `COMPOSER_FOCUS_REQUEST_CHANNEL`, and the renderer decides what focusing means.
// Both halves read `../shared/composer-chord.ts`, so they are one act rather than two.
//
// THE REQUEST IS SENT WHETHER OR NOT THE WINDOW TOOK KEYS. Revealing is a claim on a
// person's screen and `./window-reveal.ts` governs it; moving the caret inside a
// window is not, so an automated tier's unrevealed window still receives the ask and
// answers it in the document it already has. A request that reaches a renderer with no
// composer mounted is dropped by the seat that receives it, which is that seat's own
// stated rule and not a second one invented here.
//
// THE REVEAL GOES THROUGH THE ONE REVEAL SITE. `./window-reveal.ts` owns how a
// window is put on screen, including the test-build policy that keeps an automated
// tier from stealing an operator's focus. Calling `show()` here would be a second
// reveal site with its own answer to that question, which is exactly the drift that
// module was written to prevent.

import { type App, type BrowserWindow, type WebContents } from "electron";

import {
  COMPOSER_FOCUS_REQUEST_CHANNEL,
  composerChordPrimaryModifier,
  matchesComposerFocusChord,
} from "../shared/composer-chord.js";
import { revealWindow } from "./window-reveal.js";

/**
 * A window whose keystrokes are watched for the chord.
 *
 * The `webContents` alone, and only its listener registration: this module reads
 * nothing else off the window it watches, and a wider type would let a later edit
 * reach for state that belongs to the window's own factory.
 */
export interface ComposerChordHostWindow {
  readonly webContents: Pick<WebContents, "on">;
}

/**
 * The window the chord brings forward — the one that has the composer.
 *
 * `isDestroyed` is first among these for a reason: a window closed between the
 * keystroke and this call is not an error, and every other method on a destroyed
 * `BrowserWindow` throws.
 *
 * `webContents` is narrowed to the one method this module calls, on
 * {@link ComposerChordHostWindow}'s precedent and for its reason: the request is the
 * only thing said to the page from here, and a whole `WebContents` would let a later
 * edit reach for navigation, execution, or input injection through a window handle
 * that was resolved for a keystroke.
 */
export type ComposerFocusTargetWindow = Pick<
  BrowserWindow,
  "isDestroyed" | "isMinimized" | "isVisible" | "restore" | "focus" | "show" | "showInactive"
> & {
  readonly webContents: Pick<WebContents, "send">;
};

/**
 * Watch `hostWindow` for the composer chord, and bring the composer's window
 * forward when it is pressed.
 *
 * `resolveComposerWindow` is a GETTER rather than a window, on
 * `sidecar-lifecycle.ts`' precedent and for its reason: the main window is
 * replaceable over the life of the application — it is set to `null` on close — and
 * a handle captured at install time would keep answering with a window that is gone.
 * A getter answering `null` is the honest "there is no composer to go to", and the
 * press is then left to the renderer rather than consumed by this handler.
 *
 * Installing this on the window that HAS the composer would be a loop: the chord
 * would be consumed here and never reach the binding that moves the caret. The
 * caller decides which windows are hosts; `index.ts` excludes the main one.
 */
export function installComposerFocusChord(
  hostWindow: ComposerChordHostWindow,
  resolveComposerWindow: () => ComposerFocusTargetWindow | null,
  platform: NodeJS.Platform = process.platform,
): void {
  const primaryModifier = composerChordPrimaryModifier(platform);
  hostWindow.webContents.on("before-input-event", (event, input) => {
    // KEY DOWN ONLY. Electron delivers `keyDown` and `keyUp` for one press, and a
    // handler that matched both would run the act twice — and, worse, consume the
    // `keyUp` of a chord whose `keyDown` reached a renderer that is now holding a
    // modifier it never sees released.
    if (input.type !== "keyDown" || !matchesComposerFocusChord(input, primaryModifier)) {
      return;
    }
    const composerWindow = resolveComposerWindow();
    if (composerWindow === null || composerWindow.isDestroyed()) {
      // Nothing to go to. The press is NOT consumed: leaving it to the page keeps
      // this handler from silently swallowing a keystroke a renderer may bind.
      return;
    }
    // Consumed only once the act is certain to be performed, and before performing
    // it: a page that also acted on the chord would race the window change.
    event.preventDefault();
    if (composerWindow.isMinimized()) {
      // `show()` alone leaves a minimised window minimised on Windows and Linux.
      composerWindow.restore();
    }
    revealWindow(composerWindow, platform);
    if (composerWindow.isVisible()) {
      // Ordering keys AFTER the reveal, and guarded by it: an automated tier's
      // window is deliberately never revealed, and focusing one would be the focus
      // steal `./window-reveal.ts` exists to prevent.
      composerWindow.focus();
    }
    // LAST, AND UNGUARDED. Last, because the caret should land in a window that is
    // already on screen and already holding keys — a request answered ahead of the
    // reveal moves focus in a document nobody is looking at yet. Unguarded by
    // `isVisible()`, because this moves focus WITHIN a window rather than between
    // windows: it takes nothing from the operator's current application, so the
    // reveal policy has nothing to say about it, and an unrevealed window that
    // skipped it would answer the chord by going nowhere.
    composerWindow.webContents.send(COMPOSER_FOCUS_REQUEST_CHANNEL);
  });
}

/**
 * Install the chord on every window this application opens from now on, except the
 * one that has the composer.
 *
 * TWO EXCLUSIONS OF THE COMPOSER'S OWN WINDOW, and they are not redundant. The
 * identity check is the rule, stated where a reader looks for it. The ORDERING is
 * what makes it hold: `browser-window-created` is an event and not a registry, so a
 * caller that registers this after the main window exists never sees that window at
 * all — and the getter answers `null` for the whole of the main window's own
 * construction, which is precisely when an identity check would let it through.
 *
 * A per-window install rather than one global `web-contents-created` filter: the
 * handler closes over nothing but the getter, and attaching it to a window whose
 * `webContents` outlive nothing is how it is disposed — Electron drops the listener
 * with the contents it was registered on.
 */
export function watchAuxiliaryWindowsForComposerChord(
  app: Pick<App, "on">,
  resolveComposerWindow: () => BrowserWindow | null,
  platform: NodeJS.Platform = process.platform,
): void {
  app.on("browser-window-created", (_event, createdWindow) => {
    if (createdWindow === resolveComposerWindow()) {
      return;
    }
    installComposerFocusChord(createdWindow, resolveComposerWindow, platform);
  });
}
