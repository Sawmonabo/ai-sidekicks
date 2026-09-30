// Which phases connect: the definition's answer, and nothing inferred from order. A branching
// definition was once drawn as a serial chain, so the fan-out cases are written as pairs: the
// declared edges that must be there and the adjacent-pair edge that must not. A definition
// the daemon would reject is never drawn partly.

import { describe, expect, it } from "vitest";

import {
  declaredEdges,
  phaseDisplayText,
  phasesNeverEligible,
  type RunGraphNode,
  type PhaseTopology,
} from "./phase-topology.js";

/** A phase with everything named, so a case perturbs exactly one member. */
function phase(phaseId: string): RunGraphNode {
  return {
    phaseId,
    displayName: `Phase ${phaseId}`,
    state: "pending",
    gateState: "closed",
    parkAttention: undefined,
  };
}

/**
 * A run whose definition branches: one phase fans out to two, and the two join.
 *
 * The run order is `plan, buildA, buildB, ship`, so `buildA -> buildB` is the edge an
 * adjacency-derived layout draws and the definition never declares.
 */
const FAN_OUT_PHASES: readonly RunGraphNode[] = [
  phase("plan"),
  phase("buildA"),
  phase("buildB"),
  phase("ship"),
];

const FAN_OUT_TOPOLOGY: PhaseTopology = [
  // An empty list marks an entry-node successor: this phase declares that it waits for nothing.
  { phaseId: "plan", dependsOn: [] },
  { phaseId: "buildA", dependsOn: ["plan"] },
  { phaseId: "buildB", dependsOn: ["plan"] },
  { phaseId: "ship", dependsOn: ["buildA", "buildB"] },
];

/** The edges of a result, as `source -> target` pairs, for readable assertions. */
function edgePairs(edges: readonly { sourcePhaseId: string; targetPhaseId: string }[]): string[] {
  return edges.map((edge) => `${edge.sourcePhaseId}->${edge.targetPhaseId}`);
}

function drawnEdgePairs(phases: readonly RunGraphNode[], topology: PhaseTopology): string[] {
  const edges = declaredEdges(phases, topology);
  if (edges === undefined) {
    throw new Error("expected a drawable topology");
  }
  return edgePairs(edges);
}

describe("a definition that branches", () => {
  it("draws the fan-out and the join the definition declares", () => {
    // `plan->buildB` and `buildA->ship` are not adjacent pairs, so adjacency cannot produce
    // either.
    expect(drawnEdgePairs(FAN_OUT_PHASES, FAN_OUT_TOPOLOGY).sort()).toStrictEqual([
      "buildA->ship",
      "buildB->ship",
      "plan->buildA",
      "plan->buildB",
    ]);
  });

  it("draws no edge between two phases that merely sit next to each other", () => {
    // `buildA` and `buildB` are adjacent in the run's array and independent in the definition.
    expect(drawnEdgePairs(FAN_OUT_PHASES, FAN_OUT_TOPOLOGY)).not.toContain("buildA->buildB");
  });

  it("carries the target's label on every edge, so nothing looks a phase up twice", () => {
    const edges = declaredEdges(FAN_OUT_PHASES, FAN_OUT_TOPOLOGY) ?? [];

    for (const edge of edges) {
      expect(edge.targetLabel).toBe(`Phase ${edge.targetPhaseId}`);
    }
    expect(new Set(edges.map((edge) => edge.edgeId)).size).toBe(edges.length);
  });
});

describe("a definition that declares no dependencies at all", () => {
  const CHAIN_PHASES: readonly RunGraphNode[] = [phase("plan"), phase("build"), phase("ship")];

  it("reads its own declaration order as the chain", () => {
    // Every phase omitting `dependsOn` means the definition's order is the sequence: the one
    // case where consecutive phases really are connected.
    expect(
      drawnEdgePairs(CHAIN_PHASES, [
        { phaseId: "plan" },
        { phaseId: "build" },
        { phaseId: "ship" },
      ]),
    ).toStrictEqual(["plan->build", "build->ship"]);
  });

  it("follows the DEFINITION's order rather than the run's", () => {
    // The chain is read off the topology, not the phase array: a definition whose order
    // differs from the run's must draw the definition's chain.
    expect(
      drawnEdgePairs(CHAIN_PHASES, [
        { phaseId: "ship" },
        { phaseId: "plan" },
        { phaseId: "build" },
      ]),
    ).toStrictEqual(["ship->plan", "plan->build"]);
  });
});

