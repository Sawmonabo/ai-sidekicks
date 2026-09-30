// The run's phases as a picture, and how one phase's park reads on the canvas. A park is read
// from the projection's park members, never from a phase's state, which has no suspended arm; the
// park members are present for exactly the phases parked when the response was built.

import type { WorkflowPhaseState } from "@renderer/services/wire-shapes/workflow-projection.js";
import { projectParkedPhases } from "../../runs/run-list-projection.js";
import { parkAwaitsPerson, type WorkflowParkedPhase } from "../../runs/run-list-rows.js";
import { RunGraph } from "../run-graph/RunGraph.js";
import type { RunGraphNode, PhaseParkAttention } from "../run-graph/phase-topology.js";

/**
 * The run's phases as a picture, in the order the run read carried them.
 *
 * No topology is passed, so no edge is drawn: the run read carries no dependencies, they live on
 * the pinned definition, and a definition's latest version matches a run's pin only while the
 * run is on the latest version. Inferring edges from array order would draw a parallel run as a
 * serial chain, so the graph draws the states and captions the absence. Nodes carry no name
 * because it lives in the definition body, which the run read does not carry.
 */
export function RunGraphSection(props: {
  readonly phases: readonly WorkflowPhaseState[];
}): React.JSX.Element {
  // The park projection, once, indexed by phase. A node is built from the wire phase because
  // `gateState` is a member a list row drops.
  const parkedByPhaseId = new Map(
    projectParkedPhases(props.phases).map((entry) => [entry.phaseId, entry]),
  );
  const nodes: readonly RunGraphNode[] = props.phases.map((phase) => {
    const parked = parkedByPhaseId.get(phase.phaseId);
    return {
      phaseId: phase.phaseId,
      // The projection's name, the same member the run list's badges draw; the node falls back
      // to the identifier in `phaseDisplayText`.
      displayName: parked?.phaseName,
      state: phase.state,
      gateState: phase.gateState,
      parkAttention: parkAttentionOf(parked),
    };
  });
  return <RunGraph phases={nodes} label="Phase sequence" />;
}

/**
 * How one park reads on the canvas, or nothing where the phase carries none. Amber is reserved
 * for a person being needed, so it uses `parkAwaitsPerson`, the reading the park badge takes its
 * tone from.
 */
function parkAttentionOf(parked: WorkflowParkedPhase | undefined): PhaseParkAttention | undefined {
  if (parked === undefined) {
    return undefined;
  }
  return parkAwaitsPerson(parked.schedule) ? "awaiting-person" : "scheduled";
}
