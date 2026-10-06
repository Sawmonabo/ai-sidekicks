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
 * The canvas's measures in canvas units, which are CSS pixels at zoom 1. Each is stated in rem
 * and turned into pixels at the window's root font size, so a node's box grows with the text it
 * holds when the person raises the text size.
 */
export interface RunGraphMetrics {
  /** One node's width: room for its name and its kind on one line each. */
  readonly nodeWidth: number;
  /** A node's height before any failure line. */
  readonly nodeHeight: number;
  /** How much a node grows to carry a failed node's error or a waiting node's resume instant. */
  readonly extraLineHeight: number;
  /** The gap between two nodes in the same column. */
  readonly nodeGap: number;
  /** The gap between two columns: room for an edge to read as a connection. */
  readonly columnGap: number;
}

/** One node's width, in rem: its name and its kind on one line each. */
const NODE_WIDTH_REM = 13;

/**
 * A node's height before any failure line, in rem: its name, kind and state lines at the body
 * line height, the gaps between them, its padding and its ring.
 */
const NODE_HEIGHT_REM = 5.25;

/** One more line and the gap above it, in rem. */
const EXTRA_LINE_HEIGHT_REM = 1.5;

/**
 * The gap between two nodes in a column, in rem. Wider than the extra line, so a node that grows
 * downward never reaches the node below it.
 */
const NODE_GAP_REM = 2.5;

/** The gap between two columns, in rem. */
const COLUMN_GAP_REM = 4.5;

/** The canvas's measures at a root font size of `rootFontSizePx` CSS pixels. */
export function runGraphMetrics(rootFontSizePx: number): RunGraphMetrics {
  return {
    nodeWidth: NODE_WIDTH_REM * rootFontSizePx,
    nodeHeight: NODE_HEIGHT_REM * rootFontSizePx,
    extraLineHeight: EXTRA_LINE_HEIGHT_REM * rootFontSizePx,
    nodeGap: NODE_GAP_REM * rootFontSizePx,
    columnGap: COLUMN_GAP_REM * rootFontSizePx,
  };
}

/**
 * Every node's top-left corner, keyed by node id, the trigger included. Positions depend on the
 * document and the measures alone, so a run moving from step to step never moves a node.
 */
export function placeRunGraphNodes(
  document: WorkflowDocument,
  metrics: RunGraphMetrics,
): ReadonlyMap<string, CanvasPoint> {
  const nodeIds = [document.trigger.id, ...document.nodes.map((node) => node.id)];
  const placed = document.layout?.nodes ?? {};
  const positions = new Map<string, CanvasPoint>();
  for (const nodeId of nodeIds) {
    const point = placed[nodeId];
    if (point === undefined) {
      return layOutLeftToRight(document, nodeIds, metrics);
    }
    positions.set(nodeId, { x: point.x, y: point.y });
  }
  return positions;
}

/** A node's height on the canvas: one more line when it carries a failure or a resume instant. */
export function runGraphNodeHeight(metrics: RunGraphMetrics, hasExtraLine: boolean): number {
  return hasExtraLine ? metrics.nodeHeight + metrics.extraLineHeight : metrics.nodeHeight;
}

function layOutLeftToRight(
  document: WorkflowDocument,
  nodeIds: readonly string[],
  metrics: RunGraphMetrics,
): ReadonlyMap<string, CanvasPoint> {
  const { nodeWidth, nodeHeight } = metrics;
  const graph = new graphlib.Graph();
  graph.setGraph({ rankdir: "LR", nodesep: metrics.nodeGap, ranksep: metrics.columnGap });
  // The layout reads a label on every edge; these carry nothing of their own.
  graph.setDefaultEdgeLabel(() => ({}));
  for (const nodeId of nodeIds) {
    graph.setNode(nodeId, { width: nodeWidth, height: nodeHeight });
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
          x: (laidOut.x ?? 0) - nodeWidth / 2,
          y: (laidOut.y ?? 0) - nodeHeight / 2,
        },
      ];
    }),
  );
}
