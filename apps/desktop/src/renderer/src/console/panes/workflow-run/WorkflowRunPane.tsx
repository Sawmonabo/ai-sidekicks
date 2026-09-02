// The run pane's chrome: a header, a park banner's home, and the run detail's slot.
//
// The pane's job is to make a run readable and a parked phase explicable from one
// run snapshot. The snapshot's rendering — phase sections, retry sub-entries, pool
// waits, outputs — is Plan-017's body and is mounted through `owner-slots.ts`; what
// this file owns is everything around it, and the two facts the chrome can state
// before any read has happened.
//
// TWO RULES THIS CHROME ENCODES RATHER THAN LEAVES TO THE BODY.
//
// A pane that names no run is EMPTY, not broken: the deck can open a run pane from a
// keybinding before an entity is chosen, and the honest answer is that this pane has
// no subject yet. A pane that names one and has not read it is NOT-CHECKED: nobody
// asked. Those are different next moves — pick a run, versus wait for a read — and
// collapsing them is the conflation rule 8 exists to prevent.
//
// PARK IS READ FROM THE PARK MEMBERS AND NEVER FROM A PHASE'S STATE. The phase state
// union carries no suspended arm on purpose, and the park members are live-scoped —
// present for exactly the phases parked when the response was built. That rule binds
// the body this pane mounts; it is stated here because this chrome frames the park
// banner and would otherwise be the natural place for someone to derive one.

import { WorkflowChrome } from "../../workflows/WorkflowChrome.js";
import { WorkflowSlotMount } from "../../workflows/WorkflowSlotMount.js";
import { WORKFLOW_HUMAN_FORM_SLOT, WORKFLOW_RUN_DETAIL_SLOT } from "../../workflows/owner-slots.js";
import { unaskedWorkflowChrome, type WorkflowChromeState } from "../../workflows/chrome-state.js";
import type { ConsolePaneContext } from "../../workspace/index.js";

/** The pane's own absence, before its read: no subject, or no answer for one. */
const UNADDRESSED: WorkflowChromeState = {
  kind: "empty",
  title: "This pane names no run.",
  detail: "Open a run from the session's runs section and the pane follows it.",
};

const UNREAD: WorkflowChromeState = unaskedWorkflowChrome(
  "This run has not been read in this window.",
  "The run snapshot and its live updates arrive from the daemon; nothing was asked of it here.",
);

export interface WorkflowRunPaneProps {
  readonly context: ConsolePaneContext;
}

/** The run pane's chrome. The run detail inside it is Plan-017's body. */
export function WorkflowRunPane(props: WorkflowRunPaneProps): React.JSX.Element {
  return (
    <WorkflowChrome
      glyph="run"
      heading="Workflow run"
      summary="One run's state, its phases, and why anything is parked."
      state={props.context.entity === undefined ? UNADDRESSED : UNREAD}
    >
      <WorkflowSlotMount
        slot={WORKFLOW_RUN_DETAIL_SLOT}
        title="The run detail is not built yet."
        detail="The run's state and its phase list render here once the workflow engine's own view ships."
      />
      <WorkflowSlotMount
        slot={WORKFLOW_HUMAN_FORM_SLOT}
        title="The form a parked phase is waiting on is not built yet."
        detail="A phase waiting on a person opens its form here; until then the phase is readable and not answerable."
      />
    </WorkflowChrome>
  );
}
