// Does the fixture's definition table carry a name at more than one scope, so the
// resolution mark means something?
//
// The same content claim the runs suite makes, one table along: `resolvesAtThisContext`
// is a flag whose whole point is that it is FALSE somewhere, and a table of uniquely
// named definitions would set it everywhere and say nothing.

import { describe, expect, it } from "vitest";

import { WORKFLOWS_SCENARIO_DEFINITIONS } from "./workflow-fixture-definitions.js";

describe("the workflows scenario — the definitions", () => {
  it("marks exactly one resolving row per definition name", () => {
    const resolvingByName = new Map<string, number>();
    for (const definition of WORKFLOWS_SCENARIO_DEFINITIONS) {
      if (definition.resolvesAtThisContext) {
        resolvingByName.set(definition.name, (resolvingByName.get(definition.name) ?? 0) + 1);
      }
    }
    const names = new Set(WORKFLOWS_SCENARIO_DEFINITIONS.map((definition) => definition.name));

    expect([...resolvingByName.values()]).toStrictEqual(Array.from(names, () => 1));
  });

  it("carries a name at more than one scope, so the resolution mark says something", () => {
    // Without a repeated name every row would resolve and the flag would be a constant.
    const countsByName = new Map<string, number>();
    for (const definition of WORKFLOWS_SCENARIO_DEFINITIONS) {
      countsByName.set(definition.name, (countsByName.get(definition.name) ?? 0) + 1);
    }

    expect([...countsByName.values()].filter((count) => count > 1).length).toBeGreaterThan(0);
  });

  it("populates all three scopes and gives each its own scope identity", () => {
    const scopes = new Set(WORKFLOWS_SCENARIO_DEFINITIONS.map((definition) => definition.scope));

    expect(scopes).toStrictEqual(new Set(["session", "project", "shared"]));
    for (const definition of WORKFLOWS_SCENARIO_DEFINITIONS) {
      // `shared` is daemon-wide and refers to nothing narrower, so its reference is
      // empty by the contract rather than by omission; the other two name something.
      expect(definition.scopeRef === "").toBe(definition.scope === "shared");
      expect(definition.contentHash.startsWith("b3:")).toBe(true);
    }
  });
});
