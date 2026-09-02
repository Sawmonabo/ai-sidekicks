// The mount point: the four absences it can stand in the box, the picture it draws
// once the renderer's code arrives, and the gestures that surface does not offer.
//
// THE LOADER IS THE REAL ONE. A stub that resolved the canvas synchronously would
// test a component that does not exist — the whole point of the arrangement is that
// the renderer arrives a commit later than the mount, and a substitute that erased
// that gap would pass over the bug it exists to catch.
//
// WHAT THIS FILE ASSERTS ABOUT THE CANVAS AND WHAT IT DOES NOT. The read-only claim
// is asserted through the classes the library itself puts on a node — `draggable`
// and `selectable` are its own marks for the two gestures, so reading them reads the
// library's state rather than restating the props we passed. Edge GEOMETRY is not
// asserted here: this tier runs under a DOM shim that returns zero for every rect,
// so where an edge is drawn is not a question it can answer. The edge SET is the
// layout module's subject and is asserted there, over values rather than pixels.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PhaseGraph } from "./PhaseGraph.js";
import { phaseGraphLoader } from "./phase-graph-loader.js";
import type { PhaseGraphNode, PhaseTopology } from "./phase-topology.js";

function phase(overrides: Partial<PhaseGraphNode> & { readonly phaseId: string }): PhaseGraphNode {
  return {
    label: `Phase ${overrides.phaseId}`,
    state: "pending",
    gateState: "closed",
    parkAttention: undefined,
    ...overrides,
  };
}

const TWO_PHASES: readonly PhaseGraphNode[] = [
  phase({ phaseId: "plan", label: "Plan", state: "completed", gateState: "open" }),
  phase({
    phaseId: "build",
    label: "Build",
    state: "running",
    parkAttention: "awaiting-person",
  }),
];

/** The definition those two phases were run from, for the arm that has one. */
const TWO_PHASE_TOPOLOGY: PhaseTopology = [
  { phaseId: "plan", dependsOn: [] },
  { phaseId: "build", dependsOn: ["plan"] },
];

/**
 * Wait for the renderer's chunk to have been fetched AND for every callback
 * registered on it to have run.
 *
 * Awaiting the loader's own promise is what makes the wait exact rather than a
 * guessed number of ticks: the component registered its continuation on that same
 * promise first, so by the time this one settles the component's has already run,
 * and `act` flushes the state it set.
 */
async function settleGraphLoad(): Promise<void> {
  await act(async () => {
    await phaseGraphLoader.load();
  });
}

function absenceClassName(container: HTMLElement): string {
  const absence = container.querySelector(".meridian-nothing");
  if (absence === null) {
    throw new Error("the graph rendered no absence");
  }
  return absence.className;
}

describe("a run with nothing to draw", () => {
  it("says the run has no phases rather than drawing an empty canvas", () => {
    const { container } = render(<PhaseGraph phases={[]} label="Phase sequence" />);
    expect(absenceClassName(container)).toContain("meridian-nothing--empty");
    expect(container.querySelector(".react-flow")).toBeNull();
  });

  it("negative control: an empty run is not a read in flight and not a failure", () => {
    // `not-loaded` would say the picture is coming and `error` would say something
    // went wrong. Both are claims about this console; the run having no phases is a
    // fact about the run.
    const { container } = render(<PhaseGraph phases={[]} label="Phase sequence" />);
    const className = absenceClassName(container);
    expect(className).not.toContain("meridian-nothing--not-loaded");
    expect(className).not.toContain("meridian-nothing--error");
  });
});

describe("a sequence that cannot be drawn", () => {
  const REPEATED: readonly PhaseGraphNode[] = [
    phase({ phaseId: "build", label: "Build" }),
    phase({ phaseId: "build", label: "Build again" }),
  ];

  it("refuses, and names the identifier that repeated", () => {
    const { container } = render(<PhaseGraph phases={REPEATED} label="Phase sequence" />);
    expect(absenceClassName(container)).toContain("meridian-nothing--error");
    expect(container.textContent).toContain("build");
    expect(container.querySelector(".react-flow")).toBeNull();
  });

  it("negative control: a well-formed sequence is not refused", () => {
    // Without this the refusal above would also fire on a run that merely has two
    // phases, and no run would ever draw.
    const { container } = render(<PhaseGraph phases={TWO_PHASES} label="Phase sequence" />);
    expect(absenceClassName(container)).not.toContain("meridian-nothing--error");
  });
});

describe("the renderer's code is fetched, not linked", () => {
  it("stands the box in as a read-in-flight absence before the chunk lands", async () => {
    const { container } = render(<PhaseGraph phases={TWO_PHASES} label="Phase sequence" />);
    // Synchronously after the mount there is no canvas, because the module that
    // draws one has not arrived.
    expect(absenceClassName(container)).toContain("meridian-nothing--not-loaded");
    expect(container.querySelector(".react-flow")).toBeNull();

    await settleGraphLoad();

    // And once it lands the absence is replaced by the canvas rather than joined by
    // it: a skeleton left beside a live graph would read as a second graph loading.
    expect(container.querySelector(".react-flow")).not.toBeNull();
    expect(container.querySelector(".meridian-nothing")).toBeNull();
  });

  it("negative control: the waiting absence is not the kind that would look finished", async () => {
    const { container } = render(<PhaseGraph phases={TWO_PHASES} label="Phase sequence" />);
    const className = absenceClassName(container);
    expect(className).not.toContain("meridian-nothing--empty");
    expect(className).not.toContain("meridian-nothing--not-checked");
    await settleGraphLoad();
  });
});

