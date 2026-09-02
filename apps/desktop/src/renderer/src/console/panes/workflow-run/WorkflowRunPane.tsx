// The run pane's chrome: what a run offers, what it cannot answer yet, and where
// the bodies another plan authors are mounted.
//
// The pane's job is to make a run readable and a parked phase actionable. The
// snapshot's rendering — phase sections, retry sub-entries, pool waits, outputs —
// is Plan-017's body and is mounted through this directory's typed slots; what this
// file owns is everything around them.
//
// THREE ABSENCES, AND THEY ARE THREE BECAUSE THE NEXT MOVE DIFFERS FOR EACH.
//
//   • A pane that names no run is EMPTY: the deck can open a run pane from a
//     keybinding before an entity is chosen, and the next move is to pick one — or
//     to start one, which is why the conversational start is mounted on this arm
//     and on no other. A run view with no run offers the start affordance; a run
//     view that already has a run in front of the operator does not compete with it.
//   • A run this window has not read is NOT-CHECKED: nobody asked. It is not
//     "there is nothing" and not "we do not know" — no run read is reachable from
//     this build at all, so the honest answer is that no question was put.
//   • A body that has not been authored is a RESERVED slot, which the slot's own
//     shell says in its own words.
//
// The chrome's own state switch renders exactly one of those, so this pane composes
// its body on the `ready` arm and renders the read's absence itself — the shape
// `WorkflowBuilderPane` established when its no-entity arm had more to show than one
// line. Collapsing the three would be the conflation rule 8 exists to prevent.
//
// WHY THE CONTROLS RENDER BESIDE AN UNREAD RUN AND THE PLAN-017 BODIES DO NOT MAKE
// THAT ODD. "Can I stop this run?" is the first question an operator opening this
// pane has, and it needs no read to answer: the controls are a projection of what
// the daemon admitted, and on this build nothing admits them because no workflow
// operation is on the bridge. Rendering that as a typed refusal is the same honesty
// the growth port gives every other surface; hiding it would leave an operator
// waiting for a button that is never going to appear.
//
// PARK IS READ FROM THE PARK MEMBERS AND NEVER FROM A PHASE'S STATE. The phase state
// union carries no suspended arm on purpose, and the park members are live-scoped —
// present for exactly the phases parked when the response was built. That rule binds
// the body this pane mounts; it is stated here because this chrome frames the park
// banner and would otherwise be the natural place for someone to derive one.
//
// WIRE STATUS. `packages/contracts` registers no `workflow.*` method, so every one
// of these operations lives on the growth port behind the workflow slate row rather
// than on a bridge namespace. The READ is reachable there and this pane puts it: the
// fixture answers it from the running scenario, and a build with no answer gets the
// port's own typed refusal naming who owes the wire. The controls, the gate
// resolution and the phase-output read are not: no scenario settles a workflow
// mutation, so those still render a refusal and call nothing.

import type { WorkflowPhaseState } from "../../bridge/index.js";
import { Nothing, RefusalBanner } from "../../primitives/index.js";
import { WorkflowChrome } from "../../workflows/WorkflowChrome.js";
import { ParkBadge } from "../../workflows/ParkBadge.js";
import { phasePark, parkSchedule } from "../../workflows/run-list-projection.js";
import type { WorkflowParkedPhase } from "../../workflows/run-list-projection.js";
import type { ConsolePaneContext } from "../../workspace/index.js";
import { OperatorControls } from "./OperatorControls.js";
import { unregisteredRunControl } from "./run-controls.js";
import { PhaseGraph } from "./phase-graph/PhaseGraph.js";
import type { PhaseGraphNode } from "./phase-graph/phase-topology.js";
import { useWorkflowRunSnapshot, type WorkflowRunSnapshotState } from "./run-snapshot.js";
import { ChatStartSlot } from "./slots/ChatStartSlot.js";
import { HumanFormSlot, type HumanFormMount } from "./slots/HumanFormSlot.js";
import { RunDetailSlot } from "./slots/RunDetailSlot.js";

/** The surface's name and its one-line purpose, written once for both arms. */
const HEADING = "Workflow run";
const SUMMARY = "One run's state, its phases, and why anything is parked.";

export interface WorkflowRunPaneProps {
  readonly context: ConsolePaneContext;
}

/**
 * The phase whose form is open, resolved from a snapshot.
 *
 * The FIRST phase parked on a person, and only where the wire carried both members
 * the mount needs. `phaseRunId` and `formRevision` are additive-optional on an
 * already-published shape, so their absence means an older daemon rather than a
 * phase without a form — and a mount composed with either one guessed would be
 * answerable in appearance and unsubmittable in fact.
 */
function openHumanFormFor(phases: readonly WorkflowPhaseState[]): HumanFormMount | undefined {
  for (const phase of phases) {
    if (phase.parkReason !== "waiting-human") {
      continue;
    }
    const { phaseRunId, formRevision } = phase;
    if (phaseRunId === undefined || formRevision === undefined) {
      // The park is real and the form is not addressable from what arrived. The
      // park banner still says the run is waiting on a person; what is missing is
      // the handle to answer it, which is the daemon's revision to supply.
      return undefined;
    }
    return { phaseRunId, phaseId: phase.phaseId, formRevision };
  }
  return undefined;
}

