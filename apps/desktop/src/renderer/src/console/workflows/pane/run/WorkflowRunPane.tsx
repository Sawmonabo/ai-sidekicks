// The run pane's body: what a run offers, what it cannot answer yet, and where the
// bodies another plan authors are mounted.
//
// The pane's job is to make a run readable and a parked phase actionable. The
// snapshot's rendering — phase sections, retry sub-entries, pool waits, outputs —
// is Plan-017's body and is mounted through this directory's typed slots; what this
// file owns is everything around them.
//
// THE PANE'S FRAME IS NOT THIS MODULE'S. `seats/ConsolePaneChrome` draws the section,
// the kind glyph, the breadcrumb, the control strip and the body box for every pane
// kind in the console; what this file returns is the BODY that goes inside it. The
// section, its tab stop, its accessible name and the actor's hue all arrive from
// there, which is why none of them is set here and why the pane is named by its whole
// address trail rather than by the words "Workflow run".
//
// ONE CHROME AND THREE BODIES, not three chromes. A pane wears its frame on every
// arm — an operator has to be able to close a pane that refused its address as
// readily as one showing a run — so the arms below decide only what stands inside the
// frame. `RUN_SCOPE` is what the trail is told, and it is the same derivation the
// read is held at: a run reaches the trail only where the address names one, so a
// pane that refused a definition id does not go on to announce itself as scoped to
// it. The run travels on the trail's RUN scope rather than as its entity, because it
// is both — and passed twice it would render the same identifier twice.
//
// NEITHER HOST CONTROL IS DEFAULTED. Closing a pane and tearing one off into a
// window are the DECK's acts, they reach the chrome through the host context the deck
// provides, and the honest rendering of a control whose act nobody can perform is to
// leave it out rather than draw it disabled. Neither kind in this family is
// detachable either — `seats/pane-kinds.ts` derives that from the window model's own
// closed set — so no handler is threaded here on any arm.
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
// The state strip's own switch renders exactly one of those, so this pane composes
// its body on the `ready` arm and renders the read's absence itself — the shape
// `WorkflowBuilderPane` established when its no-entity arm had more to show than one
// line. Collapsing the three would be the conflation rule 8 exists to prevent. The
// rendering of a SERVED read — the graph, the park cards and their routes — is
// `RunReadState.tsx`; what is left here is the address, the read, and the mounts.
//
// ONE HUMAN FORM IS MOUNTED AND THE PARK CARDS CHOOSE WHICH. A run that branches
// parks more than one phase on a person at a time, so the selection is held here,
// beside the read it is resolved against, and handed to both the cards that set it
// and the slot that renders it. `human-form-selection.ts` states why it is resolved
// from the current phases rather than stored.
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
// the Plan-017 body this pane mounts as much as it binds the cards beside it, which
// is why it is stated on the body that composes both rather than only on one of them.
//
// WIRE STATUS. `packages/contracts` registers no `workflow.*` method, so every one
// of these operations lives on the growth port behind the workflow slate row rather
// than on a bridge namespace. The READ is reachable there and this pane puts it: the
// fixture answers it from the running scenario, and a build with no answer gets the
// port's own typed refusal naming who owes the wire. The controls, the gate
// resolution and the phase-output read are not: no scenario settles a workflow
// mutation, so those still render a refusal and call nothing.

import { Nothing } from "../../../primitives/index.js";
import { ChatStartSlot } from "../../ChatStartSlot.js";
import { WorkflowStateStrip } from "../../WorkflowStateStrip.js";
import { refusedWorkflowStrip } from "../../strip-state.js";
import { ConsolePaneChrome, type PaneContextOf } from "../../../seats/index.js";
import type { ConsoleEntityRef } from "../../../store/index.js";
import { OperatorControls } from "./OperatorControls.js";
import { WORKFLOW_RUN_PANE_SUBJECT_KIND, misaddressedRunPane } from "./run-addressing.js";
import { unregisteredRunControl } from "./run-controls.js";
import { RunReadState } from "./RunReadState.js";
import { useWorkflowRunSnapshot } from "./run-snapshot.js";
import { useHumanFormSelection } from "./human-form-selection.js";
import { HumanFormSlot } from "./slots/HumanFormSlot.js";
import { RunDetailSlot } from "./slots/RunDetailSlot.js";

/** What this pane is for, in the one line that stands under its head. */
const SUMMARY = "One run's state, its phases, and why anything is parked.";

export interface WorkflowRunPaneProps {
  readonly context: PaneContextOf<"workflow-run">;
}

