// The human phase's form mount point — where the prompt, the schema-derived controls, and the
// submission that carries the revision they were composed against are mounted.
//
// THE FORM STANDING HERE IS THE CONSOLE'S DEFAULT BODY (`default-human-form-body.ts`): a
// real form over the schema the run read carried. The `body` prop replaces it with a
// supplied body.
//
// THE BODY IS MOUNTED INSIDE THE SUBMIT CHANNEL AND NOT DIRECTLY IN THE MOUNT POINT. The mount
// this mount point hands over is therefore the channel's pair — the resolved phase and whichever
// body is to stand in it — and the channel composes the body's mount from the phase plus
// the `submit` it holds. That indirection is the whole of what the pane promises a body: the submit
// call, the single-flight guard, the captured revision, the re-armed run read and the
// settlement rendering stay with the pane, and a body arrives with one act already bound.
// `HumanFormSubmitBinding` is a MODULE-LEVEL reference, because a component composed on
// each render is a new type each time and React remounts it.
//
// THE MOUNT CONTRACT IS `human-form-mount.ts`'S. It states what this pane owes a body and
// why each member is on it; the types live beside this file rather than in it because the
// default body is handed one and would otherwise import the wrapper that renders it.
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

import { HumanFormSubmitBinding } from "./HumanFormSubmitBinding.js";
import type { WorkflowHumanFormSubmitCall } from "../human-form-submit.js";
import type { HumanFormBody, HumanFormPhase } from "../human-form-mount.js";
import { EngineMountPoint } from "../../components/EngineMountPoint.js";

/**
 * What the human-form mount point is given: the open phase, an optional replacement body, and the
 * call that submits.
 */
export interface HumanFormMountPointProps {
  /**
   * The open phase, or `undefined` while none is.
   *
   * Required-carrying-undefined rather than optional: a pane that has not resolved a
   * phase has to say so, and an absent key would read identically to one that simply
   * forgot to look.
   */
  readonly phase: HumanFormPhase | undefined;
  /**
   * A body to stand in place of the console's default body.
   *
   * A stable reference and never one composed in this render: a component built inline is
   * a new type each time, and React remounts it — losing whatever a person had typed into
   * the form.
   */
  readonly body?: HumanFormBody;
  /**
   * The call that submits the open phase's form.
   *
   * Pass a stable function: a new identity starts the open attempt over.
   */
  readonly submitForm: WorkflowHumanFormSubmitCall;
}

/** The human phase's form, or an empty frame where no phase is waiting on a person. */
export function HumanFormMountPoint(props: HumanFormMountPointProps): React.JSX.Element {
  const { phase, body, submitForm } = props;
  return (
    <EngineMountPoint
      body={HumanFormSubmitBinding}
      // No phase means no channel and no body, and never a body rendered against a
      // placeholder: a form composed against a phase nobody resolved would be answerable
      // in appearance and unsubmittable in fact. The mount reads the absence and renders
      // the empty frame, so this mount point states its rule and composes nothing.
      mount={phase === undefined ? undefined : { phase, body, submitForm }}
    />
  );
}
