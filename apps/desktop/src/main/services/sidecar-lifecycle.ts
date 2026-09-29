// Holds Electron's quit open while an async drain runs, then quits again.
//
// Electron's `will-quit` is a synchronous event. The handler calls
// `event.preventDefault()`, runs the drain, and re-issues `app.quit()` on the next
// tick. Electron then emits `will-quit` a second time, which the one-shot
// `drainCompleted` guard lets through so the quit proceeds instead of looping.
// The guard clears itself on that pass: if another `will-quit` listener cancels the
// re-issued quit, the next quit attempt drains again.
//
// The drain is raced against a hard wall-clock cap, so a drain that never settles
// cannot block the quit. The cap timer is `unref()`'d and never keeps the event
// loop alive past `app.quit()`.

import type { App } from "electron";

// The wall-clock ceiling the drain is raced against, and the figure the console's
// restart confirmation quotes to a person before they agree to a restart.
import { DAEMON_SHUTDOWN_FLUSH_BUDGET_MS } from "@shared/shutdown-budget.js";

/** Injection seams for the logger and the hard cap, so tests need no wall-clock wait. */
export interface SidecarLifecycleDeps {
  readonly logger?: Pick<Console, "error">;
  /** Defaults to `DAEMON_SHUTDOWN_FLUSH_BUDGET_MS`. */
  readonly hardCapMs?: number;
}

/**
 * Registers a `will-quit` listener that holds the quit until `drain` settles or the
 * hard cap passes, then quits again. A rejected drain is logged and the quit still
 * proceeds, so a person is never stranded in a window that will not close.
 */
export function registerSidecarLifecycle(
  app: App,
  drain: () => Promise<void>,
  deps: SidecarLifecycleDeps = {},
): void {
  const logger: Pick<Console, "error"> = deps.logger ?? console;
  const hardCapMs: number = deps.hardCapMs ?? DAEMON_SHUTDOWN_FLUSH_BUDGET_MS;

  let drainCompleted = false;

  app.on("will-quit", (event) => {
    if (drainCompleted) {
      drainCompleted = false;
      return;
    }

    event.preventDefault();

    void (async (): Promise<void> => {
      try {
        const hardCapPromise: Promise<"hard-cap-fired"> = new Promise((resolve) => {
          setTimeout(() => {
            resolve("hard-cap-fired");
          }, hardCapMs).unref();
        });

        const raceResult = await Promise.race([drain(), hardCapPromise]);

        if (raceResult === "hard-cap-fired") {
          logger.error(
            `[sidecar-lifecycle] the quit drain did not resolve within ` +
              `${hardCapMs.toString()} ms; proceeding with Electron quit.`,
          );
        }
      } catch (err: unknown) {
        const message: string = err instanceof Error ? err.message : String(err);
        logger.error(`[sidecar-lifecycle] the quit drain threw: ${message}; proceeding with quit.`);
      } finally {
        // The guard must be set before the re-issued quit re-emits `will-quit`.
        drainCompleted = true;
        process.nextTick(() => {
          app.quit();
        });
      }
    })();
  });
}
