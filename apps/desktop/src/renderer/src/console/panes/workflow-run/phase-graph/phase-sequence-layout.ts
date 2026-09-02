// Where a run's phases sit on the canvas, and the vocabulary the caller hands in.
//
// WHY THE LAYOUT IS OURS. `Spec-023 §Console Libraries` ADOPTs the graph renderer
// under constraints and OWN-BUILDs the layered auto-layout beside it, naming the
// four layout packages a canvas ordinarily reaches for as AVOIDed. This module is
// that own-build, and it is a PURE FUNCTION of the phase order: no measurement, no
// force simulation, no iteration count, no clock. Two processes handed the same
// sequence produce byte-identical positions, which is the property a shared session
// needs and the one a measured or annealed layout cannot promise.
//
// WHY THE RANK IS THE INDEX. The sole edge kind this surface draws is the sequence
// edge — phase N to phase N+1 — so the longest-path rank of every node IS its
// position in the run's own order, and computing it any other way would be an
// algorithm dressing up an array index. That is a fact about today's edge set, not
// a shortcut: the day a second edge kind exists, `rankOf` below is the one function
// that changes and every position follows from it.
//
// WHY A REPEATED PHASE ID REFUSES RATHER THAN DEDUPES. Node identity on the canvas
// is the phase id. Two phases arriving under one id would collide — one would
// silently replace the other and the graph would show fewer phases than the run
// has, which is the worst failure a projection can have, because it looks finished.
// So the layout is a union: a well-formed sequence is `drawn`, and a malformed one
// names the ids that repeated, for a caller that renders the refusal instead of a
// picture that quietly lost a phase.
//
// NOTHING HERE IMPORTS THE GRAPH LIBRARY, not even for a type. This module sits on
// the initial bundle path — the host reads a layout before it decides whether to
// fetch a renderer at all — and a static edge from here into `@xyflow/react` would
// pull the chunk the whole lazy arrangement exists to keep out.

/**
 * One phase of a run, as the caller reports it.
 *
 * Every member is the caller's: this module derives geometry from the ORDER of
 * these entries and reads nothing else into them. In particular the label is
 * supplied rather than composed — a phase's display name is a fact about the run,
 * and a graph that invented one would be asserting something it never read.
 */
export interface PhaseGraphNode {
  readonly phaseId: string;
  /** What a person reads on the node. The caller decides; this file never invents one. */
  readonly label: string;
  readonly state: "pending" | "running" | "completed" | "failed" | "skipped";
  readonly gateState: "closed" | "open" | "bypassed";
  /** True exactly while the phase is parked right now. */
  readonly isParked: boolean;
}

/**
 * The node box, in CSS pixels at the 16 px root.
 *
 * FIXED rather than measured, and that is the whole determinism argument: a box
 * sized from rendered text is a function of the host's installed faces, so two
 * machines showing one run would disagree about where every phase is. 208 px is
 * 13rem — the label sets at `--meridian-text-sm` over two lines at this measure,
 * with the state line under it.
 */
export const PHASE_NODE_WIDTH_PX: number = 208;

/** The node box's block size: 4rem at the 16 px root — two label lines plus the state line. */
export const PHASE_NODE_HEIGHT_PX: number = 64;

/**
 * The gap between one rank's box and the next.
 *
 * 48 px, which is `--meridian-space-8` at the 16 px root, so the sequence edge reads
 * as a connector with a direction rather than as a seam between two stacked cards.
 */
export const PHASE_RANK_SPACING_PX: number = 48;

/** Rank to rank, box included. The one number every position is a multiple of. */
export const PHASE_RANK_PITCH_PX: number = PHASE_NODE_HEIGHT_PX + PHASE_RANK_SPACING_PX;

/** A phase placed on the canvas. Position is in the flow's own coordinate space. */
export interface PositionedPhaseNode {
  readonly phase: PhaseGraphNode;
  /** Longest-path rank. With one edge kind this is the phase's position in the run. */
  readonly rank: number;
  readonly x: number;
  readonly y: number;
}

/** One sequence edge: this phase, then the next. The only edge kind this surface draws. */
export interface PhaseSequenceEdge {
  readonly edgeId: string;
  readonly sourcePhaseId: string;
  readonly targetPhaseId: string;
  /** The target's label, so an edge can name where it leads without a second lookup. */
  readonly targetLabel: string;
}

