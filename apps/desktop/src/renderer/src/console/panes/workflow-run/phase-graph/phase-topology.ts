// The graph's data vocabulary, and the one place a run's edges come from.
//
// WHY THIS IS ITS OWN MODULE. Placing phases and deciding which phases connect are
// two jobs, and until this fold they were one function because there was only ever
// one answer: phase N to phase N+1. That answer was wrong. `workflow.runRead`
// carries an ORDERED `phaseStates` array and NO topology at all — the sequence
// edges, the fan-out and the joins live on the pinned definition's `dependsOn`
// lists — so an adjacency-derived edge asserted a dependency the run never
// declared, and a parallel run was drawn as a serial chain. Deriving edges from a
// declaration is enough work, and enough rules, to be read on its own.
//
// NOTHING HERE IS GEOMETRY. No pixel, no rank, no position: this module answers
// which phases connect, and `phase-sequence-layout.ts` beside it answers where they
// sit. That is also why the vocabulary both of them read lives here rather than
// there — the dependency runs one way, and a module that decides edges has no
// business importing a module that decides pixels.
//
// NOTHING HERE IMPORTS THE GRAPH LIBRARY, not even for a type, for the reason its
// neighbour states: both sit on the initial bundle path, and a static edge into
// `@xyflow/react` would pull the chunk the lazy arrangement exists to keep out.

/**
 * One phase of the pinned DEFINITION, as the definition declares it.
 *
 * The only source of edges this module accepts. `dependsOn` is transcribed from the
 * registered `PhaseDefinition` shape verbatim, optional exactly as it is there: the
 * ids of the phases whose gates must resolve before this one becomes eligible, an
 * empty list marking an entry-node successor, and absence — on EVERY phase together
 * — meaning the declaration order is the chain.
 */
export interface PhaseDependencyDeclaration {
  readonly phaseId: string;
  readonly dependsOn?: readonly string[];
}

/**
 * The pinned definition's phases in declaration order, where one has been read.
 *
 * A list rather than a map, because the order is load-bearing: it is what declares
 * the chain for a definition that omits `dependsOn` throughout.
 */
export type PhaseTopology = readonly PhaseDependencyDeclaration[];

/**
 * Why a drawn sequence carries no edges. Two, because the next move differs.
 *
 *   • `not-supplied` — no definition reached this graph, so there is no topology to
 *     draw. Nothing is wrong; the picture is simply incomplete and says so.
 *   • `not-drawable` — a definition DID reach it and its topology is not one a graph
 *     can draw: it supplies `dependsOn` on some phases and not others, which the
 *     all-or-none rule forbids, or it describes a phase set that is not the run's.
 *     Drawing part of it would be a picture short of a dependency.
 */
export type PhaseTopologyAbsence = "not-supplied" | "not-drawable";

/**
 * One phase of a RUN, as the caller reports it.
 *
 * The other half of the pair: a declaration above is what the definition says
 * should happen, and this is what the run says did. Every member is the caller's,
 * and in particular the label is supplied rather than composed — a phase's display
 * name is a fact about the run, and a graph that invented one would be asserting
 * something it never read.
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

/** One declared dependency, drawn from the phase depended on to the phase that waits. */
export interface PhaseSequenceEdge {
  readonly edgeId: string;
  readonly sourcePhaseId: string;
  readonly targetPhaseId: string;
  /** The target's label, so an edge can name where it leads without a second lookup. */
  readonly targetLabel: string;
}

/**
 * One edge, from the phase depended on to the phase that waits for it.
 *
 * Built through one function so the id and the carried label are composed in one
 * place: an edge whose id disagreed with its endpoints would collide on the canvas,
 * where node and edge identity are the only keys there are.
 */
function dependencyEdge(sourcePhaseId: string, target: PhaseGraphNode): PhaseSequenceEdge {
  return {
    edgeId: `${sourcePhaseId}->${target.phaseId}`,
    sourcePhaseId,
    targetPhaseId: target.phaseId,
    targetLabel: target.label,
  };
}

/**
 * The edges one definition declares over one run's phases, or nothing.
 *
 * `undefined` means the topology is not drawable — the caller renders no edges and
 * says so. Every refusal here is a definition the daemon's own author-time checks
 * would have rejected, so nothing partial is drawn from one: a graph short of a
 * dependency looks finished and is wrong, which is the failure this whole module is
 * written against.
 */
export function declaredEdges(
  phases: readonly PhaseGraphNode[],
  topology: PhaseTopology,
): readonly PhaseSequenceEdge[] | undefined {
  const phaseById = new Map(phases.map((phase) => [phase.phaseId, phase]));
  // The definition has to describe exactly the phases the run reports. A topology
  // naming a phase the run does not carry would draw an edge to nowhere, and one
  // silent about a phase the run does carry leaves that phase's dependencies
  // unstated — neither is a picture of this run.
  if (topology.length !== phaseById.size) {
    return undefined;
  }
  for (const declaration of topology) {
    if (!phaseById.has(declaration.phaseId)) {
      return undefined;
    }
  }

  const declaring = topology.filter((declaration) => declaration.dependsOn !== undefined);
  if (declaring.length === 0) {
    return chainOverDeclarationOrder(phaseById, topology);
  }
  if (declaring.length !== topology.length) {
    // The all-or-none rule, which the owning contract makes a typed refusal at the
    // daemon. A console that drew the declared half would show a run whose
    // undeclared phases float free of everything.
    return undefined;
  }

  const edges = new Map<string, PhaseSequenceEdge>();
  for (const declaration of declaring) {
    const target = phaseById.get(declaration.phaseId);
    for (const sourcePhaseId of declaration.dependsOn ?? []) {
      if (target === undefined || !phaseById.has(sourcePhaseId)) {
        return undefined;
      }
      const edge = dependencyEdge(sourcePhaseId, target);
      if (edges.has(edge.edgeId)) {
        // One dependency listed twice. Deduping it would hide a definition the
        // daemon should have refused, and keeping both would collide on the canvas.
        return undefined;
      }
      edges.set(edge.edgeId, edge);
    }
  }
  return [...edges.values()];
}

/**
 * The chain a definition that omits `dependsOn` throughout declares by its order.
 *
 * The DEFINITION's order and not the run's: the contract makes the declaration order
 * the chain, and the run read's array order is a separate fact that happens to agree
 * today. Reading it off the run instead would be this module inferring the edge set
 * again, one indirection further along.
 */
function chainOverDeclarationOrder(
  phaseById: ReadonlyMap<string, PhaseGraphNode>,
  topology: PhaseTopology,
): readonly PhaseSequenceEdge[] {
  const edges: PhaseSequenceEdge[] = [];
  for (let index = 1; index < topology.length; index += 1) {
    const source = topology[index - 1];
    const target = topology[index];
    if (source === undefined || target === undefined) {
      continue;
    }
    const targetNode = phaseById.get(target.phaseId);
    if (targetNode !== undefined) {
      edges.push(dependencyEdge(source.phaseId, targetNode));
    }
  }
  return edges;
}
