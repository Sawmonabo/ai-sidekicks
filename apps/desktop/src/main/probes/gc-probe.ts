// The window lifecycle-reachability probe. The caller's compile-time `__SIDEKICKS_SMOKE_BUILD__`
// gate means a release build references nothing here and Rollup drops the module.
//
// It runs GC-pressure cycles sampling `v8.queryObjects(BrowserWindow)`, closes every window,
// collects, takes one post-close sample, and prints one `[SIDEKICKS_GC_PROBE]` line that
// `tests/lifecycle.gc.test.ts` parses. The contract: the count is stable across the cycles,
// `window-all-closed` does not fire mid-loop, and the count drops by at least one per window
// after close. The per-window drop tells the user-created instance apart from a fixed
// non-instance match that a bare "count >= 1" would let pass.
//
// The window is kept reachable by Electron's native `BaseWindow::self_ref_` (a strong
// `v8::Global` rooted until native destruction), so this probe guards against Electron
// changing those semantics.

import { BrowserWindow, type App } from "electron";
import { setImmediate as nextMacrotask, setTimeout as wait } from "node:timers/promises";
import { queryObjects } from "node:v8";

import { GC_PROBE_TAG } from "@shared/probe-tags.js";

/** GC cycles per run. Twenty is enough for a retention leak to show as drift. */
const PROBE_ITERATIONS = 20;

/** Bytes allocated and dropped per cycle, to create collectable pressure. */
const PROBE_ALLOCATION_BYTES = 8 * 1024 * 1024;

/** Settle time after each allocation, so a collection has a chance to run. */
const PROBE_SETTLE_MS = 50;

/** The summary line's payload: one probe run's samples and what they show. */
export interface GcProbeReading {
  readonly ok: boolean;
  readonly queryObjectsAvailable: boolean;
  readonly globalGcAvailable: boolean;
  readonly iterations: number;
  readonly counts: readonly number[];
  readonly min: number;
  readonly max: number;
  /** Windows open when the loop ended; the per-window delta's denominator. */
  readonly windowsOpened: number;
  /** The loop's last sample, taken with every window still open. */
  readonly openCount: number;
  /** One sample after every window closed, the close unwound, and a collection. */
  readonly closedCount: number;
  readonly allClosedFired: boolean;
}

/**
 * One probe run and the one fact it observes about the app: whether `window-all-closed` fired.
 * A class so the flag has a single writer (the app listener) and a single reader (the summary).
 */
export class GcProbe {
  #windowAllClosedFired = false;

  /**
   * Registers the probe-scoped `window-all-closed` listener. `index.ts` registers its own
   * handler first; both run in the same `emit()`, and `app.quit` only schedules the quit
   * sequence, so it cannot pre-empt this listener.
   */
  public observe(electronApp: App): void {
    electronApp.on("window-all-closed", () => {
      this.#windowAllClosedFired = true;
    });
  }

  /** Runs the sampling loop, prints the summary line, and exits the process. */
  public async run(electronApp: App): Promise<void> {
    const counts: number[] = [];
    const queryObjectsAvailable = typeof queryObjects === "function";
    const globalGcAvailable = typeof globalThis.gc === "function";

    for (let iteration = 0; iteration < PROBE_ITERATIONS; iteration++) {
      if (globalGcAvailable) {
        globalThis.gc?.();
        globalThis.gc?.();
      }
      const throwaway = new Uint8Array(PROBE_ALLOCATION_BYTES);
      throwaway[0] = iteration & 0xff;
      if (globalGcAvailable) {
        globalThis.gc?.();
        globalThis.gc?.();
      }
      await wait(PROBE_SETTLE_MS);
      counts.push(queryObjects(BrowserWindow, { format: "count" }));
    }

    const min = counts.length > 0 ? Math.min(...counts) : 0;
    const max = counts.length > 0 ? Math.max(...counts) : 0;
    const openCount = counts.at(-1) ?? 0;
    // Read before the close phase: closing the last window is what fires `window-all-closed`.
    const allClosedFiredDuringLoop = this.#windowAllClosedFired;
    const windowsOpened = BrowserWindow.getAllWindows().length;

    // The app-level `window-all-closed` handler schedules `app.quit()`; this keeps the process
    // alive for the post-close sample, and the `app.exit(0)` below bypasses `before-quit`.
    electronApp.on("before-quit", (event) => {
      event.preventDefault();
    });
    await closeEveryWindow();
    // Two macrotasks let the `closed` dispatch and its native frames unwind before a collection.
    await nextMacrotask();
    await nextMacrotask();
    if (globalGcAvailable) {
      globalThis.gc?.();
      globalThis.gc?.();
    }
    await wait(PROBE_SETTLE_MS);
    const closedCount = queryObjects(BrowserWindow, { format: "count" });

    const reading: GcProbeReading = {
      ok: true,
      queryObjectsAvailable,
      globalGcAvailable,
      iterations: PROBE_ITERATIONS,
      counts,
      min,
      max,
      windowsOpened,
      openCount,
      closedCount,
      allClosedFired: allClosedFiredDuringLoop,
    };
    console.log(`${GC_PROBE_TAG} ${JSON.stringify(reading)}`);
    electronApp.exit(0);
  }
}

/**
 * Closes every open window and resolves once each has emitted `closed`. A helper, not a loop
 * in `run()`, because a `for … of` in `run()`'s suspended frame would keep the last window
 * bound across the post-close sample and root the wrapper the sample expects released.
 */
function closeEveryWindow(): Promise<void> {
  const closing = BrowserWindow.getAllWindows().map((browserWindow) => {
    const closed = new Promise<void>((resolve) => {
      browserWindow.once("closed", () => {
        resolve();
      });
    });
    browserWindow.close();
    return closed;
  });
  return Promise.all(closing).then(() => undefined);
}

/**
 * Starts one probe run on a fresh tick, so the caller's `whenReady` locals unwind before the
 * heap is sampled. The scheduled arrow closes over `probe` alone, so it cannot capture and
 * root the caller's window.
 */
export function startGcProbe(electronApp: App): void {
  const probe = new GcProbe();
  probe.observe(electronApp);
  setImmediate(() => {
    void probe.run(electronApp);
  });
}