/** A sequence that can be drawn, with every phase placed and every edge derived. */
export interface DrawnPhaseSequence {
  readonly status: "drawn";
  readonly nodes: readonly PositionedPhaseNode[];
  readonly edges: readonly PhaseSequenceEdge[];
}

/**
 * A sequence that cannot be drawn without losing a phase.
 *
 * The ids are carried so the refusal can say WHICH phase repeated. A refusal that
 * only said "malformed" would leave the operator with a blank surface and no way
 * to tell whether the run or the console is at fault.
 */
export interface MalformedPhaseSequence {
  readonly status: "malformed";
  readonly repeatedPhaseIds: readonly string[];
}

export type PhaseSequenceLayout = DrawnPhaseSequence | MalformedPhaseSequence;

/** The rank of the phase at `index`. The one place the edge set reaches the geometry. */
function rankOf(index: number): number {
  return index;
}

/** Every phase id that appears more than once, in first-repeat order and once each. */
function repeatedPhaseIds(phases: readonly PhaseGraphNode[]): readonly string[] {
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

/**
 * Place a run's phases, or refuse.
 *
 * Deterministic and allocation-flat: one pass for the identity check and one for the
 * placement, no sorting, no comparison of anything but string identity — so the
 * result depends on the input order and on nothing about the machine it ran on.
 */
export function layoutPhaseSequence(phases: readonly PhaseGraphNode[]): PhaseSequenceLayout {
  const repeated = repeatedPhaseIds(phases);
  if (repeated.length > 0) {
    return { status: "malformed", repeatedPhaseIds: repeated };
  }

  const nodes: PositionedPhaseNode[] = phases.map((phase, index) => ({
    phase,
    rank: rankOf(index),
    // A single column: the sequence reads top to bottom, which is the direction a
    // log reads and the direction the pane scrolls. Centring is the viewport's job.
    x: 0,
    y: rankOf(index) * PHASE_RANK_PITCH_PX,
  }));

  const edges: PhaseSequenceEdge[] = [];
  for (let index = 1; index < phases.length; index += 1) {
    const source = phases[index - 1];
    const target = phases[index];
    if (source === undefined || target === undefined) {
      continue;
    }
    edges.push({
      edgeId: `${source.phaseId}->${target.phaseId}`,
      sourcePhaseId: source.phaseId,
      targetPhaseId: target.phaseId,
      targetLabel: target.label,
    });
  }

  return { status: "drawn", nodes, edges };
}

/**
 * Everything about a sequence that changes what is drawn, as one comparable string.
 *
 * `JSON.stringify` over an explicit tuple per phase rather than over the objects
 * themselves: the tuple names the five members the layout and the node visuals read,
 * so a caller that grows its phase objects a sixth member does not silently start
 * invalidating a memo that has nothing to recompute.
 */
export function phaseSequenceSignature(phases: readonly PhaseGraphNode[]): string {
  return JSON.stringify(
    phases.map((phase) => [
      phase.phaseId,
      phase.label,
      phase.state,
      phase.gateState,
      phase.isParked,
    ]),
  );
}

/**
 * One layout, held until the sequence actually changes.
 *
 * WHY A CLASS. The graph renderer is controlled: it reads the node and edge arrays
 * it is handed and re-enters its own store whenever their identity moves, so a
 * layout rebuilt on every render would restart that work on every keystroke
 * anywhere in the pane. The memo therefore has to key on CONTENT rather than on
 * array identity, because a caller composing its phase list per render hands over a
 * fresh array each time with the same run inside it.
 *
 * A private field rather than a module-level `let`, per `apps/desktop/AGENTS.md`:
 * one instance per mounted graph, so two graphs on screen never share a memo, and a
 * test can hold two caches side by side and watch them disagree.
 */
export class PhaseSequenceLayoutCache {
  #signature: string | undefined;
  #layout: PhaseSequenceLayout | undefined;

  /**
   * The layout for `phases`, recomputed only when the sequence's content moved.
   * The returned object is reference-stable across calls that describe one run.
   */
  public layoutFor(phases: readonly PhaseGraphNode[]): PhaseSequenceLayout {
    const signature = phaseSequenceSignature(phases);
    const held = this.#layout;
    if (held !== undefined && this.#signature === signature) {
      return held;
    }
    const layout = layoutPhaseSequence(phases);
    this.#signature = signature;
    this.#layout = layout;
    return layout;
  }
}
