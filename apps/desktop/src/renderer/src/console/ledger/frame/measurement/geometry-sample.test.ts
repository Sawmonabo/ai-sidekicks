// The geometry value's own two rules, asserted rather than driven.
//
// Both are about the VALUE — which causes exist, and when two samples say the same
// thing — so neither needs a surface, a listener or a frame. The machinery that
// produces samples is `scroll-chokepoint.test.ts`'.

import { describe, expect, it } from "vitest";

import { LEDGER_GEOMETRY_EPSILON_PX } from "../frame-bounds.js";
import {
  LEDGER_GEOMETRY_CAUSES,
  sameSampledGeometry,
  type LedgerGeometry,
} from "./geometry-sample.js";

function sample(overrides: Partial<LedgerGeometry> = {}): LedgerGeometry {
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
    expect([...LEDGER_GEOMETRY_CAUSES]).toStrictEqual(["scroll", "resize"]);
  });

  it("calls two samples the same when the three numbers agree within the epsilon", () => {
    // Sub-pixel wobble is what a fractional row height and a device pixel ratio
    // produce every frame, and waking every subscriber for it is the render this
    // frame's budget exists to avoid.
    const wobble = LEDGER_GEOMETRY_EPSILON_PX / 2;
    expect(sameSampledGeometry(sample(), sample({ scrollTop: 400 + wobble }))).toBe(true);
    // Provenance is not a difference: the same box at the same offset is the same
    // reading whether a resize or a scroll went looking for it.
    expect(sameSampledGeometry(sample(), sample({ sampledAt: 99, cause: "resize" }))).toBe(true);
  });

  it("negative control: a real change in any one of the three is a difference", () => {
    // Without this the comparison could be returning `true` unconditionally, and
    // every publication would be suppressed rather than every duplicate.
    expect(sameSampledGeometry(sample(), sample({ scrollTop: 480 }))).toBe(false);
    expect(sameSampledGeometry(sample(), sample({ viewportHeight: 260 }))).toBe(false);
    expect(sameSampledGeometry(sample(), sample({ contentHeight: 5200 }))).toBe(false);
  });
});
