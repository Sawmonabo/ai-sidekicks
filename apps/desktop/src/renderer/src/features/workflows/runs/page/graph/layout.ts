// Where each node stands on the run's canvas: the place the builder put it, read from the
// document's layout, or, when the document carries no place for some node, the whole graph laid
// out left to right around each node's derived box. Every box carries a stated size, so the
// picture is complete on its first paint. This module imports the layout library, so only the
// lazy canvas chunk reaches it.

import { graphlib, layout } from "@dagrejs/dagre";

import type {
  WorkflowDocument,
  WorkflowNode,
} from "@ai-sidekicks/contracts/workflow/definition/definition";

import {
  NODE_EXTRA_LINE_HEIGHT,
  type NodeBoxSize,
} from "#renderer/features/workflows/canvas/node-box.js";

/** A point on the canvas, in canvas units. */
export interface CanvasPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * The gap between two nodes in the same column, in canvas units: twice the line a box grows by,
 * so a node that grows downward never reaches the node below it.
 */
const RUN_GRAPH_NODE_GAP = 2 * NODE_EXTRA_LINE_HEIGHT;

/**
 * Every node's top-left corner, keyed by node id, the trigger included. Positions depend on the
 * document, each node's box before any extra line, `boxOf`, and the gap between two columns, in
 * canvas units, so a run moving from step to step moves a node only when the widest count it
 * reports on a node or an edge gains a digit.
 */
export function placeRunGraphNodes(
  document: WorkflowDocument,
  boxOf: (node: WorkflowNode) => NodeBoxSize,
  columnGap: number,
): ReadonlyMap<string, CanvasPoint> {
  const nodes = [document.trigger, ...document.nodes];
  const placed = document.layout?.nodes ?? {};
  const positions = new Map<string, CanvasPoint>();
  for (const node of nodes) {
    const point = placed[node.id];
    if (point === undefined) {
      return layOutLeftToRight(document, nodes, boxOf, columnGap);
    }
    positions.set(node.id, { x: point.x, y: point.y });
  }
  return positions;
}

function layOutLeftToRight(
  document: WorkflowDocument,
  nodes: readonly WorkflowNode[],
  boxOf: (node: WorkflowNode) => NodeBoxSize,
  columnGap: number,
): ReadonlyMap<string, CanvasPoint> {
  const boxes = new Map(nodes.map((node) => [node.id, boxOf(node)]));
  const graph = new graphlib.Graph();
  graph.setGraph({ rankdir: "LR", nodesep: RUN_GRAPH_NODE_GAP, ranksep: columnGap });
  // The layout reads a label on every edge; these carry nothing of their own.
  graph.setDefaultEdgeLabel(() => ({}));
  for (const [nodeId, box] of boxes) {
    graph.setNode(nodeId, { width: box.width, height: box.height });
  }
  for (const edge of document.edges) {
    graph.setEdge(edge.source, edge.target);
  }
  layout(graph);
  return new Map(
    [...boxes].map(([nodeId, box]) => {
      const laidOut = graph.node(nodeId);
      // The layout answers each node's center, always set once it has run; the canvas places a
      // node by its corner.
      return [
        nodeId,
        { x: (laidOut.x ?? 0) - box.width / 2, y: (laidOut.y ?? 0) - box.height / 2 },
      ];
    }),
  );
}
