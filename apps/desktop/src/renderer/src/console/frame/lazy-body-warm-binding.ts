// When the window warms its loader-backed bodies, and what stops it.
//
// AFTER THE FIRST FRAME HAS COMMITTED, which is what `useEffect` means here and why it
// is not `useLayoutEffect`: a layout effect runs before the browser paints, so a walk
// armed from one would be competing with the frame the launch is judged on. An ordinary
// effect runs after that commit, and the walk's own scheduler then waits for an idle
// callback on top of it.
//
// ONE WALK PER BOARD, both boards. The deck's pane registry and the frame's surface
// registry each hold loader-backed bodies, and `LazyBodyIdleWarm` is generic in the key
// precisely so this file arms the same walk over both rather than owning two.
//
// THE WALKS ARE THE WINDOW'S, not the process's. Each is constructed for this frame and
// cancelled when it unmounts — an auxiliary window closing must not leave an idle
// callback re-arming against a board its window no longer reads.
//
// AND EACH EFFECT SETUP BUILDS ITS OWN PAIR, which is the correction to holding them in
// state across the effect. A walk is once-per-instance and permanently cancellable — the
// two properties that make it safe — and `StrictMode` replays every effect: setup starts
// the walks, the synthetic cleanup cancels them, and the replayed setup finds the SAME
// objects already started and already cancelled, so it returns and both boards stay cold
// for the life of the window. Nothing reports it; the console simply stops warming.
// Constructing inside the setup makes the walk's lifetime the EFFECT's lifetime, which
// is what it always meant. It costs no extra walks per render either: the effect's
// dependencies are the two boards and a scheduler pinned below, none of which changes on
// a re-render.

import { useEffect, useState } from "react";

import {
  LazyBodyIdleWarm,
  idleWarmScheduler,
  type ConsolePaneRegistry,
  type ConsoleSurfaceRegistry,
  type IdleWarmScheduler,
} from "../seats/index.js";

/**
 * Warm both boards' loader-backed bodies once, after this window's first frame.
 *
 * Takes the boards rather than reaching for the singletons, on the composition site's
 * own rule: a window handed boards of its own must warm those and not production's.
 *
 * The scheduler is a parameter with a default rather than a construction inside, so a
 * suite drives the walk step by step without a browser and without patching globals —
 * and the default is the feature-detected one, which is what a window wants.
 */
export function useLazyBodyIdleWarm(
  paneRegistry: ConsolePaneRegistry,
  surfaceRegistry: ConsoleSurfaceRegistry,
  scheduler: IdleWarmScheduler = idleWarmScheduler(),
): void {
  // PINNED, and this is the one thing that must not move into the effect. The default
  // argument constructs a scheduler on every render, so naming `scheduler` directly in
  // the dependency list would re-run the effect every pass and start a new pair of walks
  // each time — the hazard that put the walks in state to begin with. Held here, the
  // dependency is stable and the walks are built exactly once per effect run.
  const [warmScheduler] = useState(() => scheduler);
  useEffect(() => {
    const walks = [
      new LazyBodyIdleWarm(paneRegistry, warmScheduler),
      new LazyBodyIdleWarm(surfaceRegistry, warmScheduler),
    ];
    for (const walk of walks) {
      walk.start();
    }
    return () => {
      for (const walk of walks) {
        walk.cancel();
      }
    };
  }, [paneRegistry, surfaceRegistry, warmScheduler]);
}
