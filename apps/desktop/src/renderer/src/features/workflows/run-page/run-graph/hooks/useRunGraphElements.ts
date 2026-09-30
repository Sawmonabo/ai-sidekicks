import { useMemo } from "react";

import type { DrawnPhaseSequence } from "../phase-sequence-layout.js";
import { toRunGraphElements, type RunGraphElements } from "../run-graph-elements.js";

/**
 * The renderer's arrays, rebuilt only when the layout moves.
 *
 * The layout is reference-stable across renders of one run, so the memo recomputes exactly
 * when the picture changes; the renderer re-enters its store whenever an array identity moves.
 */
export function useRunGraphElements(layout: DrawnPhaseSequence): RunGraphElements {
  return useMemo(() => toRunGraphElements(layout), [layout]);
}
