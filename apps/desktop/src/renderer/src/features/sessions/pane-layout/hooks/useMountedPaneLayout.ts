import { useEffect } from "react";

import type { PaneLayoutActs } from "../pane-layout-acts.js";
import { mountedPaneLayouts, type MountedPaneLayouts } from "../mounted-pane-layouts.js";

/** Adopt the seat for as long as this deck is mounted. */
export function useMountedPaneLayout(
  acts: PaneLayoutActs,
  mountedLayouts: MountedPaneLayouts = mountedPaneLayouts,
): void {
  useEffect(() => mountedLayouts.adopt(acts), [acts, mountedLayouts]);
}
