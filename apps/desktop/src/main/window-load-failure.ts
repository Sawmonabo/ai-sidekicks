// What a window does when its document will not load — Plan-023 Phase 1B
// (T-023p-1B-2).
//
// Split out of `./window.ts` so the factories read as construction and the
// recovery reads as one ladder: load, then the generated failure document, then
// give up. The three rungs are three functions in one file, in the order they
// run, because the property that matters — the recovery terminates — is a
// property of the ladder and not of any one rung.

import { app, type BrowserWindow } from "electron";

import { buildLoadFailureUrl } from "./load-failure-document.js";

/**
 * Which window a load belongs to, which decides what a total load failure costs.
 *
 * The main window's document IS the application: if not even the generated
 * failure document can be served for it, there is nothing left to interact with
 * and the process exits non-zero rather than sitting there as an invisible
 * placeholder a harness can only detect by timing out. An auxiliary window is a
 * detached pane; the same total failure destroys that window and leaves the
 * application running, because quitting the app because a detached console
 * failed would be the worse outcome.
 */
export type WindowRole = "main" | "auxiliary";

/**
 * Exit status when a window has no document it can serve — not even the
 * generated failure document.
 *
 * Joins the vocabulary `main/index.ts` already uses on its own exit paths (`0`
 * clean, `1` startup failed, `2` renderer probe failed, `4` index fetch
 * failed), so a harness reading the code can tell this apart from a probe
 * failure instead of seeing an undifferentiated `1`.
 */
export const RENDERER_UNSERVABLE_EXIT_CODE = 5;

/**
 * Renders an unknown thrown value as a bounded, single-line reason.
 *
 * `unknown` because a rejected `loadURL` is not guaranteed to reject with an
 * `Error`, and `String(error)` on a hostile object can be arbitrarily long or
 * multi-line. Newlines collapse so the reason stays one log line and one
 * paragraph in the failure document.
 */
export function describeLoadFailure(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Starts the load, and gives a rejected load a visible, controlled outcome.
 *
 * `loadURL` rejects on a navigation failure (a refused asset, a handler that
 * never installed, a bundle that is not there). Logging and returning left a
 * LIVE, BLANK, RETAINED window: nothing on screen, no reason, and nothing for
 * the user or a harness to act on. Instead the window loads the generated
 * failure document (`./load-failure-document.ts`), which carries the reason and
 * is servable precisely because it is not read from the tree that just failed.
 *
 * If that second load also rejects, no document can be served at all: the window
 * is destroyed rather than retained, and for the main window the process exits
 * non-zero with the diagnostic. There is no third attempt — the failure
 * document's own catch does not re-enter this path, so the recovery cannot loop.
 */
export function loadDocument(
  browserWindow: BrowserWindow,
  documentUrl: string,
  role: WindowRole,
): void {
  browserWindow.loadURL(documentUrl).catch((error: unknown) => {
    const reason = describeLoadFailure(error);
    console.error(`[ai-sidekicks/desktop] failed to load ${documentUrl}: ${reason}`);
    serveLoadFailureDocument(browserWindow, role, reason);
  });
}

/** Loads the generated failure document, or gives up in a controlled way. */
function serveLoadFailureDocument(
  browserWindow: BrowserWindow,
  role: WindowRole,
  reason: string,
): void {
  if (browserWindow.isDestroyed()) {
    // The window is gone. Almost always this is the ordinary case: the user
    // closed the window while its first load was still failing, and `loadURL`
    // rejected afterwards against a window that no longer exists.
    //
    // Deliberately a plain return and NOT `abandonUnservableWindow`. Treating a
    // closed window as unservable would exit the process with
    // `RENDERER_UNSERVABLE_EXIT_CODE` straight out of `app.exit`, which runs no
    // `before-quit` and no `will-quit` handler — so closing the main window
    // during a slow failing load would skip the sidecar drain and report a
    // renderer failure for a normal quit. Nothing is owed here: the window
    // destroyed itself, so there is nothing to destroy, and there is no surface
    // left to show a failure document ON.
    console.warn(
      `[ai-sidekicks/desktop] a window closed while its load was failing (${reason}); ` +
        `no failure document to serve.`,
    );
    return;
  }

  // Inside the guarded path, deliberately. Building the URL percent-encodes the
  // reason, and a reason is an unknown thrown value rendered as text — hostile
  // enough to reach `encodeURIComponent`'s one throwing input. Evaluated in the
  // argument position of the `loadURL` call above the `.catch`, a `URIError`
  // would propagate out of this function instead of reaching the recovery, and
  // out of the `.catch` handler that called it as an unhandled rejection: the
  // window would stay live and blank, which is exactly the outcome this ladder
  // exists to prevent. `buildLoadFailureUrl` already replaces unpaired
  // surrogates, so this is the second guard on the same hazard and not the only
  // one.
  let failureDocumentUrl: string;
  try {
    failureDocumentUrl = buildLoadFailureUrl(reason);
  } catch (urlConstructionError: unknown) {
    console.error(
      `[ai-sidekicks/desktop] the load-failure URL could not be built: ` +
        `${describeLoadFailure(urlConstructionError)}`,
    );
    abandonUnservableWindow(browserWindow, role, reason);
    return;
  }

  browserWindow.loadURL(failureDocumentUrl).catch((failureDocumentError: unknown) => {
    console.error(
      `[ai-sidekicks/desktop] the load-failure document could not be served: ` +
        `${describeLoadFailure(failureDocumentError)}`,
    );
    abandonUnservableWindow(browserWindow, role, reason);
  });
}

/** Destroys a window that has no document, and exits if it was the main one. */
function abandonUnservableWindow(
  browserWindow: BrowserWindow,
  role: WindowRole,
  reason: string,
): void {
  if (!browserWindow.isDestroyed()) {
    browserWindow.destroy();
  }
  if (role !== "main") {
    return;
  }
  console.error(
    `[ai-sidekicks/desktop] no renderer document could be served for the main window ` +
      `(${reason}); exiting ${String(RENDERER_UNSERVABLE_EXIT_CODE)}.`,
  );
  app.exit(RENDERER_UNSERVABLE_EXIT_CODE);
}
