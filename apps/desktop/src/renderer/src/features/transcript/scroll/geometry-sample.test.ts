// The geometry value's own two rules, asserted without a scroll container: which causes exist,
// and when two samples say the same thing. The machinery that produces samples is tested in
// `scroll-chokepoint.test.ts`.

import { describe, expect, it } from "vitest";

import { TRANSCRIPT_GEOMETRY_EPSILON_PX } from "../viewport/viewport-constants.js";
import {
  GEOMETRY_CHANGE_CAUSES,
  sameSampledGeometry,
  type ScrollGeometry,
} from "./geometry-sample.js";

function sample(overrides: Partial<ScrollGeometry> = {}): ScrollGeometry {
  return {
    scrollTop: 400,
    viewportHeight: 500,
    contentHeight: 5000,
    distanceFromTailPx: 4100,
    isAtTail: false,
    sampledAt: 0,
    cause: "scroll",
    ...overrides,
  };
}

describe("the geometry sample", () => {
  it("declares its causes closed, and names what moved rather than who moved it", () => {
    expect([...GEOMETRY_CHANGE_CAUSES]).toStrictEqual(["scroll", "resize"]);
  });

  it("calls two samples the same when the three numbers agree within the epsilon", () => {
    // Sub-pixel wobble from fractional row heights and the device pixel ratio recurs every
    // frame, and waking every subscriber for it is the render the frame budget avoids.
    const wobble = TRANSCRIPT_GEOMETRY_EPSILON_PX / 2;
    expect(sameSampledGeometry(sample(), sample({ scrollTop: 400 + wobble }))).toBe(true);
    // Provenance is not a difference: the same box at the same offset is the same reading.
    expect(sameSampledGeometry(sample(), sample({ sampledAt: 99, cause: "resize" }))).toBe(true);
  });

  it("negative control: a real change in any one of the three is a difference", () => {
    // Without this the comparison could return `true` unconditionally and suppress every
    // publication rather than every duplicate.
    expect(sameSampledGeometry(sample(), sample({ scrollTop: 480 }))).toBe(false);
    expect(sameSampledGeometry(sample(), sample({ viewportHeight: 260 }))).toBe(false);
    expect(sameSampledGeometry(sample(), sample({ contentHeight: 5200 }))).toBe(false);
  });
});
