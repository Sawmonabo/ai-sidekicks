// Where a run's phases sit on the canvas, and the vocabulary the caller hands in. The layout is
// a pure function of the phase order (no measurement, clock or iteration), so two processes
// given one sequence produce identical positions. Edges come from `phase-topology.ts`; nothing
// here imports the graph library, because this module is on the initial bundle path.

import {
  declaredEdges,
  type RunGraphNode,
  type PhaseSequenceEdge,
  type PhaseTopology,
  type PhaseTopologyAbsence,
} from "./phase-topology.js";

/**
 * The node box, in CSS pixels at the 16 px root.
 *
 * Fixed rather than measured, so two machines showing one run agree on every position. 208 px
 * is 13rem: the name sets on one line at `--meridian-text-sm`, the mono id under it at `-xs`.
 */
export const PHASE_NODE_WIDTH_PX: number = 208;

/** The node box's block size: 4rem at the 16 px root — three text lines at this measure. */
export const PHASE_NODE_HEIGHT_PX: number = 64;

/**
 * The gap between one rank's box and the next: `--meridian-space-8`, 48 px at the 16 px root.
 *
 * Module-private: the pitch below is the one number every position is a multiple of.
 */
const PHASE_RANK_SPACING_PX = 48;

/** Rank to rank, box included. The one number every position is a multiple of. */
export const PHASE_RANK_PITCH_PX: number = PHASE_NODE_HEIGHT_PX + PHASE_RANK_SPACING_PX;

/** A phase placed on the canvas. Position is in the flow's own coordinate space. */
export interface PositionedPhaseNode {
  readonly phase: RunGraphNode;
  /** The phase's position in the run's order. */
  readonly rank: number;
  readonly x: number;
  readonly y: number;
}

/** A sequence that can be drawn, with every phase placed and every edge derived. */
export interface DrawnPhaseSequence {
  readonly status: "drawn";
  readonly nodes: readonly PositionedPhaseNode[];
  readonly edges: readonly PhaseSequenceEdge[];
  /**
   * Absent exactly when the edges above are the definition's own.
   *
   * Present means there are none and names why, so the caller can say the picture is a set of
   * states rather than a graph, not a workflow with no dependencies.
   */
  readonly topologyAbsence?: PhaseTopologyAbsence;
}

/**
 * A sequence that cannot be drawn without losing a phase.
 *
 * Node identity is the phase id, so a repeated id would silently replace a phase. The ids are
 * carried so the refusal can say which repeated.
 */
export interface MalformedPhaseSequence {
  readonly status: "malformed";
  readonly repeatedPhaseIds: readonly string[];
}

/** A sequence that is drawn, or refused because a phase id repeats. */
export type PhaseSequenceLayout = DrawnPhaseSequence | MalformedPhaseSequence;

/**
 * One layout, held until the sequence actually changes.
 *
 * Keyed on content, not array identity, because the renderer re-enters its store whenever
 * the arrays it is handed move. One instance per mounted graph, so graphs never share a memo.
 */
export class PhaseSequenceLayoutCache {
  #signature: string | undefined;
  #layout: PhaseSequenceLayout | undefined;

  /**
   * The layout for `phases` under `topology`, recomputed only when either moved.
   * The returned object is reference-stable across calls that describe one run.
   */
  public layoutFor(phases: readonly RunGraphNode[], topology?: PhaseTopology): PhaseSequenceLayout {
    const signature = phaseSequenceSignature(phases, topology);
    const held = this.#layout;
    if (held !== undefined && this.#signature === signature) {
      return held;
    }
    const layout = layoutPhaseSequence(phases, topology);
    this.#signature = signature;
    this.#layout = layout;
    return layout;
  }
}

/**
 * Place a run's phases and draw the definition's dependencies over them, or refuse.
 *
 * `topology` absent places the phases with no edge: a run's dependencies are the definition's
 * and are never invented. Deterministic: no sorting and no comparison but string identity.
 */
export function layoutPhaseSequence(
  phases: readonly RunGraphNode[],
  topology?: PhaseTopology,
): PhaseSequenceLayout {
  const repeated = repeatedPhaseIds(phases);
  if (repeated.length > 0) {
    return { status: "malformed", repeatedPhaseIds: repeated };
  }

  const nodes: PositionedPhaseNode[] = phases.map((phase, index) => ({
    phase,
    // The run's own order: a reading order, not a claim about dependencies.
    rank: index,
    // A single column, read top to bottom as the pane scrolls. Centering is the viewport's job.
    x: 0,
    y: index * PHASE_RANK_PITCH_PX,
  }));

  if (topology === undefined) {
    return { status: "drawn", nodes, edges: [], topologyAbsence: "not-supplied" };
  }
  const edges = declaredEdges(phases, topology);
  return edges === undefined
    ? { status: "drawn", nodes, edges: [], topologyAbsence: "not-drawable" }
    : { status: "drawn", nodes, edges };
}

/**
 * Everything about a sequence that changes what is drawn, as one comparable string.
 *
 * An explicit tuple per phase names the five members the visuals read, so new phase members
 * do not invalidate the memo. The topology is included so a definition arriving after its run
 * replaces the edgeless layout.
 */
export function phaseSequenceSignature(
  phases: readonly RunGraphNode[],
  topology?: PhaseTopology,
): string {
  return JSON.stringify([
    phases.map((phase) => [
      phase.phaseId,
      phase.displayName,
      phase.state,
      phase.gateState,
      phase.parkAttention,
    ]),
    topology?.map((declaration) => [declaration.phaseId, declaration.dependsOn ?? null]) ?? null,
  ]);
}

/** Every phase id that appears more than once, in first-repeat order and once each. */
function repeatedPhaseIds(phases: readonly RunGraphNode[]): readonly string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const phase of phases) {
    if (seen.has(phase.phaseId)) {
      repeated.add(phase.phaseId);
    }
    seen.add(phase.phaseId);
  }
  return [...repeated];
}
