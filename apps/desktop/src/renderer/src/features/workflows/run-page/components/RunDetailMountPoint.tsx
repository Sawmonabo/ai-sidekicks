// The run detail's mount point: where a body that draws the run's phase sections, retry
// iterations, pool waits and completed outputs is mounted. The pane supplies no body, so the empty
// frame is drawn. The human form has its own mount point and a body here gets no seam to it.

import type { WorkflowRunSnapshot } from "@renderer/services/wire-shapes/workflow-projection.js";
import { EngineMountPoint } from "../../components/EngineMountPoint.js";

/** What the run pane hands the run-detail body. */
export interface RunDetailMount {
  /** The run being rendered. Opaque and wire-verbatim; the body never parses it. */
  readonly workflowRunId: string;
  /**
   * The run as the read answered, present exactly while one was served. Handed over rather than
   * re-read, so a body cannot issue a second read of one question; its presence says which read
   * state the pane is in.
   */
  readonly snapshot?: WorkflowRunSnapshot;
}

/**
 * The body the workflow engine authors. It is rendered as a component, never called, so its
 * hooks stay out of the wrapper's hook list.
 */
export type RunDetailBody = (mount: RunDetailMount) => React.ReactNode;

/** What the run detail mount point is given: the mount a body receives, and the body itself. */
export interface RunDetailMountPointProps extends RunDetailMount {
  /** The body, once there is one; the pane passes none. A prop so a test can supply one. */
  readonly body?: RunDetailBody;
}

/** The run detail body over the mount, or an empty frame while the mount point has no body. */
export function RunDetailMountPoint(props: RunDetailMountPointProps): React.JSX.Element {
  const { body, ...mount } = props;
  return <EngineMountPoint body={body} mount={mount} />;
}
