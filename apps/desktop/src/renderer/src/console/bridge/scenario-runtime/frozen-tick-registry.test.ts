// The frozen-tick registry, held to the scenario board in both directions.
//
// The first case is the one the design asks for: a scenario the registry names no frame
// for fails, so a family that lands a scenario and decides no money frame is stopped by
// the build rather than by a reviewer noticing.

import { describe, expect, it } from "vitest";

import {
  findFrozenTickRegistryDefects,
  findScenariosWithoutFrozenTick,
  frozenTicksFor,
  type FrozenTickTable,
} from "./frozen-tick-registry.js";
import { CONSOLE_SCENARIOS } from "./scenario-manifest.js";
import type { ConsoleScenario } from "./scenario.js";

/** A scenario with only the members the registry walk reads. */
function scenarioNamed(id: string): ConsoleScenario {
  return {
    id,
    label: id,
    purpose: "A scenario standing in for one on the board.",
    sessionId: "019b7a10-4c00-7d31-9f02-6b1a5e900001",
    participantIdsInJoinOrder: [],
    startedAtIso: "2026-01-14T11:20:00.000Z",
    beats: [],
    replies: [],
  };
}

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

describe("the rules one scenario's pinned frames are held to", () => {
  const board = [scenarioNamed("planted")];

  it("reports two frames sharing a name", () => {
    const table: FrozenTickTable = {
      planted: [
        { name: "settled", atMs: 0 },
        { name: "settled", atMs: 400 },
      ],
    };

    expect(findFrozenTickRegistryDefects(board, table)[0]?.reason).toContain(
      'two frames are named "settled"',
    );
  });

  it("reports a tick a frozen clock cannot be advanced to", () => {
    const table: FrozenTickTable = { planted: [{ name: "settled", atMs: -1 }] };

    expect(findFrozenTickRegistryDefects(board, table)[0]?.reason).toContain("not a tick");
  });

  it("reports frames pinned out of order", () => {
    const table: FrozenTickTable = {
      planted: [
        { name: "later", atMs: 400 },
        { name: "earlier", atMs: 200 },
      ],
    };

    expect(findFrozenTickRegistryDefects(board, table)[0]?.reason).toContain("order them");
  });

  it("negative control: two ascending, uniquely named frames pass every rule", () => {
    const table: FrozenTickTable = {
      planted: [
        { name: "opening", atMs: 0 },
        { name: "settled", atMs: 400 },
      ],
    };

    expect(findFrozenTickRegistryDefects(board, table)).toStrictEqual([]);
  });
});

describe("reading the registry", () => {
  it("answers a scenario's frames, and an empty list for one it does not name", () => {
    expect(frozenTicksFor("flagship")).toStrictEqual([{ name: "money-shot", atMs: 2_450 }]);
    expect(frozenTicksFor("no-scenario-is-named-this")).toStrictEqual([]);
  });

  it("answers an inherited property name with nothing rather than a function", () => {
    expect(frozenTicksFor("constructor")).toStrictEqual([]);
    expect(frozenTicksFor("toString")).toStrictEqual([]);
  });
});
