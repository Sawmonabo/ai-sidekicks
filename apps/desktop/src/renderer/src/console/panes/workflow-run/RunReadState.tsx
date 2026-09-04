// What stands above the run pane's slots for one read state, and why it is four things.
//
// Split out of `WorkflowRunPane.tsx` when the park cards grew a route to their own
// forms: the chrome file owns the pane's address guards, its three absences and its
// slot mounts, and this file owns the rendering of one served snapshot. Two jobs, two
// files, per `apps/desktop/AGENTS.md`.
//
// EVERY ARM IS A DIFFERENT FACT AND NONE OF THEM IS THE OTHERS: nobody asked, the read
// is in flight, the port refused by name, or a snapshot arrived and the parks on it are
// what an operator came for. Collapsing any two is the conflation the five kinds of
// nothing exist to prevent.
//
// PARK IS READ FROM THE PARK MEMBERS AND NEVER FROM A PHASE'S STATE. The phase state
// union carries no suspended arm on purpose, and the park members are live-scoped —
// present for exactly the phases parked when the response was built. Both surfaces
// below obey that through the projection's own `phasePark`, and neither re-derives it.

import type { WorkflowPhaseState, WorkflowRunSnapshot } from "../../bridge/index.js";
import { Nothing, RefusalBanner } from "../../primitives/index.js";
import { ParkBadge, type WorkflowParkFormRoute } from "../../workflows/ParkBadge.js";
import { parkAwaitsPerson, phasePark, parkSchedule } from "../../workflows/run-list-projection.js";
import type { WorkflowParkedPhase } from "../../workflows/run-list-projection.js";
import { PhaseGraph } from "./phase-graph/PhaseGraph.js";
import type { PhaseGraphNode, PhaseParkAttention } from "./phase-graph/phase-topology.js";
import type { WorkflowRunSnapshotState } from "./run-snapshot.js";
import {
  UNADDRESSABLE_HUMAN_WAIT_DETAIL,
  humanFormMountFor,
  type HumanFormSelection,
} from "./human-form-selection.js";

/**
 * The authored name this pane can put beside a phase, which is none of them.
 *
 * A CONSTANT, AND `undefined` RATHER THAN THE PHASE ID. Both surfaces below name a
 * phase — the graph labels a node and the park card captions a card — and both used
 * to be handed the phase id through a function called a display label. That put an
 * opaque wire key on screen in the face and weight an authored name would have had,
 * so a reader could not tell a chosen name from a generated one, which is the single
 * fact this pane is otherwise scrupulous about rendering the absence of.
 *
 * Both surfaces now take the name and the identifier as two values: the identifier
 * always, in the mono provenance signature `Spec-023 §Console Design (Meridian)`
 * rule 4 gives a wire-true figure, and the name only where there is one. There is
 * none here because the authored name lives on the definition body and no read
 * reachable from this build serves it (the graph's own comment enumerates why), and
 * this is the one place that says so — the day a definition read lands, its `name`
 * replaces this constant and both surfaces move together.
 */
const PHASE_DISPLAY_NAME: string | undefined = undefined;

/** What stands above the slots for one read state. */
export function RunReadState(props: {
  readonly snapshot: WorkflowRunSnapshotState;
  readonly humanForms: HumanFormSelection;
}): React.JSX.Element {
  const { snapshot } = props;
  switch (snapshot.status) {
    case "unasked":
      return (
        <Nothing
          kind="not-checked"
          placement="surface"
          title="This run has not been read in this window."
          detail="The run snapshot arrives from the daemon; nothing was asked of it here."
        />
      );
    case "reading":
      return <Nothing kind="not-loaded" placement="surface" title="Reading this run." />;
    case "unavailable":
      return <RefusalBanner {...snapshot.refusal} />;
    case "served":
      return (
        <>
          <RunPhaseGraph phases={snapshot.snapshot.phaseStates} />
          <RunParks run={snapshot.snapshot} humanForms={props.humanForms} />
        </>
      );
  }
}

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
function RunPhaseGraph(props: {
  readonly phases: readonly WorkflowPhaseState[];
}): React.JSX.Element {
  const nodes: readonly PhaseGraphNode[] = props.phases.map((phase) => ({
    phaseId: phase.phaseId,
    displayName: PHASE_DISPLAY_NAME,
    state: phase.state,
    gateState: phase.gateState,
    parkAttention: phaseParkAttention(phase),
  }));
  return <PhaseGraph phases={nodes} label="Phase sequence" />;
}

/**
 * How one phase's park reads on the canvas, or nothing where there is no park.
 *
 * THROUGH THE PROJECTION'S OWN TWO READINGS AND NEVER A THIRD MADE HERE. The graph
 * used to set a parked flag from `parkReason`'s presence, which is the discriminator
 * — correct about WHETHER there is a park and silent about what it is waiting for —
 * and the sheet then gave every one of them the amber border rule 3 reserves for a
 * person being needed. The fixture's own parked run carries the counterexample: a
 * provider-limited phase with a readable resume instant, which the badge below drew
 * neutral while the node above it drew amber.
 *
 * `phasePark` applies the discriminator and `parkAwaitsPerson` reads the classified
 * schedule, both in `workflows/`, and the badge takes its tone from the second of
 * them — so the card and the node now agree by construction rather than by two
 * surfaces happening to reach the same conclusion.
 */
