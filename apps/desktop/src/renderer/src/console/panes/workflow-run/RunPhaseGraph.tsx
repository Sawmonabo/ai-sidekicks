// The run's phases as a picture, and how one phase's park reads on the canvas.
//
// A SIBLING RATHER THAN A SECOND COMPONENT IN `RunReadState.tsx`, which is the
// package's one-component-per-`.tsx` rule: a module holding three components is a
// module whose name answers for one of them, and the other two are reached only by
// reading the file. `primitives/ReadingNotice.tsx` is the precedent — a deep relative
// import from its host, and no door line, because nothing outside this family
// composes it.
//
// PARK IS READ FROM THE PARK MEMBERS AND NEVER FROM A PHASE'S STATE. The phase state
// union carries no suspended arm on purpose, and the park members are live-scoped —
// present for exactly the phases parked when the response was built. This surface
// obeys that through the projection's own `phasePark`, and re-derives nothing.

import type { WorkflowPhaseState } from "../../bridge/index.js";
import { parkAwaitsPerson } from "../../workflows/runs/run-list-projection.js";
import type { WorkflowParkedPhase } from "../../workflows/runs/run-list-projection.js";
import { projectParkedPhases } from "../../workflows/runs/run-list-projection.js";
import { PhaseGraph } from "./phase-graph/PhaseGraph.js";
import type { PhaseGraphNode, PhaseParkAttention } from "./phase-graph/phase-topology.js";

/**
 * The run's phases as a picture, in the order the run read carried them.
 *
 * NO TOPOLOGY IS HANDED OVER, SO NO EDGE IS DRAWN, and that is a fact about what this
 * console can read rather than a choice about what to show. `workflow.runRead`
 * answers with an ordered `phaseStates` array, a `workflowVersionId`, and no
 * dependencies at all; the sequence edges, the fan-out and the joins live on the
 * pinned definition's `dependsOn` lists. NO registered read reachable from here
 * yields that definition:
 *
 *   • `workflow.definitionRead` and `workflow.versionRead` are the two that serve a
 *     definition BODY, and they are among the four registered workflow methods the
 *     growth row does not carry — neither is on the port, so neither can be called.
 *   • `workflow.definitionList` IS on the port, and its entries carry no phase
 *     definitions at all. Its `latestWorkflowVersionId` also matches a run's pin only
 *     while the run is on the latest version, which is false for exactly the
 *     frozen-pin runs whose topology an operator most needs to see.
 *   • The run enumeration answers with the same run shape as the read, so it carries
 *     no definition reference to resolve either.
 *
 * So the only way to draw a connector today is to infer one from array order, which
 * is what this pane used to do and what presented a parallel run as a serial chain.
 * The graph draws the states and captions the absence instead; the day a definition
 * read lands on the port, this is the one call site that grows a `topology` prop.
 *
 * A NODE CARRIES THE NAME AND THE IDENTIFIER SEPARATELY, and this pane supplies no
 * name: it lives in that same unreachable definition body. Composing a readable
 * label out of the id would invent exactly the fact this family renders the absence
 * of, and passing the id AS the name — which this surface did — is the same
 * invention with the composing step left out.
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
      // The name the projection carried, which is the same member the run list's own
      // badges draw. There is none on this read — the authored name lives on the
      // definition body and no read reachable from this build serves it — and the node
      // shows the identifier for it, which is why the fallback lives in
      // `phaseDisplayText` rather than in a name invented here. The day a definition
      // read lands, the projection picks the name up and both surfaces move with it.
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
 * THROUGH THE PROJECTION'S OWN READINGS AND NEVER ONE MADE HERE. The graph used to set
 * a parked flag from `parkReason`'s presence, which is the discriminator — correct
 * about WHETHER there is a park and silent about what it is waiting for — and the sheet
 * then gave every one of them the amber border rule 3 reserves for a person being
 * needed. The fixture's own parked run carries the counterexample: a provider-limited
 * phase with a readable resume instant, which the badge below drew neutral while the
 * node above it drew amber.
 *
 * The discriminator and the schedule classification are the projection's, and
 * `parkAwaitsPerson` reads the result — the same reading the badge takes its tone from
 * — so the card and the node agree by construction rather than by two surfaces
 * happening to reach the same conclusion. What is left here is the canvas's own
 * vocabulary for that answer, which no other surface spells.
 */
function parkAttentionOf(parked: WorkflowParkedPhase | undefined): PhaseParkAttention | undefined {
  if (parked === undefined) {
    return undefined;
  }
  return parkAwaitsPerson(parked.schedule) ? "awaiting-person" : "scheduled";
}