/** The run pane's body. The run detail and the human form inside it are Plan-017's. */
export function WorkflowRunPane(props: WorkflowRunPaneProps): React.JSX.Element {
  const { bridge, sessionStore, focusHue } = props.context;
  // WIDENED ON PURPOSE, and the annotation is the whole of it. This arm's `entity` is
  // declared as a run reference and required, but `paneBodyForKind` narrows a context
  // on its `kind` ALONE — the entity underneath is unverified — and a pane address is
  // also PARSED, out of a persisted layout an older build wrote and out of a route. A
  // parsed value is data rather than a proof, so the two guards below stay live and
  // this annotation is what keeps the compiler from calling them dead.
  const entity: ConsoleEntityRef | undefined = props.context.entity;
  // The id is taken from the address only where the address names a RUN. An entity
  // of another kind supplies nothing, so the read below is `unasked` on exactly the
  // arm that refuses — rather than in flight against an id that names no run.
  const addressedRunId = entity?.kind === WORKFLOW_RUN_PANE_SUBJECT_KIND ? entity.id : undefined;
  // Called before the two absent arms return, because a hook may not sit behind a
  // branch. With no run named the read is `unasked`, which is the honest state and
  // the one those arms never render.
  const snapshot = useWorkflowRunSnapshot(bridge.growth, addressedRunId);
  // Called before the absent arms return, for the same reason the read is: a hook may
  // not sit behind a branch. With no snapshot served there is no wait to select and the
  // selection resolves to nothing, which is what the arms below already render.
  //
  // The whole SNAPSHOT rather than its phases, because a form mount carries the run
  // the submit is addressed by beside the phase it was composed against, and the two
  // have to be the same answer. Handed `entity.id` separately, a pane retargeted
  // mid-read would pair the newly addressed run with the phases still on screen from
  // the run before it.
  //
  // The ADDRESS goes in beside it, and it is the same pair the read above is held at:
  // the selection is an answer about one run, and this pane is retargeted without ever
  // unmounting, so a mount-scoped selection outlived the run it was made about.
  const humanForms = useHumanFormSelection(
    bridge.growth,
    addressedRunId,
    snapshot.status === "served" ? snapshot.snapshot : undefined,
  );

  /**
   * Which of the three bodies stands inside the frame.
   *
   * A closure rather than three returns each wrapping a frame of its own: the frame is
   * the same on every arm, and duplicating it would put the address the trail reads in
   * three places to be decided, which is exactly how a head and its body come apart.
   */
  function renderBody(): React.JSX.Element {
    if (entity === undefined) {
      return (
        <WorkflowStateStrip summary={SUMMARY} state={{ kind: "ready" }}>
          <Nothing
            kind="empty"
            placement="surface"
            title="This pane names no run."
            detail="Open a run from the session's workflows browser and the pane follows it."
          />
          <ChatStartSlot sessionId={sessionStore?.sessionId} />
        </WorkflowStateStrip>
      );
    }

    if (entity.kind !== WORKFLOW_RUN_PANE_SUBJECT_KIND) {
      // The strip's own `refused` arm, which renders the refusal and NOT the children
      // — so no control, no slot and no start affordance stands beside an address this
      // surface will not open, and the read above was never composed for it. A banner
      // across the body rather than a card, because what changed is what this whole
      // surface can do, which is nothing.
      return (
        <WorkflowStateStrip
          summary={SUMMARY}
          state={refusedWorkflowStrip(misaddressedRunPane(entity.kind))}
        />
      );
    }

    return (
      <WorkflowStateStrip summary={SUMMARY} state={{ kind: "ready" }}>
        <RunReadState snapshot={snapshot} humanForms={humanForms} />
        <OperatorControls
          // The same pair the read above is held at. The controls hold a typed reason
          // and a chosen re-pin target, and both are answers about THIS run: a pane
          // retargeted in place must not carry either into the next one.
          growth={bridge.growth}
          workflowRunId={entity.id}
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
        <HumanFormSlot phase={humanForms.openForm} />
      </WorkflowStateStrip>
    );
  }

  return (
    <ConsolePaneChrome
      kind="workflow-run"
      sessionId={sessionStore?.sessionId}
      // The trail is told about the run the address NAMES, which is the same
      // derivation the read is held at: a pane handed a definition id refuses it
      // below, and a head that had already announced the pane as scoped to that id
      // would contradict the banner underneath it.
      runId={addressedRunId}
      // Straight through, including the absent arm: an unattributed pane sets no hue
      // and the sheet's own neutral fallback applies, which is one answer rather than
      // a default written here and a fallback written there.
      focusHue={focusHue}
    >
      {renderBody()}
    </ConsolePaneChrome>
  );
}
