// The browser tier: the run's phase graph occupies its own box, and paints in it. happy-dom
// returns zeroes from every `getBoundingClientRect`, so "the canvas stays inside its wrapper"
// would pass there over a canvas painted past it.
//
// `.meridian-run-graph` takes its content's own minimum so the canvas's floor never overflows
// the wrapper onto whatever follows it. The canvas keeps its declared floor whatever its child
// does, so measuring only the canvas stays green over a graph root that collapsed to nothing
// inside it; the last two cases therefore measure `.react-flow`, the element that paints, and
// the box a phase node lands in.
//
// The graph is mounted as a piece, from a hand-built parked run.

import { describe, expect, it } from "vitest";

import { mountWorkflowRunPhaseGraph } from "../helpers/feature-mounts/workflows.js";
import { awaitRunGraphSettled } from "../helpers/run-graph-settled.js";

import { installMeridianTokens } from "@renderer/app/token-installation.js";

/** One element a case measures, or a throw naming what the graph did not render. */
function requireElement(root: HTMLElement, selector: string): HTMLElement {
  const found = root.querySelector<HTMLElement>(selector);
  if (found === null) {
    throw new Error(`the phase graph rendered no \`${selector}\``);
  }
  return found;
}

/**
 * The mounted graph, waited on until its lazy chunk has painted, through the readiness helper
 * the screenshot and accessibility tiers share so there is one reading of "ready".
 */
async function mountWithPaintedGraph(): Promise<HTMLElement> {
  installMeridianTokens(document);
  const graph = await mountWorkflowRunPhaseGraph();
  await awaitRunGraphSettled(graph);
  return graph;
}

/** The floor the canvas declares, in pixels, read off the cascade so the length has one home. */
function declaredCanvasFloorPx(canvas: HTMLElement): number {
  return Number.parseFloat(getComputedStyle(canvas).getPropertyValue("min-block-size"));
}

describe("browser — the phase graph stays inside its own box", () => {
  it("is contained by the wrapper that is supposed to bound it", async () => {
    const graph = await mountWithPaintedGraph();
    const wrapper = requireElement(graph, ".meridian-run-graph").getBoundingClientRect();
    const canvas = requireElement(graph, ".meridian-run-graph__canvas").getBoundingClientRect();

    // A child painting past its own parent's edge is the mechanism, whatever else the graph grows.
    expect(canvas.bottom).toBeLessThanOrEqual(wrapper.bottom + 0.5);
    expect(canvas.top).toBeGreaterThanOrEqual(wrapper.top - 0.5);
  });

  it("paints the library's own root at the canvas's declared floor, not collapsed", async () => {
    // The root, not the canvas: the canvas keeps its `min-block-size` whatever its child does,
    // while `.react-flow` sizes itself as a percentage of the box above it, which resolves to
    // nothing wherever that box has no definite block size.
    const graph = await mountWithPaintedGraph();
    const canvasElement = requireElement(graph, ".meridian-run-graph__canvas");
    const declaredFloorPx = declaredCanvasFloorPx(canvasElement);
    const paintedRoot = requireElement(graph, ".meridian-run-graph .react-flow");

    expect(declaredFloorPx).toBeGreaterThan(0);
    expect(paintedRoot.getBoundingClientRect().height).toBeGreaterThanOrEqual(
      declaredFloorPx - 0.5,
    );
  });

  it("lands a phase node inside the canvas rather than clipped outside it", async () => {
    // A root of the right height that fitted its picture off the box would pass the case above
    // and still show nothing. The canvas is `overflow: hidden`, so a node outside its rect is
    // invisible.
    const graph = await mountWithPaintedGraph();
    const canvas = requireElement(graph, ".meridian-run-graph__canvas").getBoundingClientRect();
    const nodes = [...graph.querySelectorAll<HTMLElement>(".meridian-run-graph .react-flow__node")];
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
