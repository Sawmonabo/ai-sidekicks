// The node-graph canvas's slot — two node kinds, one edge kind, and the connection
// predicate that refuses a shape while it is being dragged rather than at save.
//
// OWNED BY PLAN-017. The canvas is the workflow engine's own authoring surface: the
// entry node plus the four phase classes, the gate on a phase's outgoing shoulder,
// the agent avatars and binding badge inside a node, the labelled back-reference,
// and the seven shapes a connection may never complete. This console frames that
// canvas; it does not draw one. THE SHELL DIES IN THE PLAN-017 TASK THAT MOUNTS THE
// BODY, in the same PR as the mount.
//
// THE RENDERING LIBRARY IS IN THE TREE, AND WHAT IT DRAWS HERE IS STILL NOT THIS
// CANVAS. The console's library ruling adopts a graph-rendering library under named
// constraints, and this family now uses it — for the RUN pane's read-only phase
// sequence, which is a picture of a run the console already reads and owns. The
// constraints that ruling attaches to the AUTHORING canvas are a different set and
// all of them are properties of the body that draws editable nodes: controlled mode
// over an edited definition, a connection-validity predicate evaluated during the
// drag, a keyboard connect mode, and durable layout. None of that is built here, and
// a chrome that built it would be authoring the body this slot exists to reserve.
// The library reaching the run pane changes nothing about that: it arrives on a lazy
// chunk that no initial bundle path imports, so the cost of the graph is paid by the
// surface that draws one.
//
// WHAT THE MOUNT OWES, AS A TYPE — and each member is something this pane knows and
// the body must not re-derive:
//
//   • **The definition** being authored, opaque and wire-verbatim.
//   • **The durable UI-state store**, which is where canvas geometry goes and the
//     only place it may go. Layout is client-local: dragging a node changes no
//     definition byte, mints no content hash and creates no version, so it is
//     written under the store's `layout` value class and never sent anywhere. The
//     store is handed over rather than wrapped because a geometry adapter would be
//     the body's own shape; what the chrome owes is that there is exactly ONE
//     durable home and the body did not have to invent a second.
//
// AND TWO THINGS THE MOUNT REFUSES TO OWE. The definition's own bytes, because no
// definition read is reachable from this build and a mount that carried them would
// be inventing the wire it exists to report the absence of; and the validity
// predicate, because which shapes are refused is the engine's rule — re-derived
// here it would be a second authority on a question the daemon re-evaluates at save
// and answers authoritatively.

import { WorkflowSlotMount } from "../../../WorkflowSlotMount.js";
import { WORKFLOW_GRAPH_SLOT } from "../../../owner-slots.js";
import type { UiStateStore } from "../../../../persistence/index.js";

/** What the builder pane hands the node-graph body. */
export interface NodeGraphMount {
  /** The definition being authored. Opaque and wire-verbatim; never parsed here. */
  readonly workflowDefinitionId: string;
  /**
   * The one durable home for canvas geometry, under the `layout` value class.
   *
   * Handed over whole rather than as a narrowed geometry port: narrowing would fix
   * a serialisation the body has not chosen yet, and the property that matters is
   * that there is one store and the body did not open a second.
   */
  readonly uiStateStore: UiStateStore;
}

/**
 * The body Plan-017 authors: a COMPONENT this pane renders, never a function it
 * calls. `owner-slots.ts` states the reason once for all five slots.
 */
export type NodeGraphBody = (mount: NodeGraphMount) => React.ReactNode;

export interface NodeGraphSlotProps extends NodeGraphMount {
  /**
   * The body, once there is one.
   *
   * Optional and absent everywhere in this repository: the pane mounts the slot
   * with no body, so the shell stands. It is a prop rather than a lookup so the
   * mount obligation above is provably delivered — this directory's own test
   * supplies a body and reads back exactly what the pane promised it.
   */
  readonly body?: NodeGraphBody;
}

/** The node graph, or the honest statement that it is reserved and unbuilt. */
export function NodeGraphSlot(props: NodeGraphSlotProps): React.JSX.Element {
  const { body: NodeGraphBodyComponent, ...mount } = props;
  return (
    <WorkflowSlotMount
      slot={{
        contract: WORKFLOW_GRAPH_SLOT.contract,
        body:
          NodeGraphBodyComponent === undefined ? undefined : <NodeGraphBodyComponent {...mount} />,
      }}
      title="The node graph is not built yet."
      detail="Phases, their gates and the sequence edges between them are drawn here once the workflow engine's own canvas ships."
    />
  );
}