function phaseParkAttention(phase: WorkflowPhaseState): PhaseParkAttention | undefined {
  const park = phasePark(phase);
  if (park === undefined) {
    return undefined;
  }
  return parkAwaitsPerson(parkSchedule(park)) ? "awaiting-person" : "scheduled";
}

/**
 * The route one park card offers to its own form, where the card has one.
 *
 * A run that branches parks more than one phase on a person at a time, and the pane
 * mounts ONE form slot — so every addressable wait carries the action that makes its
 * form the open one, and the card whose form is already open says so instead. A wait
 * the run reported without its handle says why it cannot be opened, which is the fact
 * the operator needs and the one a missing control does not give them.
 *
 * Returns the prop bag rather than the route, so the arm with no route omits the key
 * instead of passing `undefined` through it — the mount's own presence rule.
 */
function formRoutePropsFor(
  workflowRunId: string,
  phase: WorkflowPhaseState,
  humanForms: HumanFormSelection,
): { readonly formRoute?: WorkflowParkFormRoute } {
  if (phase.parkReason !== "waiting-human") {
    return {};
  }
  if (humanFormMountFor(workflowRunId, phase) === undefined) {
    return { formRoute: { kind: "unaddressable", detail: UNADDRESSABLE_HUMAN_WAIT_DETAIL } };
  }
  const { phaseId } = phase;
  return humanForms.isOpen(phaseId)
    ? { formRoute: { kind: "open" } }
    : {
        formRoute: {
          kind: "openable",
          openForm: () => {
            humanForms.openFormFor(phaseId);
          },
        },
      };
}

/**
 * Every phase parked at the moment the snapshot was built, and nothing else.
 *
 * A park is read from `parkReason` and never from a phase's `state` — the status
 * union has no suspended arm and the park members are live-scoped, so a phase that
 * has resumed past its park carries none of them and must not be shown as waiting.
 * `phasePark` applies that discriminator once, in the projection, and this surface
 * never re-derives it.
 *
 * A run with nothing parked says so rather than rendering an empty region: "nothing
 * is waiting on anyone" is the answer an operator opened this pane for.
 *
 * EVERY CARD IDENTIFIES ITS PHASE. A run that branches parks more than one phase at
 * a time, and a stack of cards carrying only reason, cause and schedule leaves an
 * operator unable to tell which branch stopped — the two cards of a fan-out read
 * identically. The badge draws that identity from `phaseId`, which is the same value
 * the node above the cards draws, so a person reads one key in two places rather
 * than matching a card to a node by position.
 */
function RunParks(props: {
  /**
   * The served run, not its phases: a card's route to its own form is the same mount
   * the slot below is handed, and that mount names the run as well as the phase.
   */
  readonly run: WorkflowRunSnapshot;
  readonly humanForms: HumanFormSelection;
}): React.JSX.Element {
  const parked = props.run.phaseStates.flatMap<{
    readonly entry: WorkflowParkedPhase;
    readonly phase: WorkflowPhaseState;
  }>((phase) => {
    const park = phasePark(phase);
    // Classified through the projection's own `parkSchedule` rather than by handing
    // the badge four wire members: whether a park resumes itself is not
    // `autoResumeAt`'s presence, and a second derivation of it here would be the
    // second authority the badge stopped being.
    //
    // `phaseName` is the badge's slot for an AUTHORED name and is left empty,
    // because this read carries none. The card is still identified: the badge draws
    // `phaseId` unconditionally, as a wire figure, which is what keeps a fan-out's
    // cards distinguishable without any surface inventing a name.
    return park === undefined
      ? []
      : [
          {
            entry: {
              phaseId: phase.phaseId,
              phaseName: PHASE_DISPLAY_NAME,
              park,
              schedule: parkSchedule(park),
            },
            phase,
          },
        ];
  });
  if (parked.length === 0) {
    return (
      <Nothing
        kind="empty"
        placement="inline"
        title="Nothing in this run is parked."
        detail="No phase is waiting on a person or on provider capacity right now."
      />
    );
  }
  return (
    <div className="meridian-workflow__parks">
      {parked.map(({ entry, phase }) => (
        // Keyed by the phase, which is the run's own identity for it, and the same
        // value the graph draws on that phase's node.
        <ParkBadge
          key={entry.phaseId}
          parked={entry}
          // Spread on the arm that has one and omitted on every other, rather than
          // passed as an explicit `undefined`: the prop's PRESENCE is what says this
          // surface can reach the phase's form, and a park waiting on provider
          // capacity has no form to reach at all.
          {...formRoutePropsFor(props.run.workflowRunId, phase, props.humanForms)}
        />
      ))}
    </div>
  );
}
