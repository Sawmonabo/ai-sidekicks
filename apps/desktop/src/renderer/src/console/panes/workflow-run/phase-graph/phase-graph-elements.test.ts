// The translation into the renderer's shapes: identity, stated dimensions, and the
// words a reader who is not looking at the canvas is given.
//
// The memo case uses the real hook against the real layout objects rather than a
// stand-in, because the property under test is exactly that a layout the cache held
// still produces arrays the renderer holds still.

import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  PHASE_NODE_HEIGHT_PX,
  PHASE_NODE_WIDTH_PX,
  type DrawnPhaseSequence,
  type PhaseGraphNode,
  layoutPhaseSequence,
} from "./phase-sequence-layout.js";
import {
  PHASE_NODE_TYPE,
  phaseNodeAccessibleName,
  sequenceEdgeAccessibleName,
  toPhaseGraphElements,
  usePhaseGraphElements,
} from "./phase-graph-elements.js";

function phase(overrides: Partial<PhaseGraphNode> & { readonly phaseId: string }): PhaseGraphNode {
  return {
    label: `Phase ${overrides.phaseId}`,
    state: "pending",
    gateState: "closed",
    isParked: false,
    ...overrides,
  };
}

const SEQUENCE: readonly PhaseGraphNode[] = [
  phase({ phaseId: "plan", label: "Plan", state: "completed", gateState: "open" }),
  phase({ phaseId: "build", label: "Build", state: "running" }),
];

function drawnSequence(phases: readonly PhaseGraphNode[] = SEQUENCE): DrawnPhaseSequence {
  const layout = layoutPhaseSequence(phases);
  if (layout.status !== "drawn") {
    throw new Error(`expected a drawn sequence, got ${layout.status}`);
  }
  return layout;
}

describe("the renderer's node array", () => {
  it("keys a node by its phase id and hands the phase through untouched", () => {
    const { nodes } = toPhaseGraphElements(drawnSequence());
    expect(nodes.map((node) => node.id)).toStrictEqual(["plan", "build"]);
    expect(nodes.every((node) => node.type === PHASE_NODE_TYPE)).toBe(true);
    expect(nodes[0]?.data.phase).toBe(SEQUENCE[0]);
  });

  it("states every box's size, so nothing on the canvas waits to be measured", () => {
    // A node without dimensions is drawn hidden until a `ResizeObserver` reports
    // one, and its neighbours move when it does. Both are the reasons the layout
    // owns these numbers rather than the browser.
    const { nodes } = toPhaseGraphElements(drawnSequence());
    for (const node of nodes) {
      expect(node.width).toBe(PHASE_NODE_WIDTH_PX);
      expect(node.height).toBe(PHASE_NODE_HEIGHT_PX);
    }
  });

  it("carries the placed position without adjusting it", () => {
    const layout = drawnSequence();
    const { nodes } = toPhaseGraphElements(layout);
    expect(nodes.map((node) => node.position)).toStrictEqual(
      layout.nodes.map((placed) => ({ x: placed.x, y: placed.y })),
    );
  });
});

describe("the renderer's edge array", () => {
  it("draws one directed edge per adjacent pair", () => {
    const { edges } = toPhaseGraphElements(drawnSequence());
    expect(edges.map((edge) => [edge.source, edge.target])).toStrictEqual([["plan", "build"]]);
    // The arrowhead is what makes the picture directed for a reader who is looking
    // at it; the accessible name does the same job for one who is not.
    expect(edges[0]?.markerEnd).toBeDefined();
  });

  it("names an edge by where it leads, not by the ids it joins", () => {
    const [edge] = drawnSequence().edges;
    if (edge === undefined) {
      throw new Error("the drawn sequence produced no edge");
    }
    const name = sequenceEdgeAccessibleName(edge);
    expect(name).toContain("Build");
    // Negative control: the library's own default would read out both wire ids,
    // which is the outcome this function exists to replace.
    expect(name).not.toContain("plan");
  });
});

describe("what a phase is called out loud", () => {
  it("names the phase, what it is doing, and its gate", () => {
    const name = phaseNodeAccessibleName(
      phase({ phaseId: "build", label: "Build", state: "running", gateState: "open" }),
    );
    expect(name).toBe("Build: running, gate open");
  });

  it("says a phase is parked only while it is parked", () => {
    const parked = phase({ phaseId: "build", label: "Build", isParked: true });
    expect(phaseNodeAccessibleName(parked)).toContain("parked");
    // Negative control: park is read from the park member and never inferred from a
    // state that merely looks like waiting.
    expect(phaseNodeAccessibleName({ ...parked, isParked: false })).not.toContain("parked");
    expect(phaseNodeAccessibleName({ ...parked, isParked: false, state: "pending" })).not.toContain(
      "parked",
    );
  });
});

describe("the element memo", () => {
  it("holds the arrays still while the layout holds still", () => {
    const layout = drawnSequence();
    const { result, rerender } = renderHook(
      (current: DrawnPhaseSequence) => usePhaseGraphElements(current),
      { initialProps: layout },
    );
    const first = result.current;
    rerender(layout);
    // Reference identity: the renderer re-enters its store when either array moves,
    // so a fresh array on an unchanged run is work nobody asked for.
    expect(result.current).toBe(first);
    expect(result.current.nodes).toBe(first.nodes);
    expect(result.current.edges).toBe(first.edges);
  });

  it("negative control: a layout that moved produces different arrays", () => {
    // Without this the case above would pass against a memo that never recomputed,
    // which would leave the canvas showing the first run it was ever handed.
    const { result, rerender } = renderHook(
      (current: DrawnPhaseSequence) => usePhaseGraphElements(current),
      { initialProps: drawnSequence() },
    );
    const held = result.current;
    rerender(drawnSequence([...SEQUENCE, phase({ phaseId: "review" })]));
    expect(result.current).not.toBe(held);
    expect(result.current.nodes).toHaveLength(held.nodes.length + 1);
  });
});
