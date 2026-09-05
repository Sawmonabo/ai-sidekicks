// The family's named bounds, held to what their own rationales claim.
//
// `core/constants.test.ts` states the posture and this file applies it to one more
// module: the checkable content of a constants module is not the numbers but the
// RELATIONS between them, because a bound that drifts past its neighbour does not
// fail loudly — it quietly stops meaning anything. A zoom range whose floor has risen
// above its ceiling is the shape here: `@xyflow/react` takes both as props and clamps
// against them, so an inverted pair leaves the graph pinned at one scale with nothing
// on screen or in a log saying why.

import { describe, expect, it } from "vitest";

import {
  PHASE_GRAPH_MAX_ZOOM,
  PHASE_GRAPH_MIN_ZOOM,
  WORKFLOW_CANCEL_REASON_BYTE_CAP,
} from "./constants.js";

describe("the workflows family's bounds", () => {
  it("leaves the phase graph a range to zoom through", () => {
    // Strictly, not `<=`: an equal pair is a viewport with exactly one scale, which is
    // a graph that answers a zoom gesture by doing nothing.
    expect(PHASE_GRAPH_MIN_ZOOM).toBeLessThan(PHASE_GRAPH_MAX_ZOOM);
  });

  it("zooms out from the fitted view and in past it", () => {
    // The fitted view is 1×, and the range is written around it: a floor above 1 could
    // not show a long run whole and a ceiling below it could not show a label at
    // reading size. Both halves, because a range entirely on one side of the fit is a
    // range the surface never actually offers.
    expect(PHASE_GRAPH_MIN_ZOOM).toBeLessThan(1);
    expect(PHASE_GRAPH_MAX_ZOOM).toBeGreaterThan(1);
  });

  it("bounds a cancellation reason at a whole positive count of bytes", () => {
    // A fractional or zero cap admits no sentence at all, and the refusal a person
    // would read names the figure — so a bound of 0 renders as an instruction to
    // shorten a reason to nothing.
    expect(WORKFLOW_CANCEL_REASON_BYTE_CAP).toBeGreaterThan(0);
    expect(Number.isInteger(WORKFLOW_CANCEL_REASON_BYTE_CAP)).toBe(true);
  });
});
