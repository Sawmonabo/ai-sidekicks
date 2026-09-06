// The browser tier: the run pane's phase graph occupies its own box, and paints in it.
//
// A DOM shim cannot answer this one at all. happy-dom returns zeroes from every
// `getBoundingClientRect`, so "the canvas ends before the first park card begins"
// passes there over a canvas painted on top of the card — which is exactly the state
// this file exists to prevent, and exactly the state the unit tier could not see.
//
// WHAT WENT WRONG, STATED AS GEOMETRY. `.meridian-phase-graph` is one of several
// children competing for the bounded height of a scrolling surface, and it carried
// `flex: 1` with `min-block-size: 0` — the ordinary "this item may give up space"
// pair. Its canvas carries a floor and keeps painting at it, so once the wrapper was
// squeezed under that floor the canvas overflowed its own bottom edge and covered
// the first park card: a graph sitting on top of the one thing the pane exists to
// surface. The wrapper now takes its content's own minimum, and these cases measure
// that in a real layout engine rather than asserting it about a stylesheet's text.
//
// AND WHAT WENT WRONG NEXT, WHICH THE BOX CASES ABOVE COULD NOT SEE. The canvas keeps
// its declared floor whatever its child does, so every case that measured the CANVAS
// stayed green over a graph library root that had collapsed to nothing inside it: a
// 20rem sunken box with no phase, no connector and no attribution plate in it, which
// is what a committed screenshot reference recorded. So the two cases below measure
// `.react-flow`, the element that actually paints, and the box a phase node lands in
// — the two readings a collapsed root cannot satisfy.

import { describe, expect, it } from "vitest";

import { mountWorkflowParkedRunPane } from "../surfaces/workflows.js";
import { awaitPhaseGraphSettled } from "../phase-graph-settled.js";

import { installMeridianTokens } from "../../../src/renderer/src/console/frame/index.js";

/** One element a case measures, or a throw naming what the surface did not render. */
function requireElement(root: HTMLElement, selector: string): HTMLElement {
  const found = root.querySelector<HTMLElement>(selector);
  if (found === null) {
    throw new Error(`the run pane rendered no \`${selector}\``);
  }
  return found;
}

/**
 * The mounted run pane, waited on until the lazy graph chunk has painted.
 *
 * The shared mount waits for the parks, which land from the run read; the canvas
 * arrives later still, on the graph module's own chunk, and is then fitted. Through
 * the readiness helper the screenshot and accessibility tiers already wait on rather
 * than a wait of this file's own: a second reading of when a graph is ready is a
 * second thing to keep true, and the one next door is the one a capture trusts.
 */
async function mountWithPaintedGraph(): Promise<HTMLElement> {
  installMeridianTokens(document);
  const mounted = await mountWorkflowParkedRunPane();
  await awaitPhaseGraphSettled(mounted.element);
  return mounted.element;
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
  it("ends above the first park card rather than painting over it", async () => {
    const pane = await mountWithPaintedGraph();
    const canvas = requireElement(pane, ".meridian-phase-graph__canvas").getBoundingClientRect();
    const firstPark = requireElement(pane, ".meridian-park").getBoundingClientRect();

    // The defect, as the one number that stated it: the canvas's bottom edge sat
    // below the top of the card that follows it in the flow.
    expect(canvas.bottom).toBeLessThanOrEqual(firstPark.top);
  });

  it("is contained by the wrapper that is supposed to bound it", async () => {
    const pane = await mountWithPaintedGraph();
    const wrapper = requireElement(pane, ".meridian-phase-graph").getBoundingClientRect();
    const canvas = requireElement(pane, ".meridian-phase-graph__canvas").getBoundingClientRect();

    // Said about the pair rather than about a sibling: whatever else the surface
    // grows, a child painting past its own parent's edge is the mechanism, and a
    // pane that later put nothing after the graph would hide the case above.
    expect(canvas.bottom).toBeLessThanOrEqual(wrapper.bottom + 0.5);
    expect(canvas.top).toBeGreaterThanOrEqual(wrapper.top - 0.5);
  });

  it("paints the library's own root at the canvas's declared floor, not collapsed", async () => {
    // THE ROOT AND NOT THE CANVAS. The canvas keeps its `min-block-size` whatever its
    // child does, so a case measuring it is green over an empty box; `.react-flow` is
    // the element whose height decides whether anything is drawn, and it sizes itself
    // as a percentage of the box above it — which resolves to nothing wherever that
    // box has no definite block size of its own.
    const pane = await mountWithPaintedGraph();
    const canvasElement = requireElement(pane, ".meridian-phase-graph__canvas");
    const declaredFloorPx = declaredCanvasFloorPx(canvasElement);
    const paintedRoot = requireElement(pane, ".meridian-phase-graph .react-flow");

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
    const pane = await mountWithPaintedGraph();
    const canvas = requireElement(pane, ".meridian-phase-graph__canvas").getBoundingClientRect();
    const nodes = [
      ...pane.querySelectorAll<HTMLElement>(".meridian-phase-graph .react-flow__node"),
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
