// Does the fixture's phase-output table carry both value kinds?
//
// One claim, and it is the whole of what this table owes: an artifact reference and an
// inline value read very differently, and a table of one kind would leave the other
// arm of every output surface unrendered by anything.

import { describe, expect, it } from "vitest";

import { WORKFLOWS_SCENARIO_PHASE_OUTPUTS } from "./workflow-fixture-phase-outputs.js";

describe("the workflows scenario — the phase outputs", () => {
  it("carries both output value kinds", () => {
    const kinds = WORKFLOWS_SCENARIO_PHASE_OUTPUTS.map((output) => output.valueKind);

    expect(new Set(kinds)).toStrictEqual(new Set(["inline", "artifact_ref"]));
    for (const output of WORKFLOWS_SCENARIO_PHASE_OUTPUTS) {
      // An artifact reference carries its id; an inline output must not, or the older
      // daemon's fallback reading would classify it as a reference.
      expect(output.artifactId !== undefined).toBe(output.valueKind === "artifact_ref");
    }
  });
});
