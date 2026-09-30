// An absent effort vocabulary means the model publishes none: an empty one would assert an
// axis with nothing on it.

import { describe, expect, it } from "vitest";

import { effortLevelsFor } from "./driver-catalog.js";
import { DRIVER_CATALOG_FIXTURE } from "./driver-catalog.test-support.js";

describe("driver catalog — effort is per model", () => {
  it("answers undefined for a model that publishes no effort levels", () => {
    // Not `[]`: the form shows no effort control here, and an empty array would be a control
    // with an empty choice set.
    expect(effortLevelsFor(DRIVER_CATALOG_FIXTURE, "claude", "claude-haiku")).toBeUndefined();
  });

  it("negative control: a sibling model in the same reply still has one", () => {
    // Otherwise the case above would pass for a selector that always answered undefined.
    expect(effortLevelsFor(DRIVER_CATALOG_FIXTURE, "claude", "claude-sonnet")).toBeDefined();
  });
});
