// The frozen-tick registry's own rules, and the reading it answers with.
//
// WHAT IS NOT HERE. Whether the BOARD is fully registered is a claim about the corpus
// rather than about this module, and the corpus lives one directory up — which this
// directory imports from through no path. That case is `../frozen-tick-board.test.ts`,
// beside the board it reads.

import { describe, expect, it } from "vitest";

import {
  findFrozenTickRegistryDefects,
  frozenTicksFor,
  type FrozenTickTable,
} from "./frozen-tick-registry.js";
import { scenarioNamed } from "./vocabulary.test-support.js";

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
