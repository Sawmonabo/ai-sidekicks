// The intraline diff's two cost bounds, held to the relation their rationales claim.

import { describe, expect, it } from "vitest";

import {
  DIFF_INTRALINE_LINE_CHARACTER_CAP,
  DIFF_INTRALINE_PAIR_CHARACTER_PRODUCT_CAP,
} from "./diff-caps.js";

describe("diff caps — the intraline diff's two cost bounds", () => {
  it("bounds the pair by more than one admissible line can reach alone", () => {
    // A product cap at or below the line cap would make the line cap unreachable, leaving the
    // per-line rationale describing nothing.
    expect(DIFF_INTRALINE_PAIR_CHARACTER_PRODUCT_CAP).toBeGreaterThan(
      DIFF_INTRALINE_LINE_CHARACTER_CAP,
    );
  });

  it("admits a pair of two cap-length lines only if the product allows it", () => {
    // The widest pair the line cap alone admits is its square; the product cap decides
    // whether that pair is computed.
    const widestAdmissiblePair = DIFF_INTRALINE_LINE_CHARACTER_CAP ** 2;
    expect(DIFF_INTRALINE_PAIR_CHARACTER_PRODUCT_CAP).toBeLessThan(widestAdmissiblePair);
  });
});
