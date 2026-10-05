// What a window does when its document will not load: load, then the generated failure
// document, then give up. The three rungs sit in one file, in order, because the property that
// matters, that the recovery terminates, belongs to the ladder. Every rung is recorded in main's
// diagnostic log.

import { app, type BaseWindow, type WebContents } from "electron";

import type { MainDiagnosticLog } from "../services/diagnostic-log.js";
import { buildLoadFailureUrl } from "./load-failure-document.js";

/** Main's log, drained before an exit so the reason is on disk when the process ends. */
type LoadFailureLog = Pick<MainDiagnosticLog, "write" | "drain">;

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
 * Starts the load, and gives a rejected load a visible outcome instead of an unseen failure. On
 * rejection the window loads the generated failure document (`./load-failure-document.ts`),
 * which is servable because it is not read from the tree that just failed, and `revealFailure`
 * puts the window on screen once it has. If that load also rejects, the window is destroyed and
 * the process exits non-zero once the reason is in the log; the failure document's own catch does
 * not re-enter this path, so the recovery cannot loop.
 */
export function loadDocument(
  baseWindow: BaseWindow,
  webContents: WebContents,
  documentUrl: string,
  log: LoadFailureLog,
  revealFailure: () => void,
): void {
  webContents.loadURL(documentUrl).catch((error: unknown) => {
    const reason = describeLoadFailure(error);
    writeLoadFailureEntry(log, "error", `failed to load ${documentUrl}: ${reason}`);
    serveLoadFailureDocument(baseWindow, webContents, reason, log, revealFailure);
  });
}

/** Loads the generated failure document and reveals it, or gives up in a controlled way. */
function serveLoadFailureDocument(
  baseWindow: BaseWindow,
  webContents: WebContents,
  reason: string,
  log: LoadFailureLog,
  revealFailure: () => void,
): void {
  if (baseWindow.isDestroyed()) {
    // The user usually closed the window while its first load was still failing. A plain
    // return, not `abandonUnservableWindow`: that calls `app.exit`, which runs no `before-quit`
    // or `will-quit` handler, so a normal close would skip the quit drain and report a
    // renderer failure.
    writeLoadFailureEntry(
      log,
      "warning",
      `a window closed while its load was failing (${reason}); no failure document to serve.`,
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
    writeLoadFailureEntry(
      log,
      "error",
      `the load-failure URL could not be built: ${describeLoadFailure(urlConstructionError)}`,
    );
    abandonUnservableWindow(baseWindow, reason, log);
    return;
  }

  webContents.loadURL(failureDocumentUrl).then(revealFailure, (failureDocumentError: unknown) => {
    writeLoadFailureEntry(
      log,
      "error",
      `the load-failure document could not be served: ${describeLoadFailure(failureDocumentError)}`,
    );
    abandonUnservableWindow(baseWindow, reason, log);
  });
}

/**
 * Destroys the window that has no document and exits the process. With not even the failure
 * document to show there is nothing to interact with, and exiting non-zero beats an invisible
 * placeholder a harness can only detect by timing out. The log is drained first, because a
 * queued append does not survive `app.exit`, and the window goes only then, so closing the last
 * window cannot start an ordinary quit ahead of the exit.
 */
function abandonUnservableWindow(
  baseWindow: BaseWindow,
  reason: string,
  log: LoadFailureLog,
): void {
  writeLoadFailureEntry(
    log,
    "error",
    `no renderer document could be served for the console window (${reason}); exiting ` +
      `${String(RENDERER_UNSERVABLE_EXIT_CODE)}.`,
  );
  void log.drain().then(() => {
    if (!baseWindow.isDestroyed()) {
      baseWindow.destroy();
    }
    app.exit(RENDERER_UNSERVABLE_EXIT_CODE);
  });
}

function writeLoadFailureEntry(
  log: LoadFailureLog,
  level: "error" | "warning",
  message: string,
): void {
  log.write({ at: new Date().toISOString(), level, source: "main/windows/load-failure", message });
}
