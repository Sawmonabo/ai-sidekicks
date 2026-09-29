// The own-built layout: the same run draws the same picture, and a run that cannot
// be drawn without losing a phase is refused rather than drawn short.
//
// The assertions below are PROPERTIES rather than restated arithmetic. Checking
// `y === index * pitch` would be this file computing the layout a second time and
// agreeing with itself; checking that consecutive ranks are one pitch apart, that
// the pitch clears the box, and that the same content yields the same object is
// checking things the implementation could get wrong while still passing a
// re-derivation.

import { describe, expect, it } from "vitest";

import {
  PHASE_NODE_HEIGHT_PX,
  PHASE_RANK_PITCH_PX,
  PhaseSequenceLayoutCache,
  layoutPhaseSequence,
  phaseSequenceSignature,
} from "./phase-sequence-layout.js";
import type { PhaseGraphNode, PhaseTopology } from "./phase-topology.js";

/** The definition for `THREE_PHASES`, declaring the chain its order implies. */
const THREE_PHASE_TOPOLOGY: PhaseTopology = [
  { phaseId: "plan", dependsOn: [] },
  { phaseId: "build", dependsOn: ["plan"] },
  { phaseId: "review", dependsOn: ["build"] },
];

/** A phase with everything named, so a case perturbs exactly one member. */
function phase(overrides: Partial<PhaseGraphNode> & { readonly phaseId: string }): PhaseGraphNode {
  return {
    displayName: `Phase ${overrides.phaseId}`,
    state: "pending",
    gateState: "closed",
    parkAttention: undefined,
    ...overrides,
  };
}

const THREE_PHASES: readonly PhaseGraphNode[] = [
  phase({ phaseId: "plan", state: "completed", gateState: "open" }),
  phase({ phaseId: "build", state: "running" }),
  phase({ phaseId: "review", parkAttention: "awaiting-person" }),
];

function drawn(phases: readonly PhaseGraphNode[], topology?: PhaseTopology) {
  const layout = layoutPhaseSequence(phases, topology);
  if (layout.status !== "drawn") {
    throw new Error(`expected a drawn sequence, got ${layout.status}`);
  }
  return layout;
}

describe("the layered layout", () => {
  it("places one phase per rank, in the order it was given", () => {
    const layout = drawn(THREE_PHASES);
    expect(layout.nodes.map((node) => node.phase.phaseId)).toStrictEqual([
      "plan",
      "build",
      "review",
    ]);
    expect(layout.nodes.map((node) => node.rank)).toStrictEqual([0, 1, 2]);
  });

  it("advances one pitch per rank along a single column", () => {
    const layout = drawn(THREE_PHASES);
    const ys = layout.nodes.map((node) => node.y);
    const gaps = ys.slice(1).map((y, index) => y - (ys[index] ?? 0));
    expect(gaps).toStrictEqual([PHASE_RANK_PITCH_PX, PHASE_RANK_PITCH_PX]);
    // One column, so the sequence reads as a sequence rather than as a field.
    expect(new Set(layout.nodes.map((node) => node.x)).size).toBe(1);
  });

  it("leaves room between the boxes it places", () => {
    // Independent of the numbers themselves: a pitch that did not clear the box
    // would overlap every pair of consecutive phases, and the edge between them
    // would have nowhere to be drawn.
    expect(PHASE_RANK_PITCH_PX).toBeGreaterThan(PHASE_NODE_HEIGHT_PX);
  });

  it("draws no edge at all when no definition was handed over", () => {
    // The whole of this fold: a run read carries an ordered array and no
    // dependencies, so a layout given only that array has nothing to connect. The
    // previous behaviour — an edge per adjacent pair — asserted a chain a parallel
    // run never declared.
    const layout = drawn(THREE_PHASES);

    expect(layout.edges).toStrictEqual([]);
    expect(layout.topologyAbsence).toBe("not-supplied");
  });

  it("draws the definition's edges when one was, and marks the picture complete", () => {
    // The other arm, and the negative control for the case above: handed a topology,
    // the same phases connect. `topologyAbsence` absent is what tells a surface the
    // edges it is looking at are the definition's own.
    const layout = drawn(THREE_PHASES, THREE_PHASE_TOPOLOGY);

    expect(layout.edges.map((edge) => [edge.sourcePhaseId, edge.targetPhaseId])).toStrictEqual([
      ["plan", "build"],
      ["build", "review"],
    ]);
    // The edge carries where it leads, so nothing downstream re-looks-up a label.
    expect(layout.edges.map((edge) => edge.targetLabel)).toStrictEqual([
      "Phase build",
      "Phase review",
    ]);
    expect(layout.topologyAbsence).toBeUndefined();
  });

  it("names a topology it cannot draw rather than drawing part of it", () => {
    // A definition that supplies `dependsOn` on some phases and not others is one
    // the daemon refuses at author time. The picture carries no edges AND says which
    // of the two reasons applies, so the surface does not report "nothing to read"
    // for a definition it did read.
    const layout = drawn(THREE_PHASES, [
      { phaseId: "plan", dependsOn: [] },
      { phaseId: "build" },
      { phaseId: "review", dependsOn: ["build"] },
    ]);

    expect(layout.edges).toStrictEqual([]);
    expect(layout.topologyAbsence).toBe("not-drawable");
  });

  it("draws a one-phase run with no edges, and an empty run with neither", () => {
    expect(drawn([phase({ phaseId: "only" })]).edges).toStrictEqual([]);
    const empty = drawn([]);
    expect(empty.nodes).toStrictEqual([]);
    expect(empty.edges).toStrictEqual([]);
  });

  it("is deterministic: the same sequence twice is the same picture", () => {
    // Value equality of two independent runs, which is what a second process would
    // compute. A layout that consulted a clock, a random source or a measured box
    // would diverge here.
    expect(layoutPhaseSequence(THREE_PHASES, THREE_PHASE_TOPOLOGY)).toStrictEqual(
      layoutPhaseSequence(THREE_PHASES, THREE_PHASE_TOPOLOGY),
    );
  });

  it("carries the caller's phase through untouched", () => {
    const layout = drawn(THREE_PHASES);
    // Identity, not shape: the node holds the caller's own object, so no member was
    // copied, defaulted or invented on the way onto the canvas.
    expect(layout.nodes[0]?.phase).toBe(THREE_PHASES[0]);
  });
});

