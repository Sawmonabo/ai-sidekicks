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
// AN ADDRESS IS CHECKED BEFORE IT IS USED, AND THE CHECK STAYS WHEN THE TYPE SAYS IT
// CANNOT FAIL. The pane used to read `entity.id` on any kind at all, so a
// `workflow-definition` addressed here had its id carried into the run read and
// whatever came back — the port's refusal, or a snapshot — was shown under an address
// that never named a run. `ConsolePaneAddress` is becoming a kind-scoped union, which
// makes that address unconstructible by code in this process; the guard below is the
// FAIL-CLOSED PROJECTION of that type and does not go away with it, because a pane
// address is also PARSED — out of a persisted layout an older build wrote, and out of
// a route — and a parsed value is data rather than a proof. The builder pane holds
// the same guard for the kind it authors, and both refuse through one sentence
// (`workflows/pane-addressing.ts`).
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
import { ChatStartSlot } from "../../workflows/ChatStartSlot.js";
import { WorkflowChrome } from "../../workflows/WorkflowChrome.js";
import { refusedWorkflowChrome } from "../../workflows/chrome-state.js";
import { ParkBadge } from "../../workflows/ParkBadge.js";
import { parkAwaitsPerson, phasePark, parkSchedule } from "../../workflows/run-list-projection.js";
import type { WorkflowParkedPhase } from "../../workflows/run-list-projection.js";
import type { ConsolePaneContext } from "../../workspace/index.js";
import { OperatorControls } from "./OperatorControls.js";
import { WORKFLOW_RUN_PANE_SUBJECT_KIND, misaddressedRunPane } from "./run-addressing.js";
import { unregisteredRunControl } from "./run-controls.js";
import { PhaseGraph } from "./phase-graph/PhaseGraph.js";
import type { PhaseGraphNode, PhaseParkAttention } from "./phase-graph/phase-topology.js";
import { useWorkflowRunSnapshot, type WorkflowRunSnapshotState } from "./run-snapshot.js";
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
 * A NODE CARRIES THE NAME AND THE IDENTIFIER SEPARATELY, and this pane supplies no
 * name: it lives in that same unreachable definition body. Composing a readable
 * label out of the id would invent exactly the fact this family renders the absence
 * of, and passing the id AS the name — which this surface did — is the same
 * invention with the composing step left out.
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
function RunParks(props: { readonly phases: readonly WorkflowPhaseState[] }): React.JSX.Element {
  const parked = props.phases.flatMap<WorkflowParkedPhase>((phase) => {
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
            phaseId: phase.phaseId,
            phaseName: PHASE_DISPLAY_NAME,
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
        // Keyed by the phase, which is the run's own identity for it, and the same
        // value the graph draws on that phase's node.
        <ParkBadge key={entry.phaseId} parked={entry} />
      ))}
    </div>
  );
}

/** The run pane's chrome. The run detail and the human form inside it are Plan-017's. */
export function WorkflowRunPane(props: WorkflowRunPaneProps): React.JSX.Element {
  const { bridge, entity, sessionStore } = props.context;
  // The id is taken from the address only where the address names a RUN. An entity
  // of another kind supplies nothing, so the read below is `unasked` on exactly the
  // arm that refuses — rather than in flight against an id that names no run.
  const addressedRunId = entity?.kind === WORKFLOW_RUN_PANE_SUBJECT_KIND ? entity.id : undefined;
  // Called before the two absent arms return, because a hook may not sit behind a
  // branch. With no run named the read is `unasked`, which is the honest state and
  // the one those arms never render.
  const snapshot = useWorkflowRunSnapshot(bridge.growth, addressedRunId);

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

  if (entity.kind !== WORKFLOW_RUN_PANE_SUBJECT_KIND) {
    // The chrome's own `refused` arm, which renders the refusal and NOT the children
    // — so no control, no slot and no start affordance stands beside an address this
    // surface will not open, and the read above was never composed for it. A banner
    // across the surface rather than a card, because what changed is what this whole
    // surface can do, which is nothing.
    return (
      <WorkflowChrome
        glyph="run"
        heading={HEADING}
        summary={SUMMARY}
        state={refusedWorkflowChrome(misaddressedRunPane(entity.kind))}
      />
    );
  }

  return (
    <WorkflowChrome glyph="run" heading={HEADING} summary={SUMMARY} state={{ kind: "ready" }}>
      <RunReadState snapshot={snapshot} />
      <OperatorControls
        cancel={{ kind: "refused", refusal: unregisteredRunControl("cancel") }}
        resume={{ kind: "refused", refusal: unregisteredRunControl("resume") }}
      />
      <RunDetailSlot
        workflowRunId={entity.id}
        // Spread on the served arm and omitted on every other, rather than passed as
        // an explicit `undefined`: the mount's own rule is that the key's PRESENCE is
        // the arm the pane was on, and a key carrying nothing would be the null the
        // type refuses. The same narrowing the human-form mount below performs.
        {...(snapshot.status === "served" ? { snapshot: snapshot.snapshot } : {})}
      />
      <HumanFormSlot
        phase={
          snapshot.status === "served" ? openHumanFormFor(snapshot.snapshot.phaseStates) : undefined
        }
      />
    </WorkflowChrome>
  );
}
