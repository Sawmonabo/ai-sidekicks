// What a window does when its document will not load: load, then the generated failure
// document, then give up. Split out of `./window.ts`; the three rungs sit in one file, in order,
// because the property that matters, that the recovery terminates, belongs to the ladder.

import { app, type BrowserWindow } from "electron";

import { buildLoadFailureUrl } from "./load-failure-document.js";

/**
 * Exit status when a window has no document it can serve, not even the generated failure
 * document. Distinct from the other main exit codes (`1` startup failed, `2` and `4` smoke-probe
 * failures) so a harness can tell them apart.
 */
export const RENDERER_UNSERVABLE_EXIT_CODE = 5;

/**
 * Renders an unknown thrown value as a bounded, single-line reason. `unknown` because a
 * rejected `loadURL` need not reject with an `Error`; newlines collapse so the reason stays one
 * log line.
 */
export function describeLoadFailure(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Starts the load, and gives a rejected load a visible outcome instead of a blank window. On
 * rejection the window loads the generated failure document (`./load-failure-document.ts`),
 * which is servable because it is not read from the tree that just failed. If that load also
 * rejects, the window is destroyed and the process exits non-zero with the diagnostic; the
 * failure document's own catch does not re-enter this path, so the recovery cannot loop.
 */
export function loadDocument(browserWindow: BrowserWindow, documentUrl: string): void {
  browserWindow.loadURL(documentUrl).catch((error: unknown) => {
    const reason = describeLoadFailure(error);
    console.error(`[ai-sidekicks/desktop] failed to load ${documentUrl}: ${reason}`);
    serveLoadFailureDocument(browserWindow, reason);
  });
}

/** Loads the generated failure document, or gives up in a controlled way. */
function serveLoadFailureDocument(browserWindow: BrowserWindow, reason: string): void {
  if (browserWindow.isDestroyed()) {
    // The user usually closed the window while its first load was still failing. A plain
    // return, not `abandonUnservableWindow`: that calls `app.exit`, which runs no `before-quit`
    // or `will-quit` handler, so a normal close would skip the quit drain and report a
    // renderer failure.
    console.warn(
      `[ai-sidekicks/desktop] a window closed while its load was failing (${reason}); ` +
        `no failure document to serve.`,
    );
    return;
  }

  // Inside the guarded path: building the URL percent-encodes the reason, and a hostile
  // reason can reach `encodeURIComponent`'s one throwing input. Outside this guard the
  // `URIError` would escape the `.catch` that called it and leave the window blank.
  // `buildLoadFailureUrl` already replaces unpaired surrogates; this is the second guard.
  let failureDocumentUrl: string;
  try {
    failureDocumentUrl = buildLoadFailureUrl(reason);
  } catch (urlConstructionError: unknown) {
    console.error(
      `[ai-sidekicks/desktop] the load-failure URL could not be built: ` +
        `${describeLoadFailure(urlConstructionError)}`,
    );
    abandonUnservableWindow(browserWindow, reason);
    return;
  }

  browserWindow.loadURL(failureDocumentUrl).catch((failureDocumentError: unknown) => {
    console.error(
      `[ai-sidekicks/desktop] the load-failure document could not be served: ` +
        `${describeLoadFailure(failureDocumentError)}`,
    );
    abandonUnservableWindow(browserWindow, reason);
  });
}

/**
 * Destroys a window that has no document and exits the process. With not even the failure
 * document to show there is nothing to interact with, and exiting non-zero beats an invisible
 * placeholder a harness can only detect by timing out.
 */
function abandonUnservableWindow(browserWindow: BrowserWindow, reason: string): void {
  if (!browserWindow.isDestroyed()) {
    browserWindow.destroy();
  }
  console.error(
    `[ai-sidekicks/desktop] no renderer document could be served for the main window ` +
      `(${reason}); exiting ${String(RENDERER_UNSERVABLE_EXIT_CODE)}.`,
  );
  app.exit(RENDERER_UNSERVABLE_EXIT_CODE);
}
