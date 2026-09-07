// When a settings window warms its deferred pages, and what stops it.
//
// AFTER THE FIRST FRAME HAS COMMITTED, which is what `useEffect` means here and why it
// is not `useLayoutEffect`: a layout effect runs before the browser paints, so a walk
// armed from one would compete with the frame that draws the rail a person is about to
// read. An ordinary effect runs after that commit, and the walk's own scheduler then
// waits for an idle callback on top of it.
//
// THE WALK IS THE MOUNT'S, NOT THE WINDOW'S, and that is the whole difference from
// `frame/lazy-body-warm-binding.ts`. The two boards in `seats/` are the window's and are
// composed once for it; the page board is composed per settings mount, so its walk is
// built here, cancelled when this surface unmounts, and never outlives the registry it
// reads. A second settings window warms its own board and inherits nothing.
//
// AND IT IS NOT THAT BINDING REUSED, for two reasons that both stand alone. The console
// DAG forbids the edge — a view family may not import `frame/`, and the remedy that rule
// names is the hoist, which has already happened: `LazyBodyIdleWarm` and
// `idleWarmScheduler` live in `seats/` precisely so more than one composition site can
// arm the same walk. And that hook binds exactly two window-scoped boards under one
// cleanup, which is a different lifetime rather than a different spelling of this one.
//
// A `render:`-ONLY BOARD IS STILL WALKED. `unloadedKeys` answers nothing for it, the walk
// ends on its first step, and no fetch happens — so arming this unconditionally costs a
// callback rather than a decision, and no caller has to ask first whether the page set it
// composed happens to hold a loader this week.

import { useEffect, useState } from "react";

import { LazyBodyIdleWarm, idleWarmScheduler, type IdleWarmScheduler } from "../seats/index.js";
import { type SettingsPageRegistry } from "./settings-page-registry.js";

/**
 * Warm this mount's loader-backed settings pages once, after its first frame.
 *
 * Takes the board the surface renders rather than reaching for a module-scope one, on the
 * composition site's own rule: there is no process-wide page registry, and a window handed
 * a board of its own must warm that one.
 *
 * The scheduler is a parameter with a default rather than a construction inside, so a
 * suite drives the walk step by step without a browser and without patching globals — and
 * the default is the feature-detected one, which is what a window wants.
 */
export function useSettingsPageIdleWarm(
  pages: SettingsPageRegistry,
  scheduler: IdleWarmScheduler = idleWarmScheduler(),
): void {
  // PINNED, for `frame/lazy-body-warm-binding.ts`'s measured reason: the default argument
  // constructs a scheduler on every render, so naming the parameter in the dependency list
  // would re-run the effect on every pass and start a fresh walk each time.
  const [warmScheduler] = useState(() => scheduler);
  useEffect(() => {
    // BUILT INSIDE THE SETUP rather than held across it. A walk is once-per-instance and
    // permanently cancellable, and `StrictMode` replays every effect — so a walk held in
    // state would be started by the first setup, cancelled by the synthetic cleanup, and
    // found already-started-and-cancelled by the replay, leaving the board cold for the
    // life of the surface with nothing failing and nothing logged.
    const walk = new LazyBodyIdleWarm(pages, warmScheduler);
    walk.start();
    return () => {
      walk.cancel();
    };
  }, [pages, warmScheduler]);
}
