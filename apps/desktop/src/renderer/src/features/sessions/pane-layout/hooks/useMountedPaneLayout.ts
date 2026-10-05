import { useEffect } from "react";

import { useOwnerWindow } from "@renderer/hooks/owner-window/useOwnerWindow.js";

import type { PaneLayoutActs } from "../pane-layout-acts.js";
import { mountedPaneLayouts, type MountedPaneLayouts } from "../mounted-pane-layouts.js";

/** Register this pane layout's acts as its window's while it is mounted. */
export function useMountedPaneLayout(
  acts: PaneLayoutActs,
  mountedLayouts: MountedPaneLayouts = mountedPaneLayouts,
): void {
  const ownerDocument = useOwnerWindow().document;
  useEffect(() => mountedLayouts.adopt(acts, ownerDocument), [acts, mountedLayouts, ownerDocument]);
}
