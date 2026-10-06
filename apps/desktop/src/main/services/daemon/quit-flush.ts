// A quit waits for the background service's flush and nothing more: the service, its runs and its
// shells keep running. It holds at `before-quit`, which Electron emits before the app starts
// closing its windows. The event is synchronous, so the handler cancels the quit, runs the flush,
// and quits again on the next tick; the one-shot guard lets that second `before-quit` through and
// clears itself, so if another listener cancels that quit the next attempt flushes again. A quit
// asked for while the flush runs waits on that same flush. The flush is raced against the quit's
// wait, so a service that never answers cannot keep the app open; the wait's timer is cleared once
// the race settles and is `unref()`'d so it never keeps the event loop alive.

import type { App } from "electron";

import type { MainDiagnosticLog } from "../diagnostic-log.js";
import { describeFailure } from "../failure-message.js";
import { SERVICE_FLUSH_WAIT_MS } from "./supervisor.js";

/** Where a flush that failed or ran out of time is recorded. */
export interface QuitFlushOptions {
  readonly log: Pick<MainDiagnosticLog, "write">;
  readonly now: () => Date;
}

/**
 * Hold every quit until `flush` settles or {@link SERVICE_FLUSH_WAIT_MS} passes, then quit. A
 * flush that rejects is recorded and the quit still goes ahead, so a person is never left in an
 * app that will not close.
 */
export function installQuitFlush(
  app: Pick<App, "on" | "quit">,
  flush: () => Promise<void>,
  options: QuitFlushOptions,
): void {
  let isFlushed = false;
  let isFlushing = false;
  const record = (message: string): void => {
    options.log.write({
      at: options.now().toISOString(),
      level: "error",
      source: "main/services/daemon",
      message,
    });
  };

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
          record(
            `The background service's flush did not answer within ` +
              `${String(SERVICE_FLUSH_WAIT_MS / 1000)} seconds; the app quit without it.`,
          );
        }
      } catch (failure: unknown) {
        record(`The background service's flush failed at quit: ${describeFailure(failure)}`);
      } finally {
        clearTimeout(waitTimer);
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
