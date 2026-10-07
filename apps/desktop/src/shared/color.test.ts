// The contrast measurement every floor check leans on. A measurement that answered a large
// constant, or scaled every ratio up, would pass every floor; the two ends of the scale pin it.

import { describe, expect, it } from "vitest";

import { contrastRatio } from "./color.js";

describe("contrastRatio", () => {
  it("reads 21:1 for black on white and under 1.2:1 for two close grays", () => {
    const black = { red: 0, green: 0, blue: 0 };
    const white = { red: 1, green: 1, blue: 1 };
    expect(contrastRatio(black, white)).toBeCloseTo(21, 10);
    expect(contrastRatio(white, black)).toBeCloseTo(21, 10);
    expect(
      contrastRatio({ red: 0.5, green: 0.5, blue: 0.5 }, { red: 0.52, green: 0.52, blue: 0.52 }),
    ).toBeLessThan(1.2);
  });
});
