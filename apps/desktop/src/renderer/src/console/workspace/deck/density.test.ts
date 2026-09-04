// The density presets: three values on one axis, and a floor that is a real number.
//
// A preset is one number, so the ways it can be wrong are few and each is checked:
// the axis has to run loosest to tightest (a control whose order is arbitrary is a
// control nobody can predict), the lookup has to be total, and the fit calculation
// has to answer at least one — a deck that answered zero would have nowhere to put
// the pane a person just opened.

import { describe, expect, it } from "vitest";

import {
  DECK_DENSITIES,
  DECK_MINIMUM_PANE_WIDTH_PX,
  DEFAULT_DECK_DENSITY,
  isDeckDensity,
  minimumPaneWidthPx,
  panesThatFit,
} from "./density.js";

describe("DECK_DENSITIES — the axis", () => {
  it("runs loosest to tightest, so the control reads as one axis", () => {
    const widths = DECK_DENSITIES.map((density) => minimumPaneWidthPx(density));
    const descending = [...widths].sort((left, right) => right - left);
    expect(widths).toStrictEqual(descending);
  });

  it("negative control: the widths are not all the same number", () => {
    // Without this, a table whose three entries were identical would satisfy the
    // ordering above and make the whole preset meaningless.
    expect(new Set(Object.values(DECK_MINIMUM_PANE_WIDTH_PX)).size).toBe(DECK_DENSITIES.length);
  });

  it("defaults to standard, which is what a new pane opens at", () => {
    expect(DEFAULT_DECK_DENSITY).toBe("standard");
    expect(DECK_DENSITIES).toContain(DEFAULT_DECK_DENSITY);
  });
});

describe("isDeckDensity — reading a preset off disk", () => {
  it("admits every declared preset", () => {
    for (const density of DECK_DENSITIES) {
      expect(isDeckDensity(density)).toBe(true);
    }
  });

  it("negative control: refuses a preset this build does not have", () => {
    expect(isDeckDensity("roomy")).toBe(false);
    expect(isDeckDensity(undefined)).toBe(false);
    expect(isDeckDensity(3)).toBe(false);
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
