// The human phase's form slot — where the prompt, the schema-derived controls, and the
// submission that carries the revision they were composed against are mounted.
//
// OWNED BY PLAN-017, AND FILLED BY THIS CONSOLE UNTIL THAT BODY ARRIVES. The workflow
// plan authors the body that finally stands here. What stands here today is the
// console's own fixture shell (`HumanFormShell.tsx`): a real form over the schema the
// run read carried, sending the registered `workflowHumanFormSubmit`, refusing through
// whatever the port or the daemon actually said. THE SHELL DIES IN THE PLAN-017 TASK
// THAT MOUNTS THE BODY, in the same PR as the mount — which is the same obligation the
// reserved absence it replaced carried, because a shell is a shell whether it says the
// feature is unbuilt or answers the question.
//
// WHY A SHELL RATHER THAN THE ABSENCE. The absence was true of a build whose run read
// carried no prompt and no schema: a form composed out of nothing would have been
// answerable in appearance and unanswerable in fact. The run read carries both members
// now — declared on the growth slate, served by the fixture — so the honest rendering is
// the form, and leaving the notice up would have been this console reporting a gap it
// had closed.
//
// THE MOUNT CONTRACT IS `human-form-mount.ts`'S. It states what this pane owes a body
// and why each member is on it; the type lives beside this file rather than in it
// because the shell below is handed one and would otherwise import the wrapper that
// renders it.
//
// AND THIS FILE STILL DECIDES NO ELIGIBILITY. Whether the form may be submitted is the
// daemon's adjudication, arriving as a typed refusal wherever the press was made. A
// mount that predicted it would be a second authority on a question the daemon owns.
//
// WHY THE PHASE IS A WHOLE VALUE THAT MAY BE ABSENT, RATHER THAN THREE OPTIONALS. A pane
// mounts this region before it knows which phase is waiting, and the two states are "a
// phase is open" and "none is". Spread across optional members, every consumer would
// have to re-decide which of them discriminates, and the wrong answer (`formRevision`,
// which is legitimately `0`) is the one that reads as falsy. One member, present or
// absent, and the question is asked once here.

import { HumanFormShell } from "./HumanFormShell.js";
import type { HumanFormBody, HumanFormMount } from "./human-form-mount.js";
import { WorkflowSlotMount } from "../../../WorkflowSlotMount.js";
import { WORKFLOW_HUMAN_FORM_SLOT } from "../../../owner-slots.js";

export interface HumanFormSlotProps {
  /**
   * The open phase, or `undefined` while none is.
   *
   * Required-carrying-undefined rather than optional: a pane that has not resolved a
   * phase has to say so, and an absent key would read identically to one that simply
   * forgot to look.
   */
  readonly phase: HumanFormMount | undefined;
  /**
   * The owner's body, once there is one.
   *
   * Absent everywhere here, so the console's shell stands. A MODULE-LEVEL default and
   * never one composed in this render: a component built inline is a new type each
   * time, and React remounts it — losing whatever a person had typed into the form.
   */
  readonly body?: HumanFormBody;
}

/** The human phase's form, or the statement that no phase is waiting on a person. */
export function HumanFormSlot(props: HumanFormSlotProps): React.JSX.Element {
  const { phase, body } = props;
  return (
    <WorkflowSlotMount
      contract={WORKFLOW_HUMAN_FORM_SLOT}
      body={body ?? HumanFormShell}
      // No phase means no body, and never a body rendered against a placeholder: a form
      // composed against a phase nobody resolved would be answerable in appearance and
      // unsubmittable in fact. The mount reads the absence and renders the reserved
      // shell, so this slot states its rule and composes nothing.
      mount={phase}
      // The absence this arm renders is the RUN's state and not the console's: with a
      // form standing for every wait the run reports, the only way to reach it is a run
      // that parks nothing on anybody — or one whose park arrived without the handle
      // its form is answered through, which the park card says in its own words.
      title="No phase of this run is waiting on a person."
      detail="A phase parked on a person opens its prompt and its fields here."
    />
  );
}