describe("a topology no graph can be drawn from", () => {
  it("refuses a definition that declares dependencies on some phases and not others", () => {
    // The all-or-none rule is a typed refusal at the daemon. Drawing the declared half would
    // leave the undeclared phases floating free.
    expect(
      declaredEdges(FAN_OUT_PHASES, [
        { phaseId: "plan", dependsOn: [] },
        { phaseId: "buildA", dependsOn: ["plan"] },
        { phaseId: "buildB" },
        { phaseId: "ship", dependsOn: ["buildA", "buildB"] },
      ]),
    ).toBeUndefined();
  });

  it("refuses a dependency on a phase the run does not carry", () => {
    expect(
      declaredEdges(
        [phase("plan"), phase("ship")],
        [
          { phaseId: "plan", dependsOn: [] },
          { phaseId: "ship", dependsOn: ["review"] },
        ],
      ),
    ).toBeUndefined();
  });

  it("refuses a definition describing a phase set that is not the run's", () => {
    // Both directions of mismatch: a definition naming a phase the run does not report, and
    // one silent about a phase the run does.
    expect(
      declaredEdges(FAN_OUT_PHASES, [
        { phaseId: "plan", dependsOn: [] },
        { phaseId: "buildA", dependsOn: ["plan"] },
        { phaseId: "buildB", dependsOn: ["plan"] },
      ]),
    ).toBeUndefined();
    expect(
      declaredEdges(
        [phase("plan")],
        [
          { phaseId: "plan", dependsOn: [] },
          { phaseId: "ship", dependsOn: ["plan"] },
        ],
      ),
    ).toBeUndefined();
  });

  it("refuses one dependency listed twice rather than quietly drawing it once", () => {
    // Deduping would hide a definition the daemon should have refused; keeping both would
    // collide, since an edge's identity on the canvas is its endpoints.
    expect(
      declaredEdges(
        [phase("plan"), phase("ship")],
        [
          { phaseId: "plan", dependsOn: [] },
          { phaseId: "ship", dependsOn: ["plan", "plan"] },
        ],
      ),
    ).toBeUndefined();
  });

  it("refuses a phase declared twice while another is not declared at all", () => {
    // The count is right and every declared id is a phase the run carries, yet the order-chain
    // path would draw `plan -> plan` while `ship` floated free.
    expect(
      declaredEdges([phase("plan"), phase("ship")], [{ phaseId: "plan" }, { phaseId: "plan" }]),
    ).toBeUndefined();
    // The same shape on the explicit-dependency path would leave `ship` connected to nothing
    // with no refusal.
    expect(
      declaredEdges(
        [phase("plan"), phase("ship")],
        [
          { phaseId: "plan", dependsOn: [] },
          { phaseId: "plan", dependsOn: ["plan"] },
        ],
      ),
    ).toBeUndefined();
  });

  it("draws no phase depending on itself, on either path", () => {
    // A self-edge says a phase is waiting on itself. The second topology reaches it another
    // way, a well-formed phase set whose declaration names its own phase, and is refused too.
    for (const topology of [
      [{ phaseId: "plan" }, { phaseId: "plan" }],
      [
        { phaseId: "plan", dependsOn: ["plan"] },
        { phaseId: "ship", dependsOn: ["plan"] },
      ],
    ] satisfies PhaseTopology[]) {
      const edges = declaredEdges([phase("plan"), phase("ship")], topology) ?? [];
      expect(edges.filter((edge) => edge.sourcePhaseId === edge.targetPhaseId)).toStrictEqual([]);
    }
  });

  it("refuses two phases that wait on each other", () => {
    // Neither declaration is a self-edge, so a direct self-dependency check passes both and
    // draws an impossible definition.
    const topology: PhaseTopology = [
      { phaseId: "plan", dependsOn: ["ship"] },
      { phaseId: "ship", dependsOn: ["plan"] },
    ];
    expect(declaredEdges([phase("plan"), phase("ship")], topology)).toBeUndefined();
    expect(phasesNeverEligible(topology)).toStrictEqual(["plan", "ship"]);
  });

  it("negative control: nothing in that pair is a self-dependency", () => {
    // Every declaration names a phase other than its own, so the refusal can only come from
    // reading the declaration as a whole.
    const topology: PhaseTopology = [
      { phaseId: "plan", dependsOn: ["ship"] },
      { phaseId: "ship", dependsOn: ["plan"] },
    ];
    for (const declaration of topology) {
      expect(declaration.dependsOn).not.toContain(declaration.phaseId);
    }
  });

  it("refuses a cycle of three, naming every phase on it", () => {
    const topology: PhaseTopology = [
      { phaseId: "plan", dependsOn: ["ship"] },
      { phaseId: "buildA", dependsOn: ["plan"] },
      { phaseId: "ship", dependsOn: ["buildA"] },
    ];
    expect(
      declaredEdges([phase("plan"), phase("buildA"), phase("ship")], topology),
    ).toBeUndefined();
    expect(phasesNeverEligible(topology)).toStrictEqual(["plan", "buildA", "ship"]);
  });

  it("names the phase stalled behind a cycle beside the cycle's own members", () => {
    // The operator's question is which phases will never run; a branch waiting on a loop never
    // runs either.
    const topology: PhaseTopology = [
      { phaseId: "plan", dependsOn: ["buildA"] },
      { phaseId: "buildA", dependsOn: ["plan"] },
      { phaseId: "ship", dependsOn: ["buildA"] },
    ];
    expect(phasesNeverEligible(topology)).toStrictEqual(["plan", "buildA", "ship"]);
  });

  it("negative control: a definition that branches and joins blocks nothing", () => {
    // Without this the cycle check would pass for one that called every topology cyclic.
    expect(phasesNeverEligible(FAN_OUT_TOPOLOGY)).toStrictEqual([]);
  });

  it("negative control: the well-formed topology beside each of these is drawable", () => {
    // Without this the refusals above would pass over an implementation that refused every
    // topology.
    expect(declaredEdges(FAN_OUT_PHASES, FAN_OUT_TOPOLOGY)).not.toBeUndefined();
  });
});

describe("the words that stand for a phase where only a string will do", () => {
  it("uses the authored name when the caller has one", () => {
    expect(phaseDisplayText(phase("plan"))).toBe("Phase plan");
  });

  it("falls back to the identifier when no name was read", () => {
    // A sentence has no mono face to lend the identifier, so the fallback is what an accessible
    // name or edge label can say; the box renders name and id apart.
    expect(phaseDisplayText({ ...phase("plan"), displayName: undefined })).toBe("plan");
  });

  it("carries the fallback onto an edge, so a nameless run's edges still lead somewhere", () => {
    const nameless = FAN_OUT_PHASES.map((entry) => ({ ...entry, displayName: undefined }));
    const edges = declaredEdges(nameless, FAN_OUT_TOPOLOGY) ?? [];

    expect(edges).not.toHaveLength(0);
    for (const edge of edges) {
      expect(edge.targetLabel).toBe(edge.targetPhaseId);
    }
  });
});
