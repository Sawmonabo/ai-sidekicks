// How many placeholders the opening bar draws.
//
// Three clauses over one integer — a floor, a cap, and the caller's number between
// them — driven directly rather than through a render, because asserting arithmetic
// by counting DOM nodes tests React's list rendering to establish a `Math.min`.
// `CastBar.test.tsx` covers the rendering half, which is a different claim.

import { describe, expect, it } from "vitest";

import { CAST_BAR_CHIP_CAP } from "../../core/index.js";
import { skeletonChipCount } from "./CastBarSkeleton.js";

describe("the opening bar's placeholder count", () => {
  it("draws one per member the caller was told about", () => {
    expect(skeletonChipCount(3)).toBe(3);
  });

  it("never draws none, whatever the caller says", () => {
    // A session always has the participant who owns it, so zero is not a session and
    // a bar of no height is the jump this whole surface exists to prevent.
    expect(skeletonChipCount(0)).toBe(1);
    expect(skeletonChipCount(-4)).toBe(1);
    expect(skeletonChipCount(undefined)).toBe(1);
    expect(skeletonChipCount(Number.NaN)).toBe(1);
  });

  it("never draws wider than the bar it stands in for", () => {
    // Past the cap the real bar folds into "+N", so a skeleton that kept counting
    // would be wider than the thing it is holding a place for — which is the height
    // jump again, in the other direction.
    expect(skeletonChipCount(CAST_BAR_CHIP_CAP + 5)).toBe(CAST_BAR_CHIP_CAP);
  });

  it("negative control: it is not a constant", () => {
    // Without this, every case above would pass over a function that answered one
    // always — which draws a single pill for a nine-person session and moves the
    // whole deck the moment the roster lands.
    expect(skeletonChipCount(2)).not.toBe(skeletonChipCount(5));
  });

  it("takes the whole part of a fractional count rather than rounding up", () => {
    // The count comes off a wire member typed as a number; a rounded-up half would
    // draw a placeholder for a member that does not exist.
    expect(skeletonChipCount(2.9)).toBe(2);
  });
});
