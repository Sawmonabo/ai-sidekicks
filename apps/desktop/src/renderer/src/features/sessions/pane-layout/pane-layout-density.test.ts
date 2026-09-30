// The density presets: a preset read off disk is one this build has, and the fit calculation
// answers at least one.

import { describe, expect, it } from "vitest";

import { PANE_LAYOUT_DENSITIES } from "./pane-layout-measures.js";
import { isPaneLayoutDensity, minimumPaneWidthPx, panesThatFit } from "./pane-layout-density.js";

describe("isPaneLayoutDensity — reading a preset off disk", () => {
  it("admits every declared preset and refuses one this build does not have", () => {
    for (const density of PANE_LAYOUT_DENSITIES) {
      expect(isPaneLayoutDensity(density)).toBe(true);
    }
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
