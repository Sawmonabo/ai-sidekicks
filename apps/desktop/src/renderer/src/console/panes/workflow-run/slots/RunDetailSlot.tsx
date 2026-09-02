// The run detail's slot — phase sections, retry iterations, pool waits, outputs.
//
// OWNED BY PLAN-017. This console frames a run; it does not render one. The body
// that renders phase sections, their retry sub-entries keyed on the phase-run and
// attempt number, the pool-wait readings and the completed outputs is the workflow
// engine's own, and authoring one here would be a second implementation of a
// surface another plan owns.
//
// THE SHELL DIES IN THE PLAN-017 TASK THAT MOUNTS THE BODY, in the same PR as the
// mount — not when the body is written, and not by being left beside it. The
// contract that says so travels on the family's `owner-slots.ts` value and is
// carried here rather than displayed: it names governance work, and no console
// surface renders one.
//
// WHAT THE MOUNT OWES TODAY, AND WHAT IT CANNOT YET. `RunDetailMount` is the mount
// obligation made checkable, and it carries exactly what this pane can honestly
// supply: the run's identifier, and the pane-local call that opens a phase's form
// in the pane's own layout. Two further members belong on it and are absent for a
// reason rather than by omission — the run SNAPSHOT, which needs a run read no
// bridge namespace serves, and the ledger's programmatic-scroll chokepoint, which
// arrives with the timeline family. Each joins this type in the task that lands its
// producer; inventing either here would be this pane promising a value it does not
// have.
//
// THE FORM IS NOT OPENED FROM HERE. The human phase's form has a slot of its own,
// mounted beside this one by the same pane, because the form has to sit where the
// pane put it rather than nested inside a scrolled phase list — and because the
// builder's phase inspector mounts the same form somewhere else. A seam from this
// body to that one belongs on this type the day a body exists to use it; adding it
// now would be a callback with no caller on either end.

import { WorkflowSlotMount } from "../../../workflows/WorkflowSlotMount.js";
import { WORKFLOW_RUN_DETAIL_SLOT } from "../../../workflows/owner-slots.js";

/** What the run pane hands the run-detail body. */
export interface RunDetailMount {
  /** The run being rendered. Opaque and wire-verbatim; the body never parses it. */
  readonly workflowRunId: string;
}

/** The body Plan-017 authors, and the signature this pane will call it with. */
export type RunDetailBody = (mount: RunDetailMount) => React.ReactNode;

export interface RunDetailSlotProps extends RunDetailMount {
  /**
   * The body, once there is one.
   *
   * Optional and absent everywhere in this repository: the pane mounts the slot
   * with no body, so the shell stands. It is a prop rather than a lookup so the
   * mount obligation above is provably delivered — this file's own test supplies a
   * body and reads back exactly what the pane promised it.
   */
  readonly body?: RunDetailBody;
}

/** The run detail, or the honest statement that it is reserved and unbuilt. */
export function RunDetailSlot(props: RunDetailSlotProps): React.JSX.Element {
  const { body, ...mount } = props;
  return (
    <WorkflowSlotMount
      slot={{ contract: WORKFLOW_RUN_DETAIL_SLOT.contract, body: body?.(mount) }}
      title="The run detail is not built yet."
      detail="Phase sections, their retries, pool waits and completed outputs render here once the workflow engine's own view ships."
    />
  );
}
