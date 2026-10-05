// The run's nodes and edges in the shapes the graph library reads. Each node carries its stated
// size, so the picture is complete on its first commit rather than waiting on a measurement, and
// each edge joins two nodes left to right. This module imports the library for values, so only
// the lazy canvas chunk reaches it.

import { MarkerType, Position, type Edge, type Node } from "@xyflow/react";

import type { WorkflowDocument } from "@ai-sidekicks/contracts/workflow/definition/definition";
import type { WorkflowEdgeItemCount } from "@ai-sidekicks/contracts/workflow/run/records";

import { RUN_GRAPH_NODE_WIDTH, runGraphNodeHeight, type CanvasPoint } from "./run-graph-layout.js";
import { itemCountWords } from "../../workflow-words.js";
import type { RunGraphNodeView } from "./run-graph-model.js";

/**
 * What a node carries into its own renderer.
 *
 * An alias, not an interface: the library constrains node data to `Record<string, unknown>` and
 * only an alias has the implicit index signature that satisfies it.
 */
export type RunGraphNodeData = {
  readonly view: RunGraphNodeView;
  /** The node's handle ids the document's edges name, inputs on the left, outputs on the right. */
  readonly handles: NodeHandleIds;
};

/** The handle ids on each side of one node, in the order they stand top to bottom. */
export interface NodeHandleIds {
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
}

/** The one node kind this graph draws; the string is the `nodeTypes` key. */
export const RUN_GRAPH_NODE_TYPE = "run-node" as const;

/** A placed node in the library's own shape. */
export type RunGraphFlowNode = Node<RunGraphNodeData, typeof RUN_GRAPH_NODE_TYPE>;

/**
 * The library's nodes for one run: every node at its place, carrying its state. Each node
 * states what the library would otherwise measure — its size and a handle for each id the
 * document's edges name, spread down its left and right sides — so a node rebuilt by a step
 * update is drawn whole on that commit and its edges never drop out while it is measured again.
 */
export function toRunGraphFlowNodes(
  views: readonly RunGraphNodeView[],
  handlesByNode: ReadonlyMap<string, NodeHandleIds>,
  positions: ReadonlyMap<string, CanvasPoint>,
  selectedNodeId: string | undefined,
): RunGraphFlowNode[] {
  return views.map((view) => {
    const height = runGraphNodeHeight(
      view.errorLine !== undefined || view.resumeLine !== undefined,
    );
    const handles = handlesByNode.get(view.node.id) ?? { inputs: [], outputs: [] };
    return {
      id: view.node.id,
      type: RUN_GRAPH_NODE_TYPE,
      position: positions.get(view.node.id) ?? { x: 0, y: 0 },
      width: RUN_GRAPH_NODE_WIDTH,
      height,
      measured: { width: RUN_GRAPH_NODE_WIDTH, height },
      handles: [
        ...handles.inputs.map((id, index) => ({
          id,
          type: "target" as const,
          position: Position.Left,
          x: 0,
          y: handleOffset(height, index, handles.inputs.length),
          width: 0,
          height: 0,
        })),
        ...handles.outputs.map((id, index) => ({
          id,
          type: "source" as const,
          position: Position.Right,
          x: RUN_GRAPH_NODE_WIDTH,
          y: handleOffset(height, index, handles.outputs.length),
          width: 0,
          height: 0,
        })),
      ],
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      selected: view.node.id === selectedNodeId,
      ariaLabel: view.accessibleName,
      data: { view, handles },
    };
  });
}

/**
 * Each node's handle ids, read from the edges that name them and kept in handle-id order, so a
 * node's `outputs/main/0` stands above its `outputs/main/1`.
 */
export function nodeHandleIds(document: WorkflowDocument): ReadonlyMap<string, NodeHandleIds> {
  const inputs = new Map<string, Set<string>>();
  const outputs = new Map<string, Set<string>>();
  for (const edge of document.edges) {
    inputs.set(edge.target, (inputs.get(edge.target) ?? new Set()).add(edge.targetHandle));
    outputs.set(edge.source, (outputs.get(edge.source) ?? new Set()).add(edge.sourceHandle));
  }
  const byNode = new Map<string, NodeHandleIds>();
  for (const node of [document.trigger, ...document.nodes]) {
    byNode.set(node.id, {
      inputs: [...(inputs.get(node.id) ?? [])].sort(byHandleIndex),
      outputs: [...(outputs.get(node.id) ?? [])].sort(byHandleIndex),
    });
  }
  return byNode;
}

/** Where the `index`th of `count` handles stands down a side `height` tall, evenly spaced. */
export function handleOffset(height: number, index: number, count: number): number {
  return (height * (index + 1)) / (count + 1);
}

/** A placed node's center, the point the view centers on when it follows or reveals it. */
export function runGraphNodeCenter(node: RunGraphFlowNode): CanvasPoint {
  return {
    x: node.position.x + (node.width ?? 0) / 2,
    y: node.position.y + (node.height ?? 0) / 2,
  };
}

/**
 * The library's edges for one run. Each joins the two handles the document names and carries
 * the count of items that went through it, summed over every pass; an edge nothing has gone
 * through yet carries `0 items`. An edge a run is flowing through is animated, and an edge into
 * or out of a disabled node is drawn struck through, as the node is grayed.
 */
export function toRunGraphFlowEdges(
  document: WorkflowDocument,
  itemCounts: readonly WorkflowEdgeItemCount[],
  flowingEdgeIds: ReadonlySet<string>,
): Edge[] {
  const countByEdge = new Map(itemCounts.map((entry) => [entry.edgeId, entry.itemCount]));
  const disabledNodeIds = new Set(
    [document.trigger, ...document.nodes]
      .filter((node) => node.disabled === true)
      .map((node) => node.id),
  );
  return document.edges.map((edge) => {
    const isFlowing = flowingEdgeIds.has(edge.id);
    const isDisabled = disabledNodeIds.has(edge.source) || disabledNodeIds.has(edge.target);
    const className = edgeClassName(isFlowing, isDisabled);
    return {
      id: edge.id,
      source: edge.source,
      sourceHandle: edge.sourceHandle,
      target: edge.target,
      targetHandle: edge.targetHandle,
      label: itemCountWords(countByEdge.get(edge.id) ?? 0),
      markerEnd: { type: MarkerType.ArrowClosed },
      animated: isFlowing,
      ...(className === undefined ? {} : { className }),
    };
  });
}

/** Handle ids in index order, so `outputs/main/2` stands above `outputs/main/10`. */
function byHandleIndex(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true });
}

/** The sheet's class for an edge's run state; an edge with neither state takes the default. */
function edgeClassName(isFlowing: boolean, isDisabled: boolean): string | undefined {
  if (isFlowing) {
    return "meridian-run-graph__edge--flowing";
  }
  return isDisabled ? "meridian-run-graph__edge--disabled" : undefined;
}
