// An absent effort or speed vocabulary means the model publishes none: an empty one would
// assert an axis with nothing on it.

import { describe, expect, it } from "vitest";

import { catalogCarriesModel, effortLevelsFor, outputSpeedLevelsFor } from "./driver-catalog.js";
import {
  DRIVER_CATALOG_FIXTURE,
  SPEED_TIER_CATALOG_FIXTURE,
} from "./driver-catalog.test-support.js";

describe("driver catalog — effort is per model", () => {
  it("answers undefined for a model that publishes no effort levels", () => {
    // Not `[]`: the form shows no effort control here, and an empty array would be a control
    // with an empty choice set.
    expect(
      effortLevelsFor(DRIVER_CATALOG_FIXTURE, "claude", {
        modelId: "claude-haiku",
        largerWindow: false,
      }),
    ).toBeUndefined();
  });

  it("negative control: a sibling model in the same reply still has one", () => {
    // Otherwise the case above would pass for a selector that always answered undefined.
    expect(
      effortLevelsFor(DRIVER_CATALOG_FIXTURE, "claude", {
        modelId: "claude-sonnet",
        largerWindow: false,
      }),
    ).toBeDefined();
  });
});

describe("driver catalog — speed is per model where the provider publishes it so", () => {
  const levelsOf = (modelId: string): readonly string[] | undefined =>
    outputSpeedLevelsFor(SPEED_TIER_CATALOG_FIXTURE, "codex", { modelId, largerWindow: false });

  it("answers undefined for a model that publishes no tiers", () => {
    // Its siblings publish tiers, so only reading this model's own absence answers none here.
    expect(levelsOf("untiered")).toBeUndefined();
  });

  it("answers the model's own list, not one a sibling model lists", () => {
    // A provider-wide list would carry `priority` here.
    expect(levelsOf("flex-only")).not.toContain("priority");
    // Negative control: the model that lists it carries it.
    expect(levelsOf("tiered")).toContain("priority");
  });
});

describe("driver catalog — a model's larger window is a row of its own", () => {
  it("carries a larger window only where the catalog lists that row", () => {
    // Found by id alone, a larger window the catalog no longer offers would read as carried.
    const carries = (largerWindow: boolean): boolean =>
      catalogCarriesModel(SPEED_TIER_CATALOG_FIXTURE, "codex", { modelId: "tiered", largerWindow });
    expect(carries(true)).toBe(false);
    expect(carries(false)).toBe(true);
  });
});