/**
 * How one phase is named wherever this pane names one.
 *
 * ONE DERIVATION FOR TWO SURFACES, which is the point of the function rather than an
 * incidental tidiness: the graph labels a node and the park card names a phase, and
 * an operator reading a card is matching it against a node. Two call sites each
 * reaching for a member would be two chances to disagree, and a disagreement here is
 * invisible — both would render a plausible string.
 *
 * IT IS THE PHASE ID BECAUSE NOTHING ELSE IS READABLE FROM HERE. The projection
 * carries an optional `phaseName` for surfaces that have one; the run read this pane
 * puts is not such a surface, because the authored name lives on the definition body
 * and no read reachable from this build serves it (the graph's own comment
 * enumerates why). So the id travels, exactly as the wire sent it — composing a
 * prettier label out of it, title-casing it or splitting it on separators, would put
 * an invented name on screen that is indistinguishable from an authored one. The
 * graph renders the same value as a node's label, so a card and a node agree by
 * construction, and the day a definition read lands this function is the single
 * place its `name` replaces the id and both surfaces move together.
 */
function phaseDisplayLabel(phase: WorkflowPhaseState): string {
  return phase.phaseId;
}

/**
 * What stands above the slots for one read state.
 *
 * Every arm is a different fact and none of them is the others: nobody asked, the
 * read is in flight, the port refused by name, or a snapshot arrived and the parks
 * on it are what an operator came for. Collapsing any two is the conflation the five
 * kinds of nothing exist to prevent.
 */
function RunReadState(props: { readonly snapshot: WorkflowRunSnapshotState }): React.JSX.Element {
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
          <RunParks phases={snapshot.snapshot.phaseStates} />
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
 * THE LABEL IS THE PHASE ID AND NOT A NAME, for the same reason at one remove: the
 * name lives in that same unreachable definition body. A graph that composed a
 * readable label from the id would be inventing exactly the fact this family renders
 * the absence of, and an invented name is indistinguishable on screen from an
 * authored one.
 *
 * THE PARK IS READ FROM `parkReason` AND NEVER FROM A PHASE'S STATE, the same rule
 * the park banner beneath obeys: the status union has no suspended arm, and the park
 * members are live-scoped, so a phase that resumed past its park carries none of them.
 */
function RunPhaseGraph(props: {
  readonly phases: readonly WorkflowPhaseState[];
}): React.JSX.Element {
  const nodes: readonly PhaseGraphNode[] = props.phases.map((phase) => ({
    phaseId: phase.phaseId,
    label: phaseDisplayLabel(phase),
    state: phase.state,
    gateState: phase.gateState,
    isParked: phase.parkReason !== undefined,
  }));
  return <PhaseGraph phases={nodes} label="Phase sequence" />;
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
 * EVERY CARD NAMES ITS PHASE. A run that branches parks more than one phase at a
 * time, and a stack of cards carrying only reason, cause and schedule leaves an
 * operator unable to tell which branch stopped — the two cards of a fan-out read
 * identically. The identity is the same value the node above the cards is labelled
 * with, so a person reads one key in two places rather than matching a card to a
 * node by position.
 */
function RunParks(props: { readonly phases: readonly WorkflowPhaseState[] }): React.JSX.Element {
  const parked = props.phases.flatMap<WorkflowParkedPhase>((phase) => {
    const park = phasePark(phase);
    // Classified through the projection's own `parkSchedule` rather than by handing
    // the badge four wire members: whether a park resumes itself is not
    // `autoResumeAt`'s presence, and a second derivation of it here would be the
    // second authority the badge stopped being.
    //
    // `phaseName` is the badge's identity slot, and it is fed rather than left
    // empty: a badge handed nothing renders nothing for it, which is the stack of
    // indistinguishable cards this arm exists to fix.
    return park === undefined
      ? []
      : [
          {
            phaseId: phase.phaseId,
            phaseName: phaseDisplayLabel(phase),
            park,
            schedule: parkSchedule(park),
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
      {parked.map((entry) => (
        // Keyed by the phase, which is the run's own identity for it, and named by
        // the same derivation the graph labels that phase's node with.
        <ParkBadge key={entry.phaseId} parked={entry} />
      ))}
    </div>
  );
}

/** The run pane's chrome. The run detail and the human form inside it are Plan-017's. */
export function WorkflowRunPane(props: WorkflowRunPaneProps): React.JSX.Element {
  const { bridge, entity, sessionStore } = props.context;
  // Called before the no-run arm returns, because a hook may not sit behind a
  // branch. With no run named the read is `unasked`, which is the honest state and
  // the one the arm below never renders.
  const snapshot = useWorkflowRunSnapshot(bridge.growth, entity?.id);

  if (entity === undefined) {
    return (
      <WorkflowChrome glyph="run" heading={HEADING} summary={SUMMARY} state={{ kind: "ready" }}>
        <Nothing
          kind="empty"
          placement="surface"
          title="This pane names no run."
          detail="Open a run from the session's workflows browser and the pane follows it."
        />
        <ChatStartSlot sessionId={sessionStore?.sessionId} />
      </WorkflowChrome>
    );
  }

  return (
    <WorkflowChrome glyph="run" heading={HEADING} summary={SUMMARY} state={{ kind: "ready" }}>
      <RunReadState snapshot={snapshot} />
      <OperatorControls
        cancel={{ kind: "refused", refusal: unregisteredRunControl("cancel") }}
        resume={{ kind: "refused", refusal: unregisteredRunControl("resume") }}
      />
      <RunDetailSlot workflowRunId={entity.id} />
      <HumanFormSlot
        phase={
          snapshot.status === "served" ? openHumanFormFor(snapshot.snapshot.phaseStates) : undefined
        }
      />
    </WorkflowChrome>
  );
}
