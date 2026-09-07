// One airspace per document, and never one shared across two.

import { describe, expect, it } from "vitest";

import { airspaceRegistryFor } from "./airspace-registries.js";

describe("airspaceRegistryFor", () => {
  it("hands one document's overlays and its native views the same registry", () => {
    expect(airspaceRegistryFor(document)).toBe(airspaceRegistryFor(document));
  });

  it("gives a second document its own airspace", () => {
    // An auxiliary window is its own renderer with its own overlays: a dialog open in
    // one window must not make a view in another yield.
    const other = document.implementation.createHTMLDocument("auxiliary");
    expect(airspaceRegistryFor(other)).not.toBe(airspaceRegistryFor(document));
  });
});
