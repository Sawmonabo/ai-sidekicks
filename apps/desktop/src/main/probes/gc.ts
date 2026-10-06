// The window lifecycle-reachability probe. The caller's compile-time `__SMOKE_BUILD__`
// gate means a release build references nothing here and Rollup drops the module.
//
// It runs GC-pressure cycles sampling `v8.queryObjects(BaseWindow)`, closes every window,
// collects, takes one post-close sample, and prints one `[SIDEKICKS_GC_PROBE]` line that
// `tests/lifecycle.gc.test.ts` parses. The contract: the count is stable across the cycles,
// `window-all-closed` does not fire mid-loop, and the count drops by at least one per window
// after close. The per-window drop tells the user-created instance apart from a fixed
// non-instance match that a bare "count >= 1" would let pass.
//
// The window is kept reachable by Electron's native `BaseWindow::self_ref_` (a strong
// `v8::Global` rooted until native destruction), so this probe guards against Electron
// changing those semantics.

import { BaseWindow, type App } from "electron";
import { setImmediate as nextMacrotask, setTimeout as wait } from "node:timers/promises";
import { queryObjects } from "node:v8";

import { GC_PROBE_TAG } from "#shared/probe-tags.js";

import { describeFailure } from "../services/failure-message.js";
import { firstWindowContents } from "./first-window-contents.js";

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
   * Registers the probe-scoped `window-all-closed` listener. The window registry registers its
   * own handler first (`../windows/registry.ts`); both run in the same `emit()`, and
   * `app.quit` only schedules the quit sequence, so it cannot pre-empt this listener.
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
    const collectGarbage = globalThis.gc;
    const globalGcAvailable = collectGarbage !== undefined;

    for (let iteration = 0; iteration < PROBE_ITERATIONS; iteration++) {
      collectTwice(collectGarbage);
      const throwaway = new Uint8Array(PROBE_ALLOCATION_BYTES);
      throwaway[0] = iteration & 0xff;
      collectTwice(collectGarbage);
      await wait(PROBE_SETTLE_MS);
      counts.push(queryObjects(BaseWindow, { format: "count" }));
    }

    const min = counts.length > 0 ? Math.min(...counts) : 0;
    const max = counts.length > 0 ? Math.max(...counts) : 0;
    const openCount = counts.at(-1) ?? 0;
    // Read before the close phase: closing the last window is what fires `window-all-closed`.
    const allClosedFiredDuringLoop = this.#windowAllClosedFired;
    const windowsOpened = BaseWindow.getAllWindows().length;

    // Off macOS the registry's `window-all-closed` handler schedules `app.quit()`; this keeps the
    // process alive for the post-close sample, and the `app.exit(0)` below bypasses `before-quit`.
    electronApp.on("before-quit", (event) => {
      event.preventDefault();
    });
    await closeEveryWindow();
    // Two macrotasks let the `closed` dispatch and its native frames unwind before a collection.
    await nextMacrotask();
    await nextMacrotask();
    collectTwice(collectGarbage);
    await wait(PROBE_SETTLE_MS);
    const closedCount = queryObjects(BaseWindow, { format: "count" });

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

/** Two collections, where the process exposes `gc`; nothing where it does not. */
function collectTwice(collectGarbage: (() => void) | undefined): void {
  if (collectGarbage === undefined) {
    return;
  }
  collectGarbage();
  collectGarbage();
}

/**
 * Closes every open window and resolves once each has emitted `closed`. A helper, not a loop
 * in `run()`, because a `for … of` in `run()`'s suspended frame would keep the last window
 * bound across the post-close sample and root the wrapper the sample expects released.
 */
function closeEveryWindow(): Promise<void> {
  const closing = BaseWindow.getAllWindows().map((baseWindow) => {
    const closed = new Promise<void>((resolve) => {
      baseWindow.once("closed", () => {
        resolve();
      });
    });
    baseWindow.close();
    return closed;
  });
  return Promise.all(closing).then(() => undefined);
}

/**
 * Starts one probe run once the first window the console document opens has loaded, on a fresh
 * tick, so the caller's `whenReady` locals unwind before the heap is sampled and the count is
 * not sampled while that window is still arriving. The scheduled arrows close over `probe`
 * alone, so they cannot capture and root the caller's window. A run that fails says why on
 * stderr and exits with 1, so the tier reports the failure rather than waiting out its timeout.
 */
export function startGcProbe(electronApp: App): void {
  const probe = new GcProbe();
  probe.observe(electronApp);
  void firstWindowContents(electronApp).then((created) => {
    created.once("did-finish-load", () => {
      setImmediate(() => {
        probe.run(electronApp).catch((failure: unknown) => {
          console.error(`The GC probe failed: ${describeFailure(failure)}`);
          electronApp.exit(1);
        });
      });
    });
  });
}
