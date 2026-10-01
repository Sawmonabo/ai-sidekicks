// The graph's data vocabulary, and the one place a run's edges come from. A run read carries an
// ordered `phaseStates` array and no topology; edges come from the pinned definition's
// `dependsOn` lists. No geometry here (that is `phase-sequence-layout.ts`), and no import of
// the graph library, because both modules sit on the initial bundle path.

/**
 * One phase of the pinned definition, as the definition declares it.
 *
 * `dependsOn` mirrors the registered `PhaseDefinition`: the ids whose gates must resolve first,
 * an empty list for an entry node, and absence on every phase together meaning declaration
 * order is the chain.
 */
export interface PhaseDependencyDeclaration {
  readonly phaseId: string;
  readonly dependsOn?: readonly string[];
}

/**
 * The pinned definition's phases in declaration order, where one has been read.
 *
 * A list because order declares the chain for a definition that omits `dependsOn` throughout.
 */
export type PhaseTopology = readonly PhaseDependencyDeclaration[];

/**
 * Why a drawn sequence carries no edges. Two, because the next move differs.
 *
 *   - `not-supplied`: no definition reached this graph; the picture is incomplete and says so.
 *   - `not-drawable`: the definition has `dependsOn` on some phases only, a phase set that is
 *     not the run's, or a dependency cycle. A partial or cyclic picture would mislead.
 */
export type PhaseTopologyAbsence = "not-supplied" | "not-drawable";

/**
 * What a park on this canvas is waiting for, and exactly two answers.
 *
 * A boolean would give every park the amber border, including a provider-limited phase with a
 * readable resume that needs nobody; amber means a person is needed. The caller derives the
 * answer through `parkAwaitsPerson` in `runs/run-list-rows.ts`, as the park badge does.
 */
export type PhaseParkAttention = "awaiting-person" | "scheduled";

/**
 * What a node prints, and says out loud, for each attention reading.
 *
 * Total over the closed set, and shared by the box and the accessible name so a reader who
 * looks and one who listens are told the same thing.
 */
export const PHASE_PARK_ATTENTION_MARKS: Readonly<Record<PhaseParkAttention, string>> = {
  "awaiting-person": "parked",
  scheduled: "parked, resume scheduled",
};

/**
 * One phase of a run, as the caller reports it.
 *
 * The display name is supplied, never composed: a graph that invented one would assert
 * something it never read. Name and identifier are separate members so a caller with no name
 * cannot pass the phase id in its place, and the id renders in mono as a daemon figure.
 */
export interface RunGraphNode {
  /** The run's own identity for this phase. Wire-verbatim; never parsed, never prettified. */
  readonly phaseId: string;
  /**
   * The phase's authored name, where the caller holds one.
   *
   * `undefined` means no read available to the caller carries a name, not that the phase has
   * none. Stated on every node rather than left optional.
   */
  readonly displayName: string | undefined;
  readonly state: "pending" | "running" | "completed" | "failed" | "skipped";
  readonly gateState: "closed" | "open" | "bypassed";
  /**
   * How this phase's park reads, or nothing where the phase is not parked.
   *
   * Spelled `| undefined` because, under `exactOptionalPropertyTypes`, an absent key and a key
   * holding `undefined` are different types at the one call site.
   */
  readonly parkAttention: PhaseParkAttention | undefined;
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
 * The words that stand for one phase where only a string will do.
 *
 * The authored name where there is one, else the identifier. Stated once so the accessible
 * name and an edge label cannot announce different strings for one phase.
 */
export function phaseDisplayText(phase: RunGraphNode): string {
  return phase.displayName ?? phase.phaseId;
}

/**
 * The edges one definition declares over one run's phases, or nothing.
 *
 * `undefined` means the topology is not drawable and the caller draws no edges. Nothing
 * partial is drawn: a graph short of a dependency looks finished and is wrong.
 */
export function declaredEdges(
  phases: readonly RunGraphNode[],
  topology: PhaseTopology,
): readonly PhaseSequenceEdge[] | undefined {
  const phaseById = new Map(phases.map((phase) => [phase.phaseId, phase]));
  // The definition must describe each of the run's phases exactly once. Counted by identifier
  // rather than by length: two declarations for one phase and none for another pass a length
  // check and a membership test yet draw a run with a phase missing.
  const declaredPhaseIds = new Set<string>();
  for (const declaration of topology) {
    if (!phaseById.has(declaration.phaseId) || declaredPhaseIds.has(declaration.phaseId)) {
      return undefined;
    }
    declaredPhaseIds.add(declaration.phaseId);
  }
  if (declaredPhaseIds.size !== phaseById.size) {
    return undefined;
  }

  const declaring = topology.filter((declaration) => declaration.dependsOn !== undefined);
  if (declaring.length === 0) {
    return chainOverDeclarationOrder(phaseById, topology);
  }
  if (declaring.length !== topology.length) {
    // The all-or-none rule, a typed refusal at the daemon. Drawing the declared half would
    // leave the undeclared phases floating free.
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
        // One dependency listed twice: deduping would hide a definition the daemon should
        // have refused, and keeping both would collide on the canvas.
        return undefined;
      }
      edges.set(edge.edgeId, edge);
    }
  }
  // A dependency cycle, checked over the whole declaration: A depends on B depends on A has no
  // self-edge yet no phase in it can ever become eligible.
  if (phasesNeverEligible(declaring).length > 0) {
    return undefined;
  }
  return [...edges.values()];
}

/**
 * Every declared phase that can never become eligible, in declaration order.
 *
 * Kahn's peel run to exhaustion: what is left is a cycle's members and anything waiting
 * behind them. Named rather than counted, so a person can find the loop. Every dependency
 * is already known to be a declared phase.
 */
export function phasesNeverEligible(topology: PhaseTopology): readonly string[] {
  const unsatisfied = new Map<string, Set<string>>(
    topology.map((declaration) => [declaration.phaseId, new Set(declaration.dependsOn ?? [])]),
  );
  let peeled = true;
  while (peeled) {
    peeled = false;
    for (const [phaseId, dependencies] of unsatisfied) {
      if (dependencies.size > 0) {
        continue;
      }
      unsatisfied.delete(phaseId);
      for (const waiting of unsatisfied.values()) {
        waiting.delete(phaseId);
      }
      peeled = true;
    }
  }
  // Declaration order, so two runs of one definition name the phases in the order a reader
  // meets them.
  return topology
    .map((declaration) => declaration.phaseId)
    .filter((phaseId) => unsatisfied.has(phaseId));
}

/**
 * One edge, from the phase depended on to the phase that waits for it.
 *
 * Built in one place so the id and the label always agree with the endpoints; edge identity
 * is the only key on the canvas.
 */
function dependencyEdge(sourcePhaseId: string, target: RunGraphNode): PhaseSequenceEdge {
  return {
    edgeId: `${sourcePhaseId}->${target.phaseId}`,
    sourcePhaseId,
    targetPhaseId: target.phaseId,
    targetLabel: phaseDisplayText(target),
  };
}

/**
 * The chain a definition that omits `dependsOn` throughout declares by its order.
 *
 * Read off the definition's order, not the run's array order, which is a separate fact.
 */
function chainOverDeclarationOrder(
  phaseById: ReadonlyMap<string, RunGraphNode>,
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
