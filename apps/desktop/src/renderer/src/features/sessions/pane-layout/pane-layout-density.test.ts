// The density presets: the axis runs loosest to tightest, the lookup is total, and the fit
// calculation answers at least one.

import { describe, expect, it } from "vitest";

import {
  PANE_LAYOUT_DENSITIES,
  PANE_LAYOUT_MINIMUM_PANE_WIDTH_PX,
  DEFAULT_PANE_LAYOUT_DENSITY,
} from "./pane-layout-measures.js";
import { isPaneLayoutDensity, minimumPaneWidthPx, panesThatFit } from "./pane-layout-density.js";

describe("PANE_LAYOUT_DENSITIES — the axis", () => {
  it("runs loosest to tightest, so the control reads as one axis", () => {
    const widths = PANE_LAYOUT_DENSITIES.map((density) => minimumPaneWidthPx(density));
    const descending = [...widths].sort((left, right) => right - left);
    expect(widths).toStrictEqual(descending);
  });

  it("negative control: the widths are not all the same number", () => {
    // Identical entries would satisfy the ordering above and make the preset meaningless.
    expect(new Set(Object.values(PANE_LAYOUT_MINIMUM_PANE_WIDTH_PX)).size).toBe(
      PANE_LAYOUT_DENSITIES.length,
    );
  });

  it("defaults to standard, which is what a new pane opens at", () => {
    expect(DEFAULT_PANE_LAYOUT_DENSITY).toBe("standard");
    expect(PANE_LAYOUT_DENSITIES).toContain(DEFAULT_PANE_LAYOUT_DENSITY);
  });
});

describe("isPaneLayoutDensity — reading a preset off disk", () => {
  it("admits every declared preset", () => {
    for (const density of PANE_LAYOUT_DENSITIES) {
      expect(isPaneLayoutDensity(density)).toBe(true);
    }
  });

  it("negative control: refuses a preset this build does not have", () => {
    expect(isPaneLayoutDensity("roomy")).toBe(false);
    expect(isPaneLayoutDensity(undefined)).toBe(false);
    expect(isPaneLayoutDensity(3)).toBe(false);
  });
});

describe("panesThatFit", () => {
  it("answers at least one, even in a window narrower than one pane", () => {
    // Zero would leave nowhere for a pane just opened; a narrow pane can be fixed by resizing.
    expect(panesThatFit("comfortable", 10)).toBe(1);
  });

  it("negative control: a wide pane layout fits more than one", () => {
    // The case above would also pass over a function that returned 1 for every input.
    expect(panesThatFit("compact", minimumPaneWidthPx("compact") * 4)).toBe(4);
  });
});
