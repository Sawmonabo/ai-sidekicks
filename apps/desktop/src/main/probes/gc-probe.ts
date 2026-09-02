// The window lifecycle-reachability probe — ADR-024, Plan-023 Phase 1B.
//
// Lives beside the entrypoint for the reason its sibling gives: `index.ts` is
// the startup ORDER, and a probe body inlined there hides the next step of it.
// The caller's `__SIDEKICKS_SMOKE_BUILD__` gate is compile-time-static, so a
// release build references nothing here and Rollup drops the whole module.
//
// WHAT IT MEASURES. The probe drives K iterations of GC pressure and samples
// `v8.queryObjects(BrowserWindow)` after each cycle, then closes every window,
// lets the close unwind, collects once more, and takes one post-close sample —
// and emits one summary line tagged `[SIDEKICKS_GC_PROBE]` that
// `apps/desktop/test/lifecycle.gc.test.ts` parses. It asserts the observable
// lifecycle contract: the count is stable across the cycles (the window stays
// reachable across the `.then(...)` callback unwind), `window-all-closed` does
// not fire mid-loop, and the count drops by at least one per window once the
// windows are closed. That last, per-window delta is what tells the
// user-created instance apart from the fixed non-instance match a count-only
// sample cannot identify (`ADR-024 §Antithesis — The Strongest Case Against`):
// a bare "count >= 1" would still pass with the instance gone and that match
// remaining.
//
// Per `ADR-024 §Antithesis — The Strongest Case Against` the load-bearing
// reachability mechanism is Electron's native-side `BaseWindow::self_ref_`
// (a `v8::Global<v8::Value>` strong-rooted from `InitWith` to native
// destruction); the user-side module-scope window handle in `index.ts` is
// defensive consistency with the canonical community pattern, not the GC
// anchor. So this probe is a future-regression guard against Electron
// internals shifting `self_ref_` semantics — not proof that removing that
// handle would break a fix-state.

import { BrowserWindow, type App } from "electron";
import { setImmediate as nextMacrotask, setTimeout as wait } from "node:timers/promises";
import { queryObjects } from "node:v8";

/** The stdout marker `apps/desktop/test/lifecycle.gc.test.ts` parses. */
export const GC_PROBE_TAG = "[SIDEKICKS_GC_PROBE]";

/** GC cycles per run. Twenty is enough for a retention leak to show as drift. */
const PROBE_ITERATIONS = 20;

/** Bytes allocated and dropped per cycle, to create collectable pressure. */
const PROBE_ALLOCATION_BYTES = 8 * 1024 * 1024;

/** Settle time after each allocation, so a collection has a chance to run. */
const PROBE_SETTLE_MS = 50;

/**
 * One probe run and the one fact it observes about the app.
 *
 * A class because the run and the `window-all-closed` observation are ONE piece
 * of state: the flag is written by an app-level listener and read by the run's
 * own summary line, and holding it as a free module-level `let` — which is what
 * this was — lets any later edit add a second writer with nothing to stop it.
 * Private field, one writer, one reader.
 */
export class GcProbe {
  #windowAllClosedFired = false;

  /**
   * Registers the probe-scoped `window-all-closed` listener.
   *
   * `index.ts` registers its own `window-all-closed` handler at module-eval
   * time, synchronously, before `whenReady` resolves — so this listener is
   * invoked second. That is fine: `EventEmitter` invokes every registered
   * listener synchronously within a single `emit()`, so the flag is set during
   * the same pass as the `app.quit()` in the first listener, and `app.quit`
   * only SCHEDULES the quit sequence (`before-quit` / `will-quit` / `quit`) on
   * later ticks, so it cannot pre-empt this one.
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
    // Read before the close phase: closing the last window is what fires
    // `window-all-closed`, so the flag is only a mid-loop observation up to here.
    const allClosedFiredDuringLoop = this.#windowAllClosedFired;
    const windowsOpened = BrowserWindow.getAllWindows().length;

    // The app-level `window-all-closed` handler schedules `app.quit()`; this
    // preventer keeps the process alive for the post-close sample, and the
    // `app.exit(0)` below bypasses `before-quit` entirely.
    electronApp.on("before-quit", (event) => {
      event.preventDefault();
    });
    await closeEveryWindow();
    // Two macrotasks so the `closed` dispatch and its native frames unwind, then
    // a precise collection — the settling procedure ADR-024's Step 0b probe uses
    // for its own post-close reading.
    await nextMacrotask();
    await nextMacrotask();
    if (globalGcAvailable) {
      globalThis.gc?.();
      globalThis.gc?.();
    }
    await wait(PROBE_SETTLE_MS);
    const closedCount = queryObjects(BrowserWindow, { format: "count" });

    console.log(
      `${GC_PROBE_TAG} ${JSON.stringify({
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
      })}`,
    );
    electronApp.exit(0);
  }
}

/**
 * Closes every open window and resolves once each has emitted `closed`.
 *
 * A helper rather than a loop in `run()` on purpose: a `for … of` over the
 * windows inside `run()`'s suspended async frame would keep the final iteration
 * binding alive across the post-close sample and root the very wrapper the
 * sample is meant to see released (the loop-frame control in
 * `ADR-024 §References`). Here the `map` callback's frame returns before the
 * caller awaits, and the resolved promises hold no window.
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
 * Starts one probe run on a fresh event-loop tick.
 *
 * The deferral lets the caller's `whenReady` continuation unwind its locals
 * before the loop samples the heap — and the scheduled arrow is authored HERE,
 * closing over this module's `probe` alone, so it cannot capture the caller's
 * `BrowserWindow` local and root the very window the probe is measuring. That
 * capture hazard is the reason the state used to sit at module scope in
 * `index.ts`; moving the closure into this module removes the hazard instead of
 * working around it.
 */
export function startGcProbe(electronApp: App): void {
  const probe = new GcProbe();
  probe.observe(electronApp);
  setImmediate(() => {
    void probe.run(electronApp);
  });
}
