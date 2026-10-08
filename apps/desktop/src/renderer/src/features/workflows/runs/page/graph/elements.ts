// The run's nodes and edges in the shapes the graph library reads. Each node carries its stated
// size, so the picture is complete on its first commit rather than waiting on a measurement, and
// each edge joins two nodes left to right. This module imports the library for values, so only
// the lazy canvas chunk reaches it.

import { createElement } from "react";
import { MarkerType, Position, type Edge, type Node } from "@xyflow/react";

import type {
  WorkflowDocument,
  WorkflowNode,
} from "@ai-sidekicks/contracts/workflow/definition/document";
import {
  parseWorkflowHandle,
  type WorkflowHandleType,
} from "@ai-sidekicks/contracts/workflow/definition/handle";
import type { WorkflowEdgeItemCount } from "@ai-sidekicks/contracts/workflow/run/records";

import type { CanvasPoint } from "./layout.js";
import {
  deriveNodeBoxSize,
  type NodeBoxSize,
} from "#renderer/features/workflows/canvas/node-box.js";
import { HoverLabel } from "#renderer/components/HoverLabel/HoverLabel.js";
import { formatCompactCount } from "#renderer/lib/wire/figures.js";
import { itemCountWords, nodeKindWords } from "#renderer/features/workflows/words.js";
import { EDGE_LABEL_PADDING } from "#renderer/features/workflows/canvas/column-gap.js";
import type { RunGraphNodeView } from "./node-views.js";

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

/** A node no edge touches, with no handle on either side. */
export const NO_HANDLES: NodeHandleIds = { inputs: [], outputs: [] };

/** The one node kind this graph draws; the string is the `nodeTypes` key. */
export const RUN_GRAPH_NODE_TYPE = "run-node" as const;

/** The class on an edge's item count, the element the keyboard focuses to read the whole count. */
export const EDGE_COUNT_CLASS = "meridian-run-graph__edge-count";

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
  countFigure: string,
): RunGraphFlowNode[] {
  return views.map((view) => {
    const handles = handlesByNode.get(view.node.id) ?? NO_HANDLES;
    const { width, height } = runGraphNodeBox(
      view.node,
      handles,
      countFigure,
      view.errorLine !== undefined || view.resumeFigure !== undefined,
    );
    return {
      id: view.node.id,
      type: RUN_GRAPH_NODE_TYPE,
      position: positions.get(view.node.id) ?? { x: 0, y: 0 },
      width,
      height,
      measured: { width, height },
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
          x: width,
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
      inputs: [...(inputs.get(node.id) ?? [])].sort(byHandle),
      outputs: [...(outputs.get(node.id) ?? [])].sort(byHandle),
    });
  }
  return byNode;
}

/**
 * The box one node takes on this run's canvas: its kind's words and the run's widest count
 * across, its busier side's handles down, and one line more for a failure or a resume instant.
 * Every node of one kind comes out the same width.
 */
export function runGraphNodeBox(
  node: WorkflowNode,
  handles: NodeHandleIds,
  countFigure: string,
  hasExtraLine: boolean,
): NodeBoxSize {
  return deriveNodeBoxSize({
    kindWords: nodeKindWords(node.kind),
    countFigure,
    handleCount: Math.max(handles.inputs.length, handles.outputs.length),
    hasExtraLine,
  });
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
 * the count of items that went through it, summed over every pass, as a short mono figure whose
 * hover label is the whole count; an edge nothing has gone through yet carries `0`. An edge a run
 * is flowing through is animated, and an edge into or out of a disabled node is drawn struck
 * through, as the node is grayed.
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
      label: edgeCountLabel(countByEdge.get(edge.id) ?? 0),
      labelBgPadding: [EDGE_LABEL_PADDING[0], EDGE_LABEL_PADDING[1]],
      markerEnd: { type: MarkerType.ArrowClosed },
      animated: isFlowing,
      ...(className === undefined ? {} : { className }),
    };
  });
}

// Where each handle type stands down a side: the item ports above the port an agent calls tools on.
const HANDLE_TYPE_RANK: Readonly<Record<WorkflowHandleType, number>> = { main: 0, tool: 1 };

/**
 * Handle ids by type, `main` above `tool`, then in index order, so `outputs/main/2` stands above
 * `outputs/main/10`; ids the parse reads alike keep the order of their spelling.
 */
function byHandle(left: string, right: string): number {
  const leftHandle = parseWorkflowHandle(left);
  const rightHandle = parseWorkflowHandle(right);
  return (
    HANDLE_TYPE_RANK[leftHandle.type] - HANDLE_TYPE_RANK[rightHandle.type] ||
    leftHandle.index - rightHandle.index ||
    left.localeCompare(right)
  );
}

/** The sheet's class for an edge's run state; an edge with neither state takes the default. */
function edgeClassName(isFlowing: boolean, isDisabled: boolean): string | undefined {
  if (isFlowing) {
    return "meridian-run-graph__edge--flowing";
  }
  return isDisabled ? "meridian-run-graph__edge--disabled" : undefined;
}

// The short count on the edge, with the whole count in its hover label, which a pointer or the
// keyboard shows and a screen reader names the count by. The canvas's Tab order reaches it after
// the node its edge leaves, so the keyboard reads the whole count as the pointer does. It takes
// the image role, so a screen reader reads its name, the whole count, in place of the short one.
function edgeCountLabel(count: number): React.ReactNode {
  return createElement(HoverLabel, {
    text: itemCountWords(count),
    textIs: "name",
    children: createElement(
      "tspan",
      { className: EDGE_COUNT_CLASS, tabIndex: -1, role: "img" },
      formatCompactCount(count),
    ),
  });
}
