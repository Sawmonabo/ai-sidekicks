// A quit waits for the background service's flush and nothing more: the service, its runs and its
// shells keep running. It holds at `before-quit`, which Electron emits before the app starts
// closing its windows. The event is synchronous, so the handler cancels the quit, runs the flush,
// and quits again on the next tick; the one-shot guard lets that second `before-quit` through and
// clears itself, so if another listener cancels that quit the next attempt flushes again. A quit
// asked for while the flush runs waits on that same flush. The flush is raced against the quit's
// wait, so a service that never answers cannot keep the app open; the wait's timer is cleared once
// the race settles and is `unref()`'d so it never keeps the event loop alive. The one wait bounds
// the flush and the wait for a service a stop is ending together. Main's log is drained before the
// quit goes on, so its last lines reach the file, and a log that stopped writing is reported.

import type { App } from "electron";

import {
  reportUnwrittenDiagnostics,
  type DiagnosticLogFailureReporter,
  type MainDiagnosticLog,
} from "../diagnostic-log.js";
import { describeFailure } from "../failure-message.js";
import { SERVICE_FLUSH_WAIT_MS } from "./supervisor.js";

const LOG_SOURCE = "main/services/daemon";

/** Where a flush that failed or ran out of time is recorded, and a log that could not be. */
export interface QuitFlushOptions {
  readonly log: Pick<MainDiagnosticLog, "write" | "drain" | "lastWriteFailure">;
  /** Told once when the log stopped writing; main passes `console.error`. */
  readonly reportUnwrittenLog: DiagnosticLogFailureReporter;
}

/**
 * Hold every quit until `flush` settles or {@link SERVICE_FLUSH_WAIT_MS} passes and main's log has
 * drained, then quit. A flush that rejects is recorded and the quit still goes ahead, so a person
 * is never left in an app that will not close.
 */
export function installQuitFlush(
  app: Pick<App, "on" | "quit">,
  flush: () => Promise<void>,
  options: QuitFlushOptions,
): void {
  let isFlushed = false;
  let isFlushing = false;

  app.on("before-quit", (event) => {
    if (isFlushed) {
      isFlushed = false;
      return;
    }
    event.preventDefault();
    if (isFlushing) {
      return;
    }
    isFlushing = true;

    void (async (): Promise<void> => {
      let waitTimer: NodeJS.Timeout | undefined;
      try {
        const waitEnded = new Promise<"wait-ended">((resolve) => {
          waitTimer = setTimeout(() => {
            resolve("wait-ended");
          }, SERVICE_FLUSH_WAIT_MS).unref();
        });
        if ((await Promise.race([flush(), waitEnded])) === "wait-ended") {
          options.log.write({
            level: "error",
            source: LOG_SOURCE,
            message:
              `The background service's flush did not answer within ` +
              `${String(SERVICE_FLUSH_WAIT_MS / 1000)} seconds; the app quit without it.`,
          });
        }
      } catch (failure: unknown) {
        options.log.write({
          level: "error",
          source: LOG_SOURCE,
          message: `The background service's flush failed at quit: ${describeFailure(failure)}`,
        });
      } finally {
        clearTimeout(waitTimer);
        // A queued append does not outlive the process, and these lines are the quit's record.
        await reportUnwrittenDiagnostics(options.log, options.reportUnwrittenLog);
        isFlushing = false;
        // Set before the quit is asked for again, which emits `before-quit` once more.
        isFlushed = true;
        process.nextTick(() => {
          app.quit();
        });
      }
    })();
  });
}
