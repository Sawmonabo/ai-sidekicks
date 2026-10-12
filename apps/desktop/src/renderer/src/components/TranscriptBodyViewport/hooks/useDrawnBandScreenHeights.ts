import { useContext } from "react";

import { type DrawnBandScreenHeights } from "#renderer/lib/scroll/window-side.js";
import { DrawnBandContext } from "../context.js";

/**
 * How far beyond each edge of the scroller a window nested in a row draws its items, as the
 * viewport's render draws its rows. Throws outside a transcript viewport.
 */
export function useDrawnBandScreenHeights(): DrawnBandScreenHeights {
  const bandScreenHeights = useContext(DrawnBandContext);
  if (bandScreenHeights === undefined) {
    throw new Error("A window nested in a row was drawn outside a transcript viewport.");
  }
  return bandScreenHeights;
}