describe("a sequence that cannot be drawn", () => {
  it("refuses a repeated phase id and names it", () => {
    const layout = layoutPhaseSequence([
      phase({ phaseId: "build" }),
      phase({ phaseId: "review" }),
      phase({ phaseId: "build", displayName: "Build again" }),
    ]);
    expect(layout.status).toBe("malformed");
    expect(layout.status === "malformed" ? layout.repeatedPhaseIds : []).toStrictEqual(["build"]);
  });

  it("names each repeated id once, however many times it repeated", () => {
    const layout = layoutPhaseSequence([
      phase({ phaseId: "a" }),
      phase({ phaseId: "a" }),
      phase({ phaseId: "a" }),
      phase({ phaseId: "b" }),
      phase({ phaseId: "b" }),
    ]);
    expect(layout.status === "malformed" ? layout.repeatedPhaseIds : []).toStrictEqual(["a", "b"]);
  });

  it("negative control: distinct ids that share every other member still draw", () => {
    // Without this the refusal above would also fire on two phases that merely look
    // alike, and a run with two `pending` steps would render as an error.
    const layout = layoutPhaseSequence([
      phase({ phaseId: "first", displayName: "Same words" }),
      phase({ phaseId: "second", displayName: "Same words" }),
    ]);
    expect(layout.status).toBe("drawn");
  });
});

describe("the layout memo", () => {
  it("returns the same layout for a fresh array describing the same run", () => {
    const cache = new PhaseSequenceLayoutCache();
    const first = cache.layoutFor([...THREE_PHASES]);
    const second = cache.layoutFor(THREE_PHASES.map((entry) => ({ ...entry })));
    // Reference identity is the observable: the renderer re-enters its store when
    // the arrays it is handed move, so a new object here is a rebuild on screen.
    expect(second).toBe(first);
  });

  it("negative control: a changed member is a different layout", () => {
    const cache = new PhaseSequenceLayoutCache();
    const first = cache.layoutFor(THREE_PHASES);
    const moved = THREE_PHASES.map((entry, index) =>
      index === 1 ? { ...entry, state: "failed" as const } : entry,
    );
    expect(cache.layoutFor(moved)).not.toBe(first);
  });

  it("negative control: two caches do not share one memo", () => {
    // Without this the case above would pass against module-level state, which is
    // exactly what the class form exists to avoid.
    const first = new PhaseSequenceLayoutCache().layoutFor(THREE_PHASES);
    expect(new PhaseSequenceLayoutCache().layoutFor(THREE_PHASES)).not.toBe(first);
  });

  it("the signature moves for every member the picture depends on", () => {
    const base = phase({ phaseId: "one" });
    const perturbations: readonly PhaseGraphNode[] = [
      { ...base, phaseId: "two" },
      { ...base, displayName: "Other words" },
      { ...base, state: "running" },
      { ...base, gateState: "bypassed" },
      { ...base, parkAttention: "awaiting-person" },
      // Two parked readings differ from each other and not merely from no park: a
      // signature that folded the attention into a boolean would hold still while
      // the picture moved from an amber border to a neutral one.
      { ...base, parkAttention: "scheduled" },
    ];
    const baseline = phaseSequenceSignature([base]);
    for (const perturbed of perturbations) {
      expect(phaseSequenceSignature([perturbed])).not.toBe(baseline);
    }
  });

  it("negative control: the signature holds still when nothing moved", () => {
    const base = phase({ phaseId: "one" });
    expect(phaseSequenceSignature([{ ...base }])).toBe(phaseSequenceSignature([base]));
  });

  it("the signature moves when the topology arrives, and the memo follows it", () => {
    // Without this a graph whose definition lands a commit after its run would hold
    // the edgeless layout it computed first and never draw a dependency at all.
    const cache = new PhaseSequenceLayoutCache();
    const edgeless = cache.layoutFor(THREE_PHASES);

    expect(phaseSequenceSignature(THREE_PHASES, THREE_PHASE_TOPOLOGY)).not.toBe(
      phaseSequenceSignature(THREE_PHASES),
    );
    expect(cache.layoutFor(THREE_PHASES, THREE_PHASE_TOPOLOGY)).not.toBe(edgeless);
  });
});
