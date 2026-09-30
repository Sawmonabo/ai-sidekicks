// The phase graph's zoom range, held to the relations its rationale claims.

import { describe, expect, it } from "vitest";

import { RUN_GRAPH_MAX_ZOOM, RUN_GRAPH_MIN_ZOOM } from "./workflows-caps.js";

describe("workflows caps — the phase graph's zoom range", () => {
  it("leaves a range to zoom through", () => {
    // An equal pair is a viewport with one scale; `@xyflow/react` clamps against both, so an
    // inverted pair pins the graph at one scale with nothing saying why.
    expect(RUN_GRAPH_MIN_ZOOM).toBeLessThan(RUN_GRAPH_MAX_ZOOM);
  });

  it("zooms out from the fitted view and in past it", () => {
    // The fitted view is 1x: a floor above it cannot show a long run whole, a ceiling below it
    // cannot show a label at reading size.
    expect(RUN_GRAPH_MIN_ZOOM).toBeLessThan(1);
    expect(RUN_GRAPH_MAX_ZOOM).toBeGreaterThan(1);
  });
});
