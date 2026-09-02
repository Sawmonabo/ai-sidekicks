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
// WIRE STATUS. `packages/contracts` registers no `workflow.*` method and the growth
// port carries no workflow operation, so the run read, the run controls, the gate
// resolution and the phase-output read are all unreachable. The console renders
// their absence and calls nothing.

import { Nothing } from "../../primitives/index.js";
import { WorkflowChrome } from "../../workflows/WorkflowChrome.js";
import type { ConsolePaneContext } from "../../workspace/index.js";
import { OperatorControls } from "./OperatorControls.js";
import { unregisteredRunControl } from "./run-controls.js";
import { ChatStartSlot } from "./slots/ChatStartSlot.js";
import { HumanFormSlot } from "./slots/HumanFormSlot.js";
import { RunDetailSlot } from "./slots/RunDetailSlot.js";

/** The surface's name and its one-line purpose, written once for both arms. */
const HEADING = "Workflow run";
const SUMMARY = "One run's state, its phases, and why anything is parked.";

export interface WorkflowRunPaneProps {
  readonly context: ConsolePaneContext;
}

/** The run pane's chrome. The run detail and the human form inside it are Plan-017's. */
export function WorkflowRunPane(props: WorkflowRunPaneProps): React.JSX.Element {
  const { entity, sessionStore } = props.context;

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
      <Nothing
        kind="not-checked"
        placement="surface"
        title="This run has not been read in this window."
        detail="The run snapshot and its live updates arrive from the daemon; nothing was asked of it here."
      />
      <OperatorControls
        cancel={{ kind: "refused", refusal: unregisteredRunControl("cancel") }}
        resume={{ kind: "refused", refusal: unregisteredRunControl("resume") }}
      />
      <RunDetailSlot workflowRunId={entity.id} />
      {/*
        `phase={undefined}` is the honest state and not an oversight: which phase is
        waiting is a fact about the run, no run read is reachable from this build,
        and a pane that named one anyway would be inventing the answer it is here to
        report the absence of.
      */}
      <HumanFormSlot phase={undefined} />
    </WorkflowChrome>
  );
}
