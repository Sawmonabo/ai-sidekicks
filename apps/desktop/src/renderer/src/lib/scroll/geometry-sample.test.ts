// When two geometry samples say the same thing, asserted without a scroll container. The
// machinery that produces samples is tested in `scroll-chokepoint.test.ts`.

import { describe, expect, it } from "vitest";

import { sameSampledGeometry, type ScrollGeometry } from "./geometry-sample.js";

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
  it("a real change in any one of the three is a difference", () => {
    // Without this the comparison could return `true` unconditionally and suppress every
    // publication rather than every duplicate.
    expect(sameSampledGeometry(sample(), sample({ scrollTop: 480 }))).toBe(false);
    expect(sameSampledGeometry(sample(), sample({ viewportHeight: 260 }))).toBe(false);
    expect(sameSampledGeometry(sample(), sample({ contentHeight: 5200 }))).toBe(false);
  });
});
