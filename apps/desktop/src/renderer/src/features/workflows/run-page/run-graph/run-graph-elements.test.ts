// The translation into the renderer's shapes: identity, stated dimensions, and the words a
// reader who is not looking at the canvas is given. The memo case uses the real hook against
// real layout objects, since the property is that a held layout yields arrays held still.

import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  PHASE_NODE_HEIGHT_PX,
  PHASE_NODE_WIDTH_PX,
  type DrawnPhaseSequence,
  layoutPhaseSequence,
} from "./phase-sequence-layout.js";
import type { RunGraphNode, PhaseTopology } from "./phase-topology.js";
import {
  PHASE_NODE_TYPE,
  phaseNodeAccessibleName,
  sequenceEdgeAccessibleName,
  toRunGraphElements,
} from "./run-graph-elements.js";
import { useRunGraphElements } from "./hooks/useRunGraphElements.js";

function phase(overrides: Partial<RunGraphNode> & { readonly phaseId: string }): RunGraphNode {
  return {
    displayName: `Phase ${overrides.phaseId}`,
    state: "pending",
    gateState: "closed",
    parkAttention: undefined,
    ...overrides,
  };
}

const SEQUENCE: readonly RunGraphNode[] = [
  phase({ phaseId: "plan", displayName: "Plan", state: "completed", gateState: "open" }),
  phase({ phaseId: "build", displayName: "Build", state: "running" }),
];

/**
 * The definition those two phases were run from.
 *
 * Edges exist only where a definition declares them, so a test driven off a run alone would
 * have nothing to translate.
 */
const SEQUENCE_TOPOLOGY: PhaseTopology = [
  { phaseId: "plan", dependsOn: [] },
  { phaseId: "build", dependsOn: ["plan"] },
];

function drawnSequence(
  phases: readonly RunGraphNode[] = SEQUENCE,
  topology: PhaseTopology = SEQUENCE_TOPOLOGY,
): DrawnPhaseSequence {
  const layout = layoutPhaseSequence(phases, topology);
  if (layout.status !== "drawn") {
    throw new Error(`expected a drawn sequence, got ${layout.status}`);
  }
  return layout;
}

describe("the renderer's node array", () => {
  it("keys a node by its phase id and hands the phase through untouched", () => {
    const { nodes } = toRunGraphElements(drawnSequence());
    expect(nodes.map((node) => node.id)).toStrictEqual(["plan", "build"]);
    expect(nodes.every((node) => node.type === PHASE_NODE_TYPE)).toBe(true);
    expect(nodes[0]?.data.phase).toBe(SEQUENCE[0]);
  });

  it("states every box's size, so nothing on the canvas waits to be measured", () => {
    // A node without dimensions is hidden until a `ResizeObserver` reports one, and its
    // neighbors move when it does.
    const { nodes } = toRunGraphElements(drawnSequence());
    for (const node of nodes) {
      expect(node.width).toBe(PHASE_NODE_WIDTH_PX);
      expect(node.height).toBe(PHASE_NODE_HEIGHT_PX);
    }
  });

  it("carries the placed position without adjusting it", () => {
    const layout = drawnSequence();
    const { nodes } = toRunGraphElements(layout);
    expect(nodes.map((node) => node.position)).toStrictEqual(
      layout.nodes.map((placed) => ({ x: placed.x, y: placed.y })),
    );
  });
});

describe("the renderer's edge array", () => {
  it("draws one directed edge per declared dependency", () => {
    const { edges } = toRunGraphElements(drawnSequence());
    expect(edges.map((edge) => [edge.source, edge.target])).toStrictEqual([["plan", "build"]]);
    // The arrowhead makes the picture directed for a viewer; the accessible name does the
    // same for a listener.
    expect(edges[0]?.markerEnd).toBeDefined();
  });

  it("names an edge by where it leads, not by the ids it joins", () => {
    const [edge] = drawnSequence().edges;
    if (edge === undefined) {
      throw new Error("the drawn sequence produced no edge");
    }
    const name = sequenceEdgeAccessibleName(edge);
    expect(name).toContain("Build");
    // Negative control: the library's default would read out both wire ids.
    expect(name).not.toContain("plan");
  });
});

describe("what a phase is called out loud", () => {
  it("names the phase, what it is doing, and its gate", () => {
    const name = phaseNodeAccessibleName(
      phase({ phaseId: "build", displayName: "Build", state: "running", gateState: "open" }),
    );
    expect(name).toBe("Build: running, gate open");
  });

  it("announces the identifier where the caller read no name", () => {
    // A sentence has no mono face, so it says the identifier, which is what the box shows.
    // still told the same string.
    const name = phaseNodeAccessibleName(
      phase({ phaseId: "build", displayName: undefined, state: "running", gateState: "open" }),
    );
    expect(name).toBe("build: running, gate open");
    // Negative control: a name that is read is still what gets announced.
    expect(
      phaseNodeAccessibleName(
        phase({ phaseId: "build", displayName: "Build", state: "running", gateState: "open" }),
      ),
    ).not.toContain("build:");
  });

  it("says a phase is parked only while it is parked", () => {
    const parked = phase({
      phaseId: "build",
      displayName: "Build",
      parkAttention: "awaiting-person",
    });
    expect(phaseNodeAccessibleName(parked)).toContain("parked");
    // Negative control: park comes from the park member, not from a state that looks like
    // waiting.
    expect(phaseNodeAccessibleName({ ...parked, parkAttention: undefined })).not.toContain(
      "parked",
    );
    expect(
      phaseNodeAccessibleName({ ...parked, parkAttention: undefined, state: "pending" }),
    ).not.toContain("parked");
  });

  it("says which kind of park it is, so a listener is told what the color says", () => {
    // A listener who cannot see the neutral border must be told the engine will resume this
    // phase and nobody is being asked, not the amber reading of every park.
    const scheduled = phase({ phaseId: "build", displayName: "Build", parkAttention: "scheduled" });
    const awaiting = phase({
      phaseId: "build",
      displayName: "Build",
      parkAttention: "awaiting-person",
    });
    expect(phaseNodeAccessibleName(scheduled)).toContain("resume scheduled");
    expect(phaseNodeAccessibleName(awaiting)).not.toContain("resume scheduled");
    // Negative control: the words come from the table, so the two readings cannot collapse.
    expect(phaseNodeAccessibleName(scheduled)).not.toBe(phaseNodeAccessibleName(awaiting));
  });
});

describe("the element memo", () => {
  it("holds the arrays still while the layout holds still", () => {
    const layout = drawnSequence();
    const { result, rerender } = renderHook(
      (current: DrawnPhaseSequence) => useRunGraphElements(current),
      { initialProps: layout },
    );
    const first = result.current;
    rerender(layout);
    // Reference identity: the renderer re-enters its store when either array moves.
    expect(result.current).toBe(first);
    expect(result.current.nodes).toBe(first.nodes);
    expect(result.current.edges).toBe(first.edges);
  });

  it("negative control: a layout that moved produces different arrays", () => {
    // Without this the case above would pass against a memo that never recomputed.
    const { result, rerender } = renderHook(
      (current: DrawnPhaseSequence) => useRunGraphElements(current),
      { initialProps: drawnSequence() },
    );
    const held = result.current;
    rerender(drawnSequence([...SEQUENCE, phase({ phaseId: "review" })]));
    expect(result.current).not.toBe(held);
    expect(result.current.nodes).toHaveLength(held.nodes.length + 1);
  });
});
