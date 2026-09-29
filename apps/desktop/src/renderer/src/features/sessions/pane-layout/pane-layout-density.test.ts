// The density presets: three values on one axis, and a floor that is a real number.
//
// A preset is one number, so the ways it can be wrong are few and each is checked:
// the axis has to run loosest to tightest (a control whose order is arbitrary is a
// control nobody can predict), the lookup has to be total, and the fit calculation
// has to answer at least one — a deck that answered zero would have nowhere to put
// the pane a person just opened.

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
    // Without this, a table whose three entries were identical would satisfy the
    // ordering above and make the whole preset meaningless.
    expect(new Set(Object.values(PANE_LAYOUT_MINIMUM_PANE_WIDTH_PX)).size).toBe(
      PANE_LAYOUT_DENSITIES.length,
    );
  });

  it("defaults to standard, which is what a new pane opens at", () => {
    expect(DEFAULT_PANE_LAYOUT_DENSITY).toBe("standard");
    expect(PANE_LAYOUT_DENSITIES).toContain(DEFAULT_PANE_LAYOUT_DENSITY);
  });
});

describe("isDeckDensity — reading a preset off disk", () => {
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
    // A deck that answered zero would have nowhere to put the pane a person just
    // opened. An unreadably narrow pane is a problem they can fix by resizing the
    // window; an invisible one is not.
    expect(panesThatFit("comfortable", 10)).toBe(1);
  });

  it("negative control: a wide deck fits more than one", () => {
    // Without this the case above would pass over a function that returned 1 for
    // every input, which is a different and permanently broken deck.
    expect(panesThatFit("compact", minimumPaneWidthPx("compact") * 4)).toBe(4);
  });
});
