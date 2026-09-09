// Every scenario on the board names a frozen tick.
//
// The case the design asks for: a scenario the registry names no frame for fails, so a
// family that lands a scenario and decides no money frame is stopped by the build rather
// than by a reviewer noticing.
//
// WHY IT IS HERE AND NOT BESIDE THE REGISTRY. The subject is the BOARD — this file reads
// `CONSOLE_SCENARIOS` and holds the registry to it — and `runtime/` imports nothing from
// the corpus above it. The registry's own rules, which need no corpus at all, stay beside
// the registry in `runtime/frozen-tick-registry.test.ts`.

import { describe, expect, it } from "vitest";

import {
  findFrozenTickRegistryDefects,
  findScenariosWithoutFrozenTick,
} from "./runtime/frozen-tick-registry.js";
import { scenarioNamed } from "./runtime/vocabulary.test-support.js";
import { CONSOLE_SCENARIOS } from "./corpus.js";

describe("every scenario on the board names a frozen tick", () => {
  it("leaves no scenario unregistered", () => {
    expect(findScenariosWithoutFrozenTick(CONSOLE_SCENARIOS)).toStrictEqual([]);
  });

  it("reports the whole board as clean", () => {
    expect(findFrozenTickRegistryDefects(CONSOLE_SCENARIOS)).toStrictEqual([]);
  });

  it("negative control: a scenario the registry does not name fails the registry", () => {
    const board = [...CONSOLE_SCENARIOS, scenarioNamed("a-family-landed-this-and-pinned-nothing")];

    expect(findScenariosWithoutFrozenTick(board)).toStrictEqual([
      "a-family-landed-this-and-pinned-nothing",
    ]);
    expect(findFrozenTickRegistryDefects(board)[0]?.reason).toContain("names no frozen tick");
  });

  it("negative control: a row for a scenario the board dropped fails it too", () => {
    const boardMissingTheFlagship = CONSOLE_SCENARIOS.filter(
      (scenario) => scenario.id !== "flagship",
    );

    const defects = findFrozenTickRegistryDefects(boardMissingTheFlagship);

    expect(defects).toHaveLength(1);
    expect(defects[0]?.scenarioId).toBe("flagship");
    expect(defects[0]?.reason).toContain("no longer carries");
  });
});
