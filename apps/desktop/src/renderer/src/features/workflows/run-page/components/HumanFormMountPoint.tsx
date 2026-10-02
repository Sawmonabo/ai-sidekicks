// The human phase's form mount point: the prompt, the schema-derived controls, and the submission
// that carries the revision they were composed against. The default body is
// `default-human-form-body.ts`; `body` replaces it. The body is mounted inside
// `HumanFormSubmitBinding`, so it arrives with one bound submit. `HumanFormSubmitBinding` is
// referenced at module level because a component composed per render remounts. Eligibility is
// the daemon's to decide, never predicted here. The mount contract is `human-form-mount.ts`.

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
   * The open phase, or `undefined` while none is. Required rather than optional so a pane that
   * has not resolved a phase says so.
   */
  readonly phase: HumanFormPhase | undefined;
  /**
   * A body to stand in place of the console's default body. Pass a stable reference: a
   * component built inline is a new type each render, and React remounts it, losing what a
   * person typed.
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
      // No phase means no binding and no body: a form composed against an unresolved phase
      // would look answerable and be unsubmittable.
      mount={phase === undefined ? undefined : { phase, body, submitForm }}
    />
  );
}
