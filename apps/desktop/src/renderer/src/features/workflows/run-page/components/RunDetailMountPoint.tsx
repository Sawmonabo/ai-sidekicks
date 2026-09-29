// The run detail's mount point: where a body that draws the run's phase sections, retry iterations,
// pool waits and completed outputs is mounted. It is a prop and this pane supplies none, so
// the mount point draws its empty frame.
//
// WHAT THE MOUNT CARRIES. `RunDetailMount` is what a body receives: the run's identifier,
// and the run snapshot the pane already holds beside this mount. The snapshot key is present
// exactly while the read is served, so its presence says which read state the pane is in
// rather than a null the body would have to interpret.
//
// THE FORM IS NOT OPENED FROM HERE. The human phase's form has a mount point of its own, mounted
// beside this one, and a body here is handed no seam to it.

import type { WorkflowRunSnapshot } from "@renderer/services/wire-shapes/workflow-projection.js";
import { EngineMountPoint } from "../../components/EngineMountPoint.js";

/** What the run pane hands the run-detail body. */
export interface RunDetailMount {
  /** The run being rendered. Opaque and wire-verbatim; the body never parses it. */
  readonly workflowRunId: string;
  /**
   * The run as the read answered, present exactly while one was served.
   *
   * Handed over rather than re-read: the pane puts the run read to render its parks and
   * its phase graph, so a body that issued its own would be a second read of one question
   * and two answers to it on one screen. Optional rather than required-carrying-undefined,
   * because the absence is one of the two other read states the pane is already rendering
   * above this mount, so the key's presence says the read was served.
   */
  readonly snapshot?: WorkflowRunSnapshot;
}

/**
 * The body the workflow engine authors: a COMPONENT this pane renders, never a function
 * it calls, because a call would put the body's hooks into the wrapper's hook list.
 */
export type RunDetailBody = (mount: RunDetailMount) => React.ReactNode;

/** What the run detail mount point is given: the mount a body receives, and the body itself. */
export interface RunDetailMountPointProps extends RunDetailMount {
  /**
   * The body, once there is one.
   *
   * Optional, and the pane passes none. A prop rather than a lookup, so a test can supply
   * a body and read back what the mount hands it.
   */
  readonly body?: RunDetailBody;
}

/** The run detail body over the mount, or an empty frame while the mount point has no body. */
export function RunDetailMountPoint(props: RunDetailMountPointProps): React.JSX.Element {
  const { body, ...mount } = props;
  return <EngineMountPoint body={body} mount={mount} />;
}
