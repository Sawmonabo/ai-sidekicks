// When a settings window warms its deferred pages, and what stops it.
//
// The walk starts in `useEffect`, after the first frame commits, so it does not compete with the
// frame that draws the rail. It belongs to the mount: the page board is composed per settings
// mount, so the walk is canceled on unmount. `useLazyBodyIdleWarm` binds two window-scoped
// boards under one cleanup, a different lifetime, and a feature may not import from the frame. A
// board of only `render:` pages is still walked: it ends on its first step and fetches nothing.

import { useEffect, useState } from "react";

import {
  LazyBodyIdleWarm,
  idleWarmScheduler,
  type IdleWarmScheduler,
} from "@renderer/components/LazyBody/lazy-body-warm.js";
import { type SettingsPageRegistry } from "../settings-pages.js";

/**
 * Warm this mount's loader-backed settings pages once, after its first frame.
 *
 * Takes the board the screen renders, since there is no process-wide page registry. The
 * scheduler is a parameter so a suite drives the walk without a browser; the default is the
 * feature-detected one.
 */
export function useSettingsPageIdleWarm(
  pages: SettingsPageRegistry,
  scheduler: IdleWarmScheduler = idleWarmScheduler(),
): void {
  // Pinned: the default argument builds a scheduler on every render, so depending on it would
  // restart the walk each pass.
  const [warmScheduler] = useState(() => scheduler);
  useEffect(() => {
    // Built inside the setup: a walk is once-per-instance and permanently cancelable, so under
    // `StrictMode` a held walk would be canceled by the replayed cleanup and stay cold.
    const walk = new LazyBodyIdleWarm(pages, warmScheduler);
    walk.start();
    return () => {
      walk.cancel();
    };
  }, [pages, warmScheduler]);
}
