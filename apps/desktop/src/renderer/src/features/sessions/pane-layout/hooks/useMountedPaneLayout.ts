import { useEffect } from "react";

import type { PaneLayoutActs } from "../pane-layout-acts.js";
import { mountedPaneLayouts, type MountedPaneLayouts } from "../mounted-pane-layouts.js";

/** Register this pane layout's acts with the mounted pane layouts while it is mounted. */
export function useMountedPaneLayout(
  acts: PaneLayoutActs,
  mountedLayouts: MountedPaneLayouts = mountedPaneLayouts,
): void {
  useEffect(() => mountedLayouts.adopt(acts), [acts, mountedLayouts]);
}
