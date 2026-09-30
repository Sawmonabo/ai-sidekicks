// The mount point: the absences it can stand in the box, the picture it draws once the
// renderer arrives, and the gestures the canvas does not offer. The loader is the real one,
// since a synchronous stub would erase the gap under test. Edge geometry is not asserted: the
// DOM shim returns zero for every rect.

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RunGraph } from "./RunGraph.js";
import { runGraphLoader } from "./run-graph-loader.js";
import type { RunGraphNode, PhaseTopology } from "./phase-topology.js";

function phase(overrides: Partial<RunGraphNode> & { readonly phaseId: string }): RunGraphNode {
  return {
    displayName: `Phase ${overrides.phaseId}`,
    state: "pending",
    gateState: "closed",
    parkAttention: undefined,
    ...overrides,
  };
}

const TWO_PHASES: readonly RunGraphNode[] = [
  phase({ phaseId: "plan", displayName: "Plan", state: "completed", gateState: "open" }),
  phase({
    phaseId: "build",
    displayName: "Build",
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
/**
 * Wait for the renderer's chunk to be fetched and every callback registered on it to run.
 *
 * Awaiting the loader's own promise is exact: the component registered its continuation on
 * that promise first, so it has run by the time this settles, and `act` flushes its state.
 */
async function settleGraphLoad(): Promise<void> {
  await act(async () => {
    await runGraphLoader.load();
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
    const { container } = render(<RunGraph phases={[]} label="Phase sequence" />);
    expect(absenceClassName(container)).toContain("meridian-nothing--empty");
    expect(container.querySelector(".react-flow")).toBeNull();
  });

  it("negative control: an empty run is not a read in flight and not a failure", () => {
    // `not-loaded` would say the picture is coming and `error` would say something went wrong;
    // an empty run is a fact about the run.
    // fact about the run.
    const { container } = render(<RunGraph phases={[]} label="Phase sequence" />);
    const className = absenceClassName(container);
    expect(className).not.toContain("meridian-nothing--not-loaded");
    expect(className).not.toContain("meridian-nothing--error");
  });
});

describe("a sequence that cannot be drawn", () => {
  const REPEATED: readonly RunGraphNode[] = [
    phase({ phaseId: "build", displayName: "Build" }),
    phase({ phaseId: "build", displayName: "Build again" }),
  ];

  it("refuses, and names the identifier that repeated", () => {
    const { container } = render(<RunGraph phases={REPEATED} label="Phase sequence" />);
    expect(absenceClassName(container)).toContain("meridian-nothing--error");
    expect(container.textContent).toContain("build");
    expect(container.querySelector(".react-flow")).toBeNull();
  });

  it("negative control: a well-formed sequence is not refused", () => {
    // Without this the refusal above would also fire on any two-phase run.
    const { container } = render(<RunGraph phases={TWO_PHASES} label="Phase sequence" />);
    expect(absenceClassName(container)).not.toContain("meridian-nothing--error");
  });
});

describe("the renderer's code is fetched, not linked", () => {
  it("stands the box in as a read-in-flight absence before the chunk lands", async () => {
    const { container } = render(<RunGraph phases={TWO_PHASES} label="Phase sequence" />);
    // Synchronously after the mount there is no canvas: the module that draws one has not
    // arrived.
    expect(absenceClassName(container)).toContain("meridian-nothing--not-loaded");
    expect(container.querySelector(".react-flow")).toBeNull();

    await settleGraphLoad();

    // Replaced, not joined: a skeleton beside a live graph would read as a second graph loading.
    expect(container.querySelector(".react-flow")).not.toBeNull();
    expect(container.querySelector(".meridian-nothing")).toBeNull();
  });

  it("negative control: the waiting absence is not the kind that would look finished", async () => {
    const { container } = render(<RunGraph phases={TWO_PHASES} label="Phase sequence" />);
    const className = absenceClassName(container);
    expect(className).not.toContain("meridian-nothing--empty");
    expect(className).not.toContain("meridian-nothing--not-checked");
    await settleGraphLoad();
  });
});

describe("the drawn graph", () => {
  it("carries the caller's name on the graph region", async () => {
    const { container } = render(<RunGraph phases={TWO_PHASES} label="Phase sequence" />);
    await settleGraphLoad();
    const region = container.querySelector('[role="application"]');
    expect(region?.getAttribute("aria-label")).toBe("Phase sequence");
  });

  it("draws one keyboard-reachable box per phase, named from the phase", async () => {
    const { container } = render(<RunGraph phases={TWO_PHASES} label="Phase sequence" />);
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
    const { container } = render(<RunGraph phases={TWO_PHASES} label="Phase sequence" />);
    await settleGraphLoad();
    // The library's own marks for the two gestures. With the node count above, an empty result
    // means the nodes are neither draggable nor selectable, not that there are none.
    expect(container.querySelectorAll(".react-flow__node.draggable")).toHaveLength(0);
    expect(container.querySelectorAll(".react-flow__node.selectable")).toHaveLength(0);
  });

  it("says in words that it is drawing states rather than a graph", async () => {
    // A run read carries no dependencies, so without its definition the boxes look like a
    // workflow whose phases depend on nothing; the caption tells the two apart.
    const { container } = render(<RunGraph phases={TWO_PHASES} label="Phase sequence" />);
    await settleGraphLoad();

    // The caption and not the edge count: the shim draws no edge element, and the edge set is
    // asserted over values in the layout and topology suites.
    expect(container.querySelector(".meridian-run-graph__caption")?.textContent ?? "").toContain(
      "has not been read here",
    );
  });

  it("negative control: a graph handed a definition captions nothing", async () => {
    // Without this, a component that captioned every picture would pass.
    const { container } = render(
      <RunGraph phases={TWO_PHASES} topology={TWO_PHASE_TOPOLOGY} label="Phase sequence" />,
    );
    await settleGraphLoad();

    expect(container.querySelector(".meridian-run-graph__caption")).toBeNull();
    expect(container.querySelectorAll(".react-flow__node")).toHaveLength(TWO_PHASES.length);
  });

  it("prints the same words it announces", async () => {
    const { container } = render(<RunGraph phases={TWO_PHASES} label="Phase sequence" />);
    await settleGraphLoad();
    const parked = container.querySelector('.meridian-phase-node[data-park="awaiting-person"]');
    expect(parked?.textContent).toContain("running");
    expect(parked?.textContent).toContain("gate closed");
    expect(parked?.textContent).toContain("parked");
    // Negative control: park is read from the park member, so the unparked phase carries no
    // park attribute and prints no such word.
    const notParked = container.querySelector(".meridian-phase-node:not([data-park])");
    expect(notParked).not.toBeNull();
    expect(notParked?.textContent).not.toContain("parked");
  });

  it("draws the identifier as a wire figure and an authored name as prose", async () => {
    // Every daemon-sent figure renders in mono. A phase id drawn in the face an authored name
    // has would present an opaque key as something a person chose.
    const { container } = render(<RunGraph phases={TWO_PHASES} label="Phase sequence" />);
    await settleGraphLoad();
    const node = container.querySelector('.react-flow__node[data-id="build"]');

    const identifier = node?.querySelector(".meridian-phase-node__id");
    expect(identifier?.querySelector(".meridian-figure--wire")?.textContent).toBe("build");
    // The authored name is not a figure, so putting the whole box in mono fails here.
    const authored = node?.querySelector(".meridian-phase-node__name");
    expect(authored?.textContent).toBe("Build");
    expect(authored?.querySelector(".meridian-figure--wire")).toBeNull();
  });

  it("draws no name element for a phase the caller read no name for", async () => {
    // Nothing stands in for the name: a second copy of the identifier in its place is the
    // invention the name/identifier split exists to stop.
    const nameless: readonly RunGraphNode[] = TWO_PHASES.map((entry) => ({
      ...entry,
      displayName: undefined,
    }));
    const { container } = render(<RunGraph phases={nameless} label="Phase sequence" />);
    await settleGraphLoad();

    expect(container.querySelectorAll(".meridian-phase-node__name")).toHaveLength(0);
    expect(
      container.querySelectorAll(".meridian-phase-node__id .meridian-figure--wire"),
    ).toHaveLength(nameless.length);
  });

  it("draws the state and the gate state as wire figures, and the word gate as prose", async () => {
    // Closed enum values the daemon sent wear the wire signature; the word "gate" does not.
    const { container } = render(<RunGraph phases={TWO_PHASES} label="Phase sequence" />);
    await settleGraphLoad();
    const state = container.querySelector(
      '.react-flow__node[data-id="build"] .meridian-phase-node__state',
    );

    const figures = [...(state?.querySelectorAll(".meridian-figure--wire") ?? [])].map(
      (figure) => figure.textContent,
    );
    expect(figures).toStrictEqual(["running", "closed"]);
    const gate = state?.querySelector(".meridian-phase-node__gate");
    expect(gate?.textContent).toBe("gate closed");
    expect(gate?.firstChild?.textContent).toBe("gate ");
  });

  it("gives a scheduled park a treatment of its own rather than the amber one", async () => {
    // Amber means a person is needed. A phase parked on provider capacity with a readable
    // resume needs nobody, so it must not draw the same border.
    const scheduled: readonly RunGraphNode[] = [
      phase({ phaseId: "plan", displayName: "Plan", state: "completed", gateState: "open" }),
      phase({
        phaseId: "build",
        displayName: "Build",
        state: "running",
        parkAttention: "scheduled",
      }),
    ];
    const { container } = render(<RunGraph phases={scheduled} label="Phase sequence" />);
    await settleGraphLoad();

    expect(container.querySelector('.meridian-phase-node[data-park="awaiting-person"]')).toBeNull();
    const node = container.querySelector('.meridian-phase-node[data-park="scheduled"]');
    expect(node?.textContent).toContain("resume scheduled");
  });
});
