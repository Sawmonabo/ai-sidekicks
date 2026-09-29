import { useRef } from "react";

import { PhaseSequenceLayoutCache, type PhaseSequenceLayout } from "../phase-sequence-layout.js";
import type { RunGraphNode, PhaseTopology } from "../phase-topology.js";

/**
 * Place the phases, holding the result still while the run does.
 *
 * The cache is built once per mount through a ref rather than on each render: a new
 * cache every render would memoise nothing, and constructing one in a render body is
 * the construction React may discard.
 */
export function usePhaseSequenceLayout(
  phases: readonly RunGraphNode[],
  topology: PhaseTopology | undefined,
): PhaseSequenceLayout {
  const cacheRef = useRef<PhaseSequenceLayoutCache | undefined>(undefined);
  const cache = (cacheRef.current ??= new PhaseSequenceLayoutCache());
  return cache.layoutFor(phases, topology);
}
