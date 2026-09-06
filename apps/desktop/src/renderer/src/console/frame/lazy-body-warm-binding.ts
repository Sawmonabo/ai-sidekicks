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
// callback re-arming against a board its window no longer reads. That is also why the
// pair is held in state rather than rebuilt per render: the once-per-instance rule is
// state on the object, and an object rebuilt each pass would start a new walk every
// time the frame re-rendered.

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
  const [walks] = useState(() => [
    new LazyBodyIdleWarm(paneRegistry, scheduler),
    new LazyBodyIdleWarm(surfaceRegistry, scheduler),
  ]);
  useEffect(() => {
    for (const walk of walks) {
      walk.start();
    }
    return () => {
      for (const walk of walks) {
        walk.cancel();
      }
    };
  }, [walks]);
}