describe("the drawn graph", () => {
  it("carries the caller's name on the graph region", async () => {
    const { container } = render(<PhaseGraph phases={TWO_PHASES} label="Phase sequence" />);
    await settleGraphLoad();
    const region = container.querySelector('[role="application"]');
    expect(region?.getAttribute("aria-label")).toBe("Phase sequence");
  });

  it("draws one keyboard-reachable box per phase, named from the phase", async () => {
    const { container } = render(<PhaseGraph phases={TWO_PHASES} label="Phase sequence" />);
    await settleGraphLoad();
    const nodes = [...container.querySelectorAll(".react-flow__node")];
    expect(nodes).toHaveLength(TWO_PHASES.length);
    expect(nodes.map((node) => node.getAttribute("tabindex"))).toStrictEqual(["0", "0"]);
    expect(nodes.map((node) => node.getAttribute("aria-label"))).toStrictEqual([
      "Plan: completed, gate open",
      "Build: running, gate closed, parked",
    ]);
  });

  it("offers no gesture that would change the run", async () => {
    const { container } = render(<PhaseGraph phases={TWO_PHASES} label="Phase sequence" />);
    await settleGraphLoad();
    // The library's own marks for the two gestures. Read together with the count
    // above, an empty result here means the nodes are there and neither draggable
    // nor selectable — rather than that there are no nodes at all.
    expect(container.querySelectorAll(".react-flow__node.draggable")).toHaveLength(0);
    expect(container.querySelectorAll(".react-flow__node.selectable")).toHaveLength(0);
  });

  it("says in words that it is drawing states rather than a graph", async () => {
    // A run read carries no dependencies, so a graph mounted without its definition
    // paints disconnected boxes — which on screen is indistinguishable from a
    // workflow whose phases genuinely depend on nothing. The caption is the only
    // thing that tells those two apart.
    const { container } = render(<PhaseGraph phases={TWO_PHASES} label="Phase sequence" />);
    await settleGraphLoad();

    // The caption and not the edge count, on this file's own rule: the shim returns
    // zero for every rect and the library draws no edge element under it, so the
    // edge SET is asserted over values in the layout and topology suites beside this
    // one. What this tier can see is whether the surface tells a person which
    // picture they are looking at.
    expect(container.querySelector(".meridian-phase-graph__caption")?.textContent ?? "").toContain(
      "has not been read here",
    );
  });

  it("negative control: a graph handed a definition captions nothing", async () => {
    // Without this the case above would pass over a component that captioned every
    // picture, which would tell a person their definition had not been read on the
    // one surface where it had.
    const { container } = render(
      <PhaseGraph phases={TWO_PHASES} topology={TWO_PHASE_TOPOLOGY} label="Phase sequence" />,
    );
    await settleGraphLoad();

    expect(container.querySelector(".meridian-phase-graph__caption")).toBeNull();
    expect(container.querySelectorAll(".react-flow__node")).toHaveLength(TWO_PHASES.length);
  });

  it("prints the same words it announces", async () => {
    const { container } = render(<PhaseGraph phases={TWO_PHASES} label="Phase sequence" />);
    await settleGraphLoad();
    const parked = container.querySelector('.meridian-phase-node[data-park="awaiting-person"]');
    expect(parked?.textContent).toContain("running");
    expect(parked?.textContent).toContain("gate closed");
    expect(parked?.textContent).toContain("parked");
    // Negative control: park is read from the park member, so the phase that is not
    // parked carries no park attribute at all and prints no such word.
    const notParked = container.querySelector(".meridian-phase-node:not([data-park])");
    expect(notParked).not.toBeNull();
    expect(notParked?.textContent).not.toContain("parked");
  });

  it("gives a scheduled park a treatment of its own rather than the amber one", async () => {
    // Rule 3 spends amber on a person being needed. A phase parked on provider
    // capacity that the engine armed a readable resume for needs nobody, and drawing
    // it in the same border as one waiting on a person is the pane asking for
    // attention nothing is owed.
    const scheduled: readonly PhaseGraphNode[] = [
      phase({ phaseId: "plan", label: "Plan", state: "completed", gateState: "open" }),
      phase({ phaseId: "build", label: "Build", state: "running", parkAttention: "scheduled" }),
    ];
    const { container } = render(<PhaseGraph phases={scheduled} label="Phase sequence" />);
    await settleGraphLoad();

    expect(container.querySelector('.meridian-phase-node[data-park="awaiting-person"]')).toBeNull();
    const node = container.querySelector('.meridian-phase-node[data-park="scheduled"]');
    expect(node?.textContent).toContain("resume scheduled");
  });
});
