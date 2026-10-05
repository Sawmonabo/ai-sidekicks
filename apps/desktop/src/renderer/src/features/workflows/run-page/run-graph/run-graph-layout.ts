// Where each node stands on the run's canvas: the place the builder put it, read from the
// document's layout, or, when the document carries no place for some node, the whole graph laid
// out left to right. Every box carries a stated size, so the picture is complete on its first
// paint. This module imports the layout library, so only the lazy canvas chunk reaches it.

import { graphlib, layout } from "@dagrejs/dagre";

import type { WorkflowDocument } from "@ai-sidekicks/contracts/workflow/definition/definition";

/** A point on the canvas, in canvas units. */
export interface CanvasPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * One node's width, in canvas units: room for its name and its kind on one line each at the
 * default text size.
 */
export const RUN_GRAPH_NODE_WIDTH = 208;

/**
 * A node's height before any failure line, in canvas units: its name, kind and state lines at
 * the body line height, the gaps between them, its padding and its ring (80.5 at a 16px root).
 */
const RUN_GRAPH_NODE_HEIGHT = 84;

/**
 * How much a node grows to carry one more line and the gap above it: a failed node's error, or
 * the instant a waiting node resumes itself.
 */
const RUN_GRAPH_EXTRA_LINE_HEIGHT = 24;

/**
 * The gap between two nodes in the same column, in canvas units. Wider than the extra line, so
 * a node that grows downward never reaches the node below it.
 */
const RUN_GRAPH_NODE_GAP = 40;

/** The gap between two columns, in canvas units: room for an edge to read as a connection. */
const RUN_GRAPH_COLUMN_GAP = 72;

/**
 * Every node's top-left corner, keyed by node id, the trigger included. Positions depend on the
 * document alone, so a run moving from step to step never moves a node.
 */
export function placeRunGraphNodes(document: WorkflowDocument): ReadonlyMap<string, CanvasPoint> {
  const nodeIds = [document.trigger.id, ...document.nodes.map((node) => node.id)];
  const placed = document.layout?.nodes ?? {};
  const positions = new Map<string, CanvasPoint>();
  for (const nodeId of nodeIds) {
    const point = placed[nodeId];
    if (point === undefined) {
      return layOutLeftToRight(document, nodeIds);
    }
    positions.set(nodeId, { x: point.x, y: point.y });
  }
  return positions;
}

/** A node's height on the canvas: one more line when it carries a failure or a resume instant. */
export function runGraphNodeHeight(hasExtraLine: boolean): number {
  return hasExtraLine ? RUN_GRAPH_NODE_HEIGHT + RUN_GRAPH_EXTRA_LINE_HEIGHT : RUN_GRAPH_NODE_HEIGHT;
}

function layOutLeftToRight(
  document: WorkflowDocument,
  nodeIds: readonly string[],
): ReadonlyMap<string, CanvasPoint> {
  const graph = new graphlib.Graph();
  graph.setGraph({ rankdir: "LR", nodesep: RUN_GRAPH_NODE_GAP, ranksep: RUN_GRAPH_COLUMN_GAP });
  // The layout reads a label on every edge; these carry nothing of their own.
  graph.setDefaultEdgeLabel(() => ({}));
  for (const nodeId of nodeIds) {
    graph.setNode(nodeId, { width: RUN_GRAPH_NODE_WIDTH, height: RUN_GRAPH_NODE_HEIGHT });
  }
  for (const edge of document.edges) {
    graph.setEdge(edge.source, edge.target);
  }
  layout(graph);
  return new Map(
    nodeIds.map((nodeId) => {
      const laidOut = graph.node(nodeId);
      // The layout answers each node's center, always set once it has run; the canvas places a
      // node by its corner.
      return [
        nodeId,
        {
          x: (laidOut.x ?? 0) - RUN_GRAPH_NODE_WIDTH / 2,
          y: (laidOut.y ?? 0) - RUN_GRAPH_NODE_HEIGHT / 2,
        },
      ];
    }),
  );
}
