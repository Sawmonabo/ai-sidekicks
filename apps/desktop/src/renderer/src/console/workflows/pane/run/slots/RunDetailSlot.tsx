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
// obligation made checkable, and it carries what this pane can honestly supply: the
// run's identifier, and the served run SNAPSHOT the pane is already holding beside
// this mount. The snapshot is optional and PRESENT EXACTLY ON THE SERVED ARM — the
// key's presence is which arm the pane was on, rather than a null the body would
// have to interpret, and a body handed one on a refused read would be shown a run
// the daemon never described. One member of the obligation is still absent, for a
// reason rather than by omission: the ledger's programmatic-scroll chokepoint, which
// arrives with the timeline family. It joins this type in the task that lands its
// producer; inventing it here would be this pane promising a value it does not have.
//
// THE FORM IS NOT OPENED FROM HERE. The human phase's form has a slot of its own,
// mounted beside this one by the same pane, because the form has to sit where the
// pane put it rather than nested inside a scrolled phase list — and because the
// builder's phase inspector mounts the same form somewhere else. A seam from this
// body to that one belongs on this type the day a body exists to use it; adding it
// now would be a callback with no caller on either end.

import type { WorkflowRunSnapshot } from "../../../../bridge/index.js";
import { WorkflowSlotMount } from "../../../WorkflowSlotMount.js";
import { WORKFLOW_RUN_DETAIL_SLOT } from "../../../owner-slots.js";

/** What the run pane hands the run-detail body. */
export interface RunDetailMount {
  /** The run being rendered. Opaque and wire-verbatim; the body never parses it. */
  readonly workflowRunId: string;
  /**
   * The run as the read answered, present exactly while one was served.
   *
   * Handed over rather than re-read: the pane puts the run read to render its parks
   * and its phase graph, so a body that issued its own would be a second read of one
   * question and two answers to it on one screen. Optional rather than
   * required-carrying-undefined, because unlike a session that a route may genuinely
   * not name, the absence here is one of three other read states the pane is already
   * rendering above this mount — so the key's presence says the read was served and
   * its absence sends the body to the surface that says which of the three it was.
   */
  readonly snapshot?: WorkflowRunSnapshot;
}

/**
 * The body Plan-017 authors: a COMPONENT this pane renders, never a function it
 * calls. `owner-slots.ts` states the reason once for all five slots.
 */
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
      seat={WORKFLOW_RUN_DETAIL_SLOT}
      body={body}
      mount={mount}
      title="The run detail is not built yet."
      detail="Phase sections, their retries, pool waits and completed outputs render here once the workflow engine's own view ships."
    />
  );
}
