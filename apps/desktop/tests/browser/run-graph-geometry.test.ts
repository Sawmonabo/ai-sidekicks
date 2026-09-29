// The browser tier: the run's phase graph occupies its own box, and paints in it.
//
// A DOM shim cannot answer this one at all. happy-dom returns zeroes from every
// `getBoundingClientRect`, so "the canvas stays inside its wrapper" passes there over a
// canvas painted past it — which is exactly the state this file exists to prevent.
//
// THE CANVAS KEEPS A FLOOR. `.meridian-phase-graph` takes its content's own minimum, so
// the canvas's floor never overflows the wrapper's edge onto whatever follows it; these
// cases measure that in a real layout engine rather than asserting it about a
// stylesheet's text.
//
// AND THE ROOT MUST PAINT AT THAT FLOOR. The canvas keeps its declared floor whatever
// its child does, so a case that measured only the CANVAS stays green over a graph
// library root that collapsed to nothing inside it: a 20rem sunken box with no phase,
// no connector and no attribution plate in it. So the last two cases measure
// `.react-flow`, the element that actually paints, and the box a phase node lands in —
// the two readings a collapsed root cannot satisfy.
//
// The graph is mounted as a piece, from a hand-built parked run, because no surface
// composes it until the run read is built.

import { describe, expect, it } from "vitest";

import { mountWorkflowRunPhaseGraph } from "../helpers/feature-mounts/workflows.js";
import { awaitRunGraphSettled } from "../helpers/run-graph-settled.js";

import { installMeridianTokens } from "@renderer/console/frame/index.js";

/** One element a case measures, or a throw naming what the surface did not render. */
function requireElement(root: HTMLElement, selector: string): HTMLElement {
  const found = root.querySelector<HTMLElement>(selector);
  if (found === null) {
    throw new Error(`the phase graph rendered no \`${selector}\``);
  }
  return found;
}

/**
 * The mounted graph, waited on until its lazy chunk has painted.
 *
 * Through the readiness helper the screenshot and accessibility tiers wait on rather
 * than a wait of this file's own: a second reading of when a graph is ready is a second
 * thing to keep true.
 */
async function mountWithPaintedGraph(): Promise<HTMLElement> {
  installMeridianTokens(document);
  const graph = await mountWorkflowRunPhaseGraph();
  await awaitRunGraphSettled(graph);
  return graph;
}

/**
 * The floor the canvas declares, in pixels, read off the cascade.
 *
 * A test that wrote `20rem` would be a second home for a length the stylesheet already
 * declares once, and it would keep passing after the declaration moved.
 */
function declaredCanvasFloorPx(canvas: HTMLElement): number {
  return Number.parseFloat(getComputedStyle(canvas).getPropertyValue("min-block-size"));
}

describe("browser — the phase graph stays inside its own box", () => {
  it("is contained by the wrapper that is supposed to bound it", async () => {
    const graph = await mountWithPaintedGraph();
    const wrapper = requireElement(graph, ".meridian-phase-graph").getBoundingClientRect();
    const canvas = requireElement(graph, ".meridian-phase-graph__canvas").getBoundingClientRect();

    // Said about the pair rather than about a sibling: whatever else the surface
    // grows, a child painting past its own parent's edge is the mechanism.
    expect(canvas.bottom).toBeLessThanOrEqual(wrapper.bottom + 0.5);
    expect(canvas.top).toBeGreaterThanOrEqual(wrapper.top - 0.5);
  });

  it("paints the library's own root at the canvas's declared floor, not collapsed", async () => {
    // THE ROOT AND NOT THE CANVAS. The canvas keeps its `min-block-size` whatever its
    // child does, so a case measuring it is green over an empty box; `.react-flow` is
    // the element whose height decides whether anything is drawn, and it sizes itself
    // as a percentage of the box above it — which resolves to nothing wherever that
    // box has no definite block size of its own.
    const graph = await mountWithPaintedGraph();
    const canvasElement = requireElement(graph, ".meridian-phase-graph__canvas");
    const declaredFloorPx = declaredCanvasFloorPx(canvasElement);
    const paintedRoot = requireElement(graph, ".meridian-phase-graph .react-flow");

    expect(declaredFloorPx).toBeGreaterThan(0);
    expect(paintedRoot.getBoundingClientRect().height).toBeGreaterThanOrEqual(
      declaredFloorPx - 0.5,
    );
  });

  it("lands a phase node inside the canvas rather than clipped outside it", async () => {
    // The other half of the same claim, and the one a person actually looks for: a
    // root of the right height that fitted its picture somewhere off the box would
    // satisfy the case above and still show an operator nothing. The canvas is
    // `overflow: hidden`, so a node outside its rect is a node nobody can see.
    const graph = await mountWithPaintedGraph();
    const canvas = requireElement(graph, ".meridian-phase-graph__canvas").getBoundingClientRect();
    const nodes = [
      ...graph.querySelectorAll<HTMLElement>(".meridian-phase-graph .react-flow__node"),
    ];
    expect(nodes.length).toBeGreaterThan(0);

    const insideCanvas = nodes.filter((node) => {
      const box = node.getBoundingClientRect();
      return (
        box.height > 0 &&
        box.width > 0 &&
        box.top >= canvas.top - 0.5 &&
        box.bottom <= canvas.bottom + 0.5 &&
        box.left >= canvas.left - 0.5 &&
        box.right <= canvas.right + 0.5
      );
    });
    expect(insideCanvas.length).toBeGreaterThan(0);
  });
});
