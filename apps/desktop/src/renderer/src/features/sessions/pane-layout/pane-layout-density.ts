// What the density presets mean. Each preset is one number: the narrowest a pane may be squeezed
// to before the layout takes no more width from it. It is a minimum width rather than a scale
// factor because the choice is how many panes fit side by side, and a floor is what the layout
// math consults.
//
// The presets and their widths live in `pane-layout-measures.ts`. This module is free of DOM
// and React, so the layout class, the separator math and tests can all read it.

import {
  PANE_LAYOUT_DENSITIES,
  PANE_LAYOUT_MINIMUM_PANE_WIDTH_PX,
  type PaneLayoutDensity,
} from "./pane-layout-measures.js";

/**
 * Whether `value` names a preset. Takes `unknown` because the caller reads a persisted
 * snapshot, whose preset may not exist in this build.
 */
export function isPaneLayoutDensity(value: unknown): value is PaneLayoutDensity {
  return typeof value === "string" && (PANE_LAYOUT_DENSITIES as readonly string[]).includes(value);
}

/** The narrowest a pane may be at this preset, in CSS pixels. */
export function minimumPaneWidthPx(density: PaneLayoutDensity): number {
  return PANE_LAYOUT_MINIMUM_PANE_WIDTH_PX[density];
}
