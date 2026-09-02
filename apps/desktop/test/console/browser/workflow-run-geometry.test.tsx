// The browser tier: the run pane's phase graph occupies its own box and no other.
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
// THE FLOOR IS READ OFF THE CASCADE AND NOT RESTATED. A test that wrote `20rem`
// would be a second home for a length the stylesheet already declares once, and it
// would keep passing after the declaration moved.

import { describe, expect, it } from "vitest";

import { waitFor } from "@testing-library/react";

import { mountWorkflowParkedRunPane } from "../workflow-surfaces.js";

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
 * arrives later still, on the graph module's own chunk. A case that measured before
 * it landed would measure the absence block instead and pass on nothing.
 */
async function mountWithPaintedGraph(): Promise<HTMLElement> {
  installMeridianTokens(document);
  const mounted = await mountWorkflowParkedRunPane();
  await waitFor(() => {
    requireElement(mounted.element, ".meridian-phase-graph__canvas");
  });
  return mounted.element;
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

  it("negative control: the canvas is painted at its declared floor, not collapsed", async () => {
    // Without this, both cases above pass over a canvas of zero height — which
    // would be inside anything and above everything, and would show an operator no
    // graph at all. The floor is read from the cascade, so it tracks the one place
    // the stylesheet declares it.
    const pane = await mountWithPaintedGraph();
    const canvasElement = requireElement(pane, ".meridian-phase-graph__canvas");
    const declaredFloorPx = Number.parseFloat(
      getComputedStyle(canvasElement).getPropertyValue("min-block-size"),
    );

    expect(declaredFloorPx).toBeGreaterThan(0);
    expect(canvasElement.getBoundingClientRect().height).toBeGreaterThanOrEqual(
      declaredFloorPx - 0.5,
    );
  });
});
