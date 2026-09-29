import { useMemo } from "react";

import type { DrawnPhaseSequence } from "../phase-sequence-layout.js";
import { toRunGraphElements, type RunGraphElements } from "../run-graph-elements.js";

/**
 * The renderer's arrays, rebuilt only when the layout moves.
 *
 * A hook rather than a call in a render body, per `apps/desktop/AGENTS.md`, and the
 * dependency is exact: the layout object upstream is already reference-stable across
 * renders that describe one run, so this memo recomputes precisely when the picture
 * changes and never otherwise. That matters because the renderer re-enters its own
 * store whenever the node or edge array identity moves.
 */
export function useRunGraphElements(layout: DrawnPhaseSequence): RunGraphElements {
  return useMemo(() => toRunGraphElements(layout), [layout]);
}
