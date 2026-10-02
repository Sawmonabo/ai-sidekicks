// The node-graph canvas's mount point. The canvas is the workflow engine's own editor, with the
// connection predicate that refuses a shape while it is dragged; the console frames it and
// does not draw one. The predicate is the engine's rule, which the daemon re-evaluates at save,
// so this mount carries neither it nor the definition's bytes.

import { EngineMountPoint } from "../../components/EngineMountPoint.js";
import type { UiStateStore } from "@renderer/store/persistence/ui-state-store.js";

/** What the builder pane hands the node-graph body. */
export interface NodeGraphMount {
  /** The definition being authored. Opaque and wire-verbatim; never parsed here. */
  readonly definitionId: string;
  /**
   * The one durable home for canvas geometry, under the `layout` value class. Layout is
   * client-local: dragging a node changes no definition byte, so it is never sent anywhere.
   * Handed over whole so the body chooses its own serialization.
   */
  readonly uiStateStore: UiStateStore;
}

/**
 * A component this pane renders, never a function it calls: a call would put the body's hooks
 * into the wrapper's hook list.
 */
export type NodeGraphBody = (mount: NodeGraphMount) => React.ReactNode;

/** The node-graph mount plus the body, once there is one. */
export interface NodeGraphMountPointProps extends NodeGraphMount {
  /** The body; while it is absent the empty frame stands. */
  readonly body?: NodeGraphBody;
}

/** The node graph's frame: the engine's canvas once its body is supplied, empty until then. */
export function NodeGraphMountPoint(props: NodeGraphMountPointProps): React.JSX.Element {
  const { body, ...mount } = props;
  return <EngineMountPoint body={body} mount={mount} />;
}
