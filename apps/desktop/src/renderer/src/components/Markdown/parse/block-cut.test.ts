// The cut's guards on where the parser places a text's children: a block that would end no later
// than the block before it fails the cut with a `StalledBlockCutError`, at a window's first block
// and at a later one, rather than cut an empty block or the same window forever; and a streaming
// tail settles no block from the first such end on, leaving those blocks in the tail.

import { expect, it } from "vitest";

import {
  BlockCut,
  settledBlockEndsOf,
  StalledBlockCutError,
  type TopLevelChildren,
} from "./block-cut.js";

/** Children starting at `starts`, each one unit long. */
function childrenAt(starts: readonly number[]): TopLevelChildren {
  return { starts, ends: starts.map((start) => start + 1) };
}

it("fails a cut whose block would end no later than the block before it", () => {
  const lines = "a\nb\nc\n";
  expect(new BlockCut(lines, true, 0, () => childrenAt([0, 2, 4])).cutWhole()).toStrictEqual(
    Uint32Array.from([2, 4, 6]),
  );
  // A second child on the window's first line would end the first block where it starts.
  const firstLineTwice = new BlockCut("a b\nc\n", true, 0, () => childrenAt([0, 2, 4]));
  expect(() => firstLineTwice.cutWindow()).toThrow(StalledBlockCutError);
  // A child on the line of the child before it would end its block where that one ends.
  const laterLineTwice = new BlockCut("a\nb c\nd\n", false, 1, () => childrenAt([0, 2, 4, 6]));
  expect(() => laterLineTwice.cutWindow()).toThrow(
    "The markdown block cut did not advance past offset 2",
  );
});

it("settles a tail's blocks up to the first that would end no later than the one before it", () => {
  const tail = "a\nb\nc\nd\ne\n";
  expect(settledBlockEndsOf(childrenAt([0, 2, 4, 6, 8]), tail, tail.length)).toStrictEqual([
    2, 4, 6,
  ]);
  expect(settledBlockEndsOf(childrenAt([0, 0, 4, 6, 8]), tail, tail.length)).toStrictEqual([]);
  expect(settledBlockEndsOf(childrenAt([0, 2, 2, 6, 8]), tail, tail.length)).toStrictEqual([2]);
});
