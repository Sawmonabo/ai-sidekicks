// The intraline diff's two cost bounds, held to the relation their rationales claim.

import { describe, expect, it } from "vitest";

import {
  DIFF_INTRALINE_LINE_CHARACTER_CAP,
  DIFF_INTRALINE_PAIR_CHARACTER_PRODUCT_CAP,
} from "./diff-caps.js";

describe("diff caps — the intraline diff's two cost bounds", () => {
  it("bounds the pair by more than one admissible line can reach alone", () => {
    // The line cap bounds ONE side; the product cap bounds what the algorithm is
    // actually quadratic in. A product cap at or below the line cap would make the
    // line cap unreachable, so the pair bound would be the only one that ever fired
    // and the per-line rationale would describe nothing.
    expect(DIFF_INTRALINE_PAIR_CHARACTER_PRODUCT_CAP).toBeGreaterThan(
      DIFF_INTRALINE_LINE_CHARACTER_CAP,
    );
  });

  it("admits a pair of two cap-length lines only if the product allows it", () => {
    // The two bounds are checkable against each other rather than by eye: the widest
    // pair the line cap alone admits is the square of it, and whether that pair is
    // computed is the product cap's answer and not a second reading of the first.
    const widestAdmissiblePair = DIFF_INTRALINE_LINE_CHARACTER_CAP ** 2;
    expect(DIFF_INTRALINE_PAIR_CHARACTER_PRODUCT_CAP).toBeLessThan(widestAdmissiblePair);
  });
});
