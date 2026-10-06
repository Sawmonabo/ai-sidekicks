// Warms the loader-backed bodies of both boards, the pane registry and the screen registry,
// with one idle walk each.
//
// It runs in `useEffect`, after the first frame commits, so the walk does not compete with the
// frame the launch is judged on. The walks belong to the window and cancel on unmount. Each
// effect setup builds its own pair: a walk is once-per-instance and permanently cancelable, so
// a `StrictMode` re-run of the setup would find walks already started and canceled and leave
// both boards cold for the life of the window.

import { useEffect, useState } from "react";

import {
  LazyBodyIdleWarm,
  idleWarmScheduler,
  type IdleWarmScheduler,
} from "#renderer/components/LazyBody/idle-warm.js";
import { type PaneRegistry } from "#renderer/registries/panes/registry.js";
import { type ScreenRegistry } from "#renderer/registries/screens/registry.js";

/**
 * Warm both boards' loader-backed bodies once, after this window's first frame.
 *
 * Takes the boards rather than the singletons, so a window handed boards of its own warms those.
 * The scheduler is a parameter so a suite drives the walk step by step without a browser; the
 * default is the feature-detected one.
 */
export function useLazyBodyIdleWarm(
  paneRegistry: PaneRegistry,
  screenRegistry: ScreenRegistry,
  scheduler: IdleWarmScheduler = idleWarmScheduler(),
): void {
  // Pinned: the default argument builds a scheduler on every render, so depending on it
  // directly would re-run the effect and start a new pair of walks each pass.
  const [warmScheduler] = useState(() => scheduler);
  useEffect(() => {
    const walks = [
      new LazyBodyIdleWarm(paneRegistry, warmScheduler),
      new LazyBodyIdleWarm(screenRegistry, warmScheduler),
    ];
    for (const walk of walks) {
      walk.start();
    }
    return () => {
      for (const walk of walks) {
        walk.cancel();
      }
    };
  }, [paneRegistry, screenRegistry, warmScheduler]);
}
