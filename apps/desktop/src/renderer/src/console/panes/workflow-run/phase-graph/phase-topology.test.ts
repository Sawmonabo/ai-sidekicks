// Which phases connect: the definition's answer, and nothing inferred from order.
//
// THE FAN-OUT CASE IS THE SUBJECT OF THIS FILE. A run whose definition branches was
// drawn as a serial chain, because the edge set was derived from the position of
// entries in `phaseStates` — so the picture asserted dependencies the definition
// never declared and hid the two it did. Every case below is written as a pair: the
// declared edges that must be there, and the adjacent-pair edge that must not.
//
// The refusals are written the same way. A definition the daemon would have rejected
// at author time is not drawn PARTLY: a graph short of one dependency looks finished
// and is wrong, which is the same failure the repeated-identifier refusal next door
// exists to prevent.

import { describe, expect, it } from "vitest";

import {
  declaredEdges,
  phaseDisplayText,
  type PhaseGraphNode,
  type PhaseTopology,
} from "./phase-topology.js";

/** A phase with everything named, so a case perturbs exactly one member. */
function phase(phaseId: string): PhaseGraphNode {
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
 * The run order is `plan, buildA, buildB, ship`, so `buildA -> buildB` is the edge
 * an adjacency-derived layout draws and the definition never declares. It is the
 * discriminator every case in the first block reads.
 */
const FAN_OUT_PHASES: readonly PhaseGraphNode[] = [
  phase("plan"),
  phase("buildA"),
  phase("buildB"),
  phase("ship"),
];

const FAN_OUT_TOPOLOGY: PhaseTopology = [
  // An empty list marks an entry-node successor, which is the definition's own
  // spelling and not an absence: this phase declares that it waits for nothing.
  { phaseId: "plan", dependsOn: [] },
  { phaseId: "buildA", dependsOn: ["plan"] },
  { phaseId: "buildB", dependsOn: ["plan"] },
  { phaseId: "ship", dependsOn: ["buildA", "buildB"] },
];

/** The edges of a result, as `source -> target` pairs, for readable assertions. */
function edgePairs(edges: readonly { sourcePhaseId: string; targetPhaseId: string }[]): string[] {
  return edges.map((edge) => `${edge.sourcePhaseId}->${edge.targetPhaseId}`);
}

function drawnEdgePairs(phases: readonly PhaseGraphNode[], topology: PhaseTopology): string[] {
  const edges = declaredEdges(phases, topology);
  if (edges === undefined) {
    throw new Error("expected a drawable topology");
  }
  return edgePairs(edges);
}

describe("a definition that branches", () => {
  it("draws the fan-out and the join the definition declares", () => {
    // `plan->buildB` and `buildA->ship` are declared and are NOT adjacent pairs, so
    // an adjacency-derived edge set cannot produce either.
    expect(drawnEdgePairs(FAN_OUT_PHASES, FAN_OUT_TOPOLOGY).sort()).toStrictEqual([
      "buildA->ship",
      "buildB->ship",
      "plan->buildA",
      "plan->buildB",
    ]);
  });

  it("draws no edge between two phases that merely sit next to each other", () => {
    // The defect, stated as the thing that must be absent: `buildA` and `buildB` are
    // adjacent in the run's array and independent in the definition. An edge between
    // them tells an operator one branch waits for the other.
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
  const CHAIN_PHASES: readonly PhaseGraphNode[] = [phase("plan"), phase("build"), phase("ship")];

  it("reads its own declaration order as the chain", () => {
    // The all-or-none rule's other arm: every phase omitting `dependsOn` means the
    // definition's order IS the sequence, which is the one case where consecutive
    // phases really are connected.
    expect(
      drawnEdgePairs(CHAIN_PHASES, [
        { phaseId: "plan" },
        { phaseId: "build" },
        { phaseId: "ship" },
      ]),
    ).toStrictEqual(["plan->build", "build->ship"]);
  });

  it("follows the DEFINITION's order rather than the run's", () => {
    // Negative control for the case above, and the reason the chain is read off the
    // topology rather than off the phase array: a definition whose declaration order
    // differs from the order the run reports its phases in must draw the
    // definition's chain, not the run's.
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
    // The all-or-none rule the owning contract makes a typed refusal at the daemon.
    // Drawing the declared half would leave the undeclared phases floating free of
    // everything, which reads as a workflow that genuinely has no order.
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
    // Both directions of the mismatch: a definition naming a phase the run does not
    // report, and one silent about a phase the run does. Either way the picture
    // would be of a different run.
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
    // Deduping would hide a definition the daemon should have refused; keeping both
    // would collide, because an edge's identity on the canvas is its endpoints.
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
    // The count was right and every declared identifier was a phase the run carries,
    // so this passed — and then the order-chain path below drew `plan -> plan`, a
    // phase depending on itself, while `ship` floated free with no order at all.
    expect(
      declaredEdges([phase("plan"), phase("ship")], [{ phaseId: "plan" }, { phaseId: "plan" }]),
    ).toBeUndefined();
    // The same shape on the explicit-dependency path, where it produced a partial
    // edge set instead: `ship` connected to nothing and no refusal raised.
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
    // The property the case above protects, stated over both paths rather than
    // inferred from one of them: a self-edge is unreachable, and a picture carrying
    // one says a phase is waiting on itself. The second topology reaches it the other
    // way — a well-formed phase set whose declaration names its own phase — and is
    // refused for the same reason rather than drawn.
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

  it("negative control: the well-formed topology beside each of these is drawable", () => {
    // Without this the five refusals above would all pass over an implementation
    // that refused every topology, and no run would ever draw an edge.
    expect(declaredEdges(FAN_OUT_PHASES, FAN_OUT_TOPOLOGY)).not.toBeUndefined();
  });
});

describe("the words that stand for a phase where only a string will do", () => {
  it("uses the authored name when the caller has one", () => {
    expect(phaseDisplayText(phase("plan"))).toBe("Phase plan");
  });

  it("falls back to the identifier when no name was read", () => {
    // The case every read reachable today produces. A sentence has no mono face to
    // lend the identifier, so the fallback is the only honest thing an accessible
    // name or an edge label can say — which is exactly why the BOX does not use it
    // and renders the two members apart.
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
