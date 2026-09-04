// The catalog selectors, and the two distinctions they exist to preserve.
//
// An ABSENT effort vocabulary means the model publishes no effort surface; an EMPTY
// one would assert an axis with nothing on it, a claim no provider makes. And an
// unanswered capability flag is not `false` — the console asserts no capability it
// was not told about, in either direction.

import { describe, expect, it } from "vitest";

import {
  capabilityFlagFor,
  driverNamesOf,
  effortLevelsFor,
  modelsFor,
  outputSpeedLevelsFor,
} from "./driver-catalog.js";
import { DRIVER_CATALOG_FIXTURE } from "./driver-catalog-fixtures.js";

describe("driver catalog — the group lists", () => {
  it("answers the driver names in the daemon's own order", () => {
    expect(driverNamesOf(DRIVER_CATALOG_FIXTURE)).toEqual(["claude", "codex"]);
  });

  it("answers one driver's models", () => {
    expect(modelsFor(DRIVER_CATALOG_FIXTURE, "codex").map((model) => model.id)).toEqual([
      "gpt-5.6",
    ]);
  });

  it("negative control: a driver the catalog never named has no models", () => {
    expect(modelsFor(DRIVER_CATALOG_FIXTURE, "gemini")).toEqual([]);
  });
});

describe("driver catalog — effort is per model", () => {
  it("answers the selected model's own vocabulary", () => {
    expect(effortLevelsFor(DRIVER_CATALOG_FIXTURE, "claude", "claude-sonnet")).toEqual([
      "low",
      "high",
    ]);
  });

  it("answers undefined for a model that publishes no effort surface", () => {
    // Not `[]`: the form shows NO effort control at all in this case, and an empty
    // array would be a control with an empty choice set.
    expect(effortLevelsFor(DRIVER_CATALOG_FIXTURE, "claude", "claude-haiku")).toBeUndefined();
  });

  it("negative control: a sibling model in the same reply still has one", () => {
    // Without this, the case above would pass over a selector that always answered
    // undefined — which is exactly the provider-wide-list mistake it guards.
    expect(effortLevelsFor(DRIVER_CATALOG_FIXTURE, "claude", "claude-sonnet")).toBeDefined();
  });
});

describe("driver catalog — the output-speed vocabulary and its gate", () => {
  it("answers the declaring driver's list", () => {
    expect(outputSpeedLevelsFor(DRIVER_CATALOG_FIXTURE, "claude")).toEqual(["standard", "fast"]);
  });

  it("answers undefined for a driver that declares no speed axis", () => {
    expect(outputSpeedLevelsFor(DRIVER_CATALOG_FIXTURE, "codex")).toBeUndefined();
  });

  it("reads a flag as the driver declared it", () => {
    expect(capabilityFlagFor(DRIVER_CATALOG_FIXTURE, "claude", "output_speed")).toBe(true);
    expect(capabilityFlagFor(DRIVER_CATALOG_FIXTURE, "codex", "output_speed")).toBe(false);
  });

  it("answers undefined — not false — for a driver the catalog never named", () => {
    expect(capabilityFlagFor(DRIVER_CATALOG_FIXTURE, "gemini", "output_speed")).toBeUndefined();
  });
});
