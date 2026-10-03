// The density presets: a preset read off disk is one this build has.

import { describe, expect, it } from "vitest";

import { PANE_LAYOUT_DENSITIES } from "./pane-layout-measures.js";
import { isPaneLayoutDensity } from "./pane-layout-density.js";

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
