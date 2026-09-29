// The run's phases as a picture, and how one phase's park reads on the canvas.
//
// One component per `.tsx`: a module holding several is a module whose name answers for
// one of them.
//
// PARK IS READ FROM THE PARK MEMBERS AND NEVER FROM A PHASE'S STATE. The phase state
// union carries no suspended arm on purpose, and the park members are live-scoped —
// present for exactly the phases parked when the response was built. This surface
// obeys that through the projection's own `phasePark`, and re-derives nothing.

import type { WorkflowPhaseState } from "@renderer/services/wire-shapes/workflow-projection.js";
import { projectParkedPhases } from "../../runs/run-list-projection.js";
import { parkAwaitsPerson, type WorkflowParkedPhase } from "../../runs/run-list-rows.js";
import { PhaseGraph } from "@renderer/console/workflows/pane/run/phase-graph/PhaseGraph.js";
import type { PhaseGraphNode, PhaseParkAttention } from "../run-graph/phase-topology.js";

/**
 * The run's phases as a picture, in the order the run read carried them.
 *
 * No topology is passed, so no edge is drawn. The run read answers with an ordered
 * `phaseStates` array and a `workflowVersionId` and no dependencies; those live on the
 * pinned definition's `dependsOn` lists, and a definition's `latestWorkflowVersionId`
 * matches a run's pin only while the run is on the latest version, which is false for
 * the frozen-pin runs whose topology an operator most needs. Inferring edges from array
 * order would draw a parallel run as a serial chain, so the graph draws the states and
 * captions the absence.
 *
 * A node carries the name and the identifier separately, and this pane supplies no name:
 * it lives in the definition body, which the run read does not carry. Composing a label
 * out of the id, or passing the id as the name, would invent a fact.
 */
export function RunPhaseGraph(props: {
  readonly phases: readonly WorkflowPhaseState[];
}): React.JSX.Element {
  // The park projection, once, and indexed by the phase it is about. A node is built
  // from the WIRE phase — `gateState` is one of the members a list row drops — so the
  // two are joined here rather than the projection being asked for a shape no other
  // caller wants.
  const parkedByPhaseId = new Map(
    projectParkedPhases(props.phases).map((entry) => [entry.phaseId, entry]),
  );
  const nodes: readonly PhaseGraphNode[] = props.phases.map((phase) => {
    const parked = parkedByPhaseId.get(phase.phaseId);
    return {
      phaseId: phase.phaseId,
      // The name the projection carried, the same member the run list's badges draw. The
      // run read carries none, and the node falls back to the identifier in
      // `phaseDisplayText` rather than in a name made up here.
      displayName: parked?.phaseName,
      state: phase.state,
      gateState: phase.gateState,
      parkAttention: parkAttentionOf(parked),
    };
  });
  return <PhaseGraph phases={nodes} label="Phase sequence" />;
}

/**
 * How one park reads on the canvas, or nothing where the phase carries none.
 *
 * Taken from the projection's own readings and never made here. `parkReason`'s presence
 * says whether there is a park, not what it waits for, and amber is reserved for a person
 * being needed: a provider-limited phase with a readable resume instant needs nobody.
 * `parkAwaitsPerson` is the reading the park badge takes its tone from, so a card and its
 * node agree by construction.
 */
function parkAttentionOf(parked: WorkflowParkedPhase | undefined): PhaseParkAttention | undefined {
  if (parked === undefined) {
    return undefined;
  }
  return parkAwaitsPerson(parked.schedule) ? "awaiting-person" : "scheduled";
}
