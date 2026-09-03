// The layout, in the shapes the graph renderer reads.
//
// One direction of translation and one only: a placed phase becomes a node, a
// sequence edge becomes an edge, and nothing travels back. The renderer is driven
// fully controlled — it is handed arrays and never asked to hold state of its own —
// so this module is the whole of what it knows about a run.
//
// WHY THE BOXES CARRY THEIR OWN DIMENSIONS. A node whose size the renderer has to
// measure is invisible until a `ResizeObserver` reports it, and its position then
// depends on the host's installed faces. Both are decided here instead, from the
// layout's own constants, so the picture is complete on the first commit and
// identical on every machine.
//
// WHY THIS MODULE SITS IN THE LAZY CHUNK. It imports the library for values —
// `MarkerType`, `Position` — and so is reachable only from `PhaseGraphCanvas.tsx`,
// which is itself reached only through this directory's `index.ts`, the door
// `phase-graph-loader.ts`'s `import()` names. The layout module beside it imports
// nothing from the library at all, which is what lets the host decide whether a graph
// can be drawn before any of these bytes are fetched.
//
// THE ACCESSIBLE NAME IS NOT A SECOND VOCABULARY. It is built from the same five
// members the node paints, in the same words, so a reader listening and a reader
// looking are told the same thing about the same phase.

import { useMemo } from "react";
import { MarkerType, Position, type Edge, type Node } from "@xyflow/react";

import {
  PHASE_NODE_HEIGHT_PX,
  PHASE_NODE_WIDTH_PX,
  type DrawnPhaseSequence,
} from "./phase-sequence-layout.js";
import {
  PHASE_PARK_ATTENTION_MARKS,
  phaseDisplayText,
  type PhaseGraphNode,
  type PhaseSequenceEdge,
} from "./phase-topology.js";

/**
 * What a node carries into its own renderer.
 *
 * A type alias rather than an interface, deliberately: the library constrains node
 * data to `Record<string, unknown>` and only an alias picks up the implicit index
 * signature that satisfies it.
 */
export type PhaseNodeData = { readonly phase: PhaseGraphNode };

/**
 * The one node kind this surface draws. The string is the `nodeTypes` key.
 *
 * A const assertion rather than a widening annotation: the renderer's node type is
 * generic over this string, so a `string` type would widen every node this file
 * builds into "some node kind" and stop the compiler pairing it with its renderer.
 */
export const PHASE_NODE_TYPE = "phase" as const;

/** A placed phase in the renderer's own shape. */
export type PhaseFlowNode = Node<PhaseNodeData, typeof PHASE_NODE_TYPE>;

/** A sequence edge in the renderer's own shape. */
export type PhaseFlowEdge = Edge;

/**
 * Everything the canvas hands the renderer, derived once per layout.
 *
 * The members are `readonly` and the ARRAYS are not, deliberately: the library's
 * props are mutable array types, so a `readonly` array would have to be copied at
 * the call site — and a copy per render is a new identity per render, which is
 * precisely the store re-entry the memo below exists to prevent. Nothing in this
 * directory mutates either array; the canvas passes each straight through.
 */
export interface PhaseGraphElements {
  readonly nodes: PhaseFlowNode[];
  readonly edges: PhaseFlowEdge[];
}

/**
 * What assistive technology is told about one phase.
 *
 * Sentence-shaped and calm: the phase's own name, then what it is doing, then
 * whether its gate is open, then — only where there is one right now — what its park
 * is waiting for. Nothing is inferred from anything else: a parked phase is parked
 * because the caller said so, never because its state looked like waiting, and
 * whether that park needs a person is the caller's reading rather than a second one
 * made here.
 *
 * The words that open it come from `phaseDisplayText`, which is also what an edge
 * carries: a sentence has no mono face to lend a wire identifier, so the fallback is
 * chosen in one place rather than here and there. A reader listening is told the
 * identifier where the box shows the identifier, and never a different string.
 *
 * The park's words come from the same table the box prints, so a reader listening is
 * told a scheduled park is scheduled — which is the whole of what the neutral
 * treatment says to a reader looking at it.
 */
export function phaseNodeAccessibleName(phase: PhaseGraphNode): string {
  const parts = [`${phaseDisplayText(phase)}: ${phase.state}`, `gate ${phase.gateState}`];
  if (phase.parkAttention !== undefined) {
    parts.push(PHASE_PARK_ATTENTION_MARKS[phase.parkAttention]);
  }
  return parts.join(", ");
}

/**
 * What assistive technology is told about one sequence edge.
 *
 * The library's own default names an edge by its two node ids, which are opaque
 * wire identifiers a person never chose; this names where the edge leads in the
 * words the run uses.
 */
export function sequenceEdgeAccessibleName(edge: PhaseSequenceEdge): string {
  return `then ${edge.targetLabel}`;
}

/** The renderer's arrays for one drawn sequence. Pure; the memo is the hook's job. */
export function toPhaseGraphElements(layout: DrawnPhaseSequence): PhaseGraphElements {
  const nodes: PhaseFlowNode[] = layout.nodes.map((placed) => ({
    id: placed.phase.phaseId,
    type: PHASE_NODE_TYPE,
    position: { x: placed.x, y: placed.y },
    // Stated rather than measured — see the header.
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
    // Straight, because the sequence is a single column: a routed connector would
    // draw a detour around an obstacle this layout never puts in the way.
    type: "straight",
    ariaLabel: sequenceEdgeAccessibleName(edge),
    markerEnd: { type: MarkerType.ArrowClosed },
  }));

  return { nodes, edges };
}

/**
 * The renderer's arrays, rebuilt only when the layout moves.
 *
 * A hook rather than a call in a render body, per `apps/desktop/AGENTS.md`, and the
 * dependency is exact: the layout object upstream is already reference-stable across
 * renders that describe one run, so this memo recomputes precisely when the picture
 * changes and never otherwise. That matters because the renderer re-enters its own
 * store whenever the node or edge array identity moves.
 */
export function usePhaseGraphElements(layout: DrawnPhaseSequence): PhaseGraphElements {
  return useMemo(() => toPhaseGraphElements(layout), [layout]);
}
