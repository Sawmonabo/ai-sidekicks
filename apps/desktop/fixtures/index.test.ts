// The catalog: every scenario on it names a frozen tick, and the lookup finds each by id.
//
// The case the design asks for: a scenario the registry names no frame for fails, so a
// scenario that lands and pins no frame is stopped by the build rather than by a
// reviewer noticing.
//
// WHY IT IS HERE AND NOT BESIDE THE REGISTRY. The subject is the catalog — this file reads
// `SCENARIOS` and holds the registry to it — and the registry imports nothing from
// the catalog. The registry's own rules, which need no catalog at all, stay beside the
// registry in `services/daemon/frozen-tick-registry.fixture.test.ts`.

import { describe, expect, it } from "vitest";

import {
  findFrozenTickRegistryDefects,
  findScenariosWithoutFrozenTick,
} from "@renderer/services/daemon/frozen-tick-registry.fixture.js";
import { scenarioNamed } from "@renderer/services/daemon/vocabulary.test-support.js";
import { SCENARIOS, findScenario } from "./index.js";

describe("every scenario on the board names a frozen tick", () => {
  it("leaves no scenario unregistered", () => {
    expect(findScenariosWithoutFrozenTick(SCENARIOS)).toStrictEqual([]);
  });

  it("reports the whole board as clean", () => {
    expect(findFrozenTickRegistryDefects(SCENARIOS)).toStrictEqual([]);
  });

  it("negative control: a scenario the registry does not name fails the registry", () => {
    const board = [...SCENARIOS, scenarioNamed("a-feature-landed-this-and-pinned-nothing")];

    expect(findScenariosWithoutFrozenTick(board)).toStrictEqual([
      "a-feature-landed-this-and-pinned-nothing",
    ]);
    expect(findFrozenTickRegistryDefects(board)[0]?.reason).toContain("names no frozen tick");
  });

  it("negative control: a row for a scenario the board dropped fails it too", () => {
    const catalogWithoutConcurrentStreaming = SCENARIOS.filter(
      (scenario) => scenario.id !== "concurrent-streaming",
    );

    const defects = findFrozenTickRegistryDefects(catalogWithoutConcurrentStreaming);

    expect(defects).toHaveLength(1);
    expect(defects[0]?.scenarioId).toBe("concurrent-streaming");
    expect(defects[0]?.reason).toContain("no longer carries");
  });
});

describe("the scenario lookup", () => {
  it("resolves every scenario on the board", () => {
    for (const scenario of SCENARIOS) {
      expect(findScenario(scenario.id).id).toBe(scenario.id);
    }
  });

  it("negative control: an unknown scenario id is refused rather than defaulted", () => {
    expect(() => findScenario("no-such-scenario")).toThrow(RangeError);
  });
});
