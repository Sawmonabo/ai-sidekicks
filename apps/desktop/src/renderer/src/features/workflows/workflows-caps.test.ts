// The phase graph's zoom range, held to the relations its rationale claims.

import { describe, expect, it } from "vitest";

import { PHASE_GRAPH_MAX_ZOOM, PHASE_GRAPH_MIN_ZOOM } from "./workflows-caps.js";

describe("workflows caps — the phase graph's zoom range", () => {
  it("leaves a range to zoom through", () => {
    // Strictly, not `<=`: an equal pair is a viewport with exactly one scale, which
    // is a graph that answers a zoom gesture by doing nothing. `@xyflow/react` takes
    // both as props and clamps against them, so an inverted pair leaves the graph
    // pinned at one scale with nothing on screen or in a log saying why.
    expect(PHASE_GRAPH_MIN_ZOOM).toBeLessThan(PHASE_GRAPH_MAX_ZOOM);
  });

  it("zooms out from the fitted view and in past it", () => {
    // The fitted view is 1x, and the range is written around it: a floor above 1
    // could not show a long run whole and a ceiling below it could not show a label
    // at reading size. Both halves, because a range entirely on one side of the fit
    // is a range the surface never actually offers.
    expect(PHASE_GRAPH_MIN_ZOOM).toBeLessThan(1);
    expect(PHASE_GRAPH_MAX_ZOOM).toBeGreaterThan(1);
  });
});
