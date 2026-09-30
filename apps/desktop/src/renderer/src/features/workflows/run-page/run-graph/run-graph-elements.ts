// The layout, in the shapes the graph renderer reads: a placed phase becomes a node and a
// sequence edge becomes an edge, one direction only. Each box carries its own dimensions so it
// is complete on the first commit rather than waiting on a `ResizeObserver`. This module imports
// the library for values, so it is reachable only from the lazy `RunGraphCanvas.tsx`.

import { MarkerType, Position, type Edge, type Node } from "@xyflow/react";

import {
  PHASE_NODE_HEIGHT_PX,
  PHASE_NODE_WIDTH_PX,
  type DrawnPhaseSequence,
} from "./phase-sequence-layout.js";
import {
  PHASE_PARK_ATTENTION_MARKS,
  phaseDisplayText,
  type RunGraphNode,
  type PhaseSequenceEdge,
} from "./phase-topology.js";

/**
 * What a node carries into its own renderer.
 *
 * An alias, not an interface: the library constrains node data to `Record<string, unknown>`
 * and only an alias has the implicit index signature that satisfies it.
 */
export type PhaseNodeData = { readonly phase: RunGraphNode };

/**
 * The one node kind this graph draws. The string is the `nodeTypes` key.
 *
 * A const assertion, since a widened `string` would stop the compiler pairing each node
 * with its renderer.
 */
export const PHASE_NODE_TYPE = "phase" as const;

/** A placed phase in the renderer's own shape. */
export type PhaseFlowNode = Node<PhaseNodeData, typeof PHASE_NODE_TYPE>;

/** A sequence edge in the renderer's own shape. */
export type PhaseFlowEdge = Edge;

/**
 * Everything the canvas hands the renderer, derived once per layout.
 *
 * The arrays are mutable because the library's props are: a per-render copy would change
 * identity and make the renderer re-enter its store. Nothing here mutates them.
 */
export interface RunGraphElements {
  readonly nodes: PhaseFlowNode[];
  readonly edges: PhaseFlowEdge[];
}

/**
 * What assistive technology is told about one phase.
 *
 * The phase's name, what it is doing, its gate, and, only while parked, what the park is
 * waiting for. Park comes from `parkAttention`, never from state, and the wording is the
 * table the box prints.
 */
export function phaseNodeAccessibleName(phase: RunGraphNode): string {
  const parts = [`${phaseDisplayText(phase)}: ${phase.state}`, `gate ${phase.gateState}`];
  if (phase.parkAttention !== undefined) {
    parts.push(PHASE_PARK_ATTENTION_MARKS[phase.parkAttention]);
  }
  return parts.join(", ");
}

/**
 * What assistive technology is told about one sequence edge.
 *
 * The library's default names an edge by its two opaque node ids; this names where it leads.
 */
export function sequenceEdgeAccessibleName(edge: PhaseSequenceEdge): string {
  return `then ${edge.targetLabel}`;
}

/** The renderer's arrays for one drawn sequence. Pure; the memo is the hook's job. */
export function toRunGraphElements(layout: DrawnPhaseSequence): RunGraphElements {
  const nodes: PhaseFlowNode[] = layout.nodes.map((placed) => ({
    id: placed.phase.phaseId,
    type: PHASE_NODE_TYPE,
    position: { x: placed.x, y: placed.y },
    // Stated rather than measured, so the picture is complete on the first commit.
    width: PHASE_NODE_WIDTH_PX,
    height: PHASE_NODE_HEIGHT_PX,
    sourcePosition: Position.Bottom,
    targetPosition: Position.Top,
    ariaLabel: phaseNodeAccessibleName(placed.phase),
    data: { phase: placed.phase },
  }));

  const edges: PhaseFlowEdge[] = layout.edges.map((edge) => ({
    id: edge.edgeId,
    source: edge.sourcePhaseId,
    target: edge.targetPhaseId,
    // Straight, because the sequence is a single column.
    type: "straight",
    ariaLabel: sequenceEdgeAccessibleName(edge),
    markerEnd: { type: MarkerType.ArrowClosed },
  }));

  return { nodes, edges };
}
