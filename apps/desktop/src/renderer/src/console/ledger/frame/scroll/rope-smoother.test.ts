// The rope's two claims: the cursor only moves forward, and no growing string is
// ever indexed.
//
// The second is structural rather than observable, so it is tested the way it is
// enforced: `isPrefixOf` and `lookahead` are driven against a source built from many
// small appends, and the results are compared with what a naive concatenation would
// have produced. If either ever reached for a materialised source, the answers would
// still agree — so the cases that matter are the ones about the CURSOR, which is
// what the rope exists to keep honest.

import { describe, expect, it } from "vitest";

import { RopeSmoother } from "./rope-smoother.js";

function fedWith(parts: readonly string[]): RopeSmoother {
  const smoother = new RopeSmoother("lane-1");
  for (const part of parts) {
    smoother.append(part);
  }
  return smoother;
}

describe("the rope smoother", () => {
  it("mints a token per append, monotonic, carrying the source length after it", () => {
    const smoother = new RopeSmoother("lane-1");
    expect(smoother.append("hello ")).toStrictEqual({
      laneId: "lane-1",
      sequence: 1,
      sourceLength: 6,
    });
    expect(smoother.append("world")).toStrictEqual({
      laneId: "lane-1",
      sequence: 2,
      sourceLength: 11,
    });
  });

  it("mints nothing for an empty append, because nothing grew", () => {
    const smoother = new RopeSmoother("lane-1");
    expect(smoother.append("")).toBeUndefined();
    expect(smoother.sourceLength).toBe(0);
  });

  it("reveals across part boundaries and never past the source", () => {
    const smoother = fedWith(["abc", "de", "fghi"]);
    expect(smoother.advance(4)).toBe(4);
    expect(smoother.revealedText()).toBe("abcd");
    expect(smoother.advance(100)).toBe(5);
    expect(smoother.revealedText()).toBe("abcdefghi");
    expect(smoother.isSettled).toBe(true);
  });

  it("never moves the cursor backwards, and never reveals on a negative budget", () => {
    const smoother = fedWith(["abcdef"]);
    smoother.advance(3);
    expect(smoother.advance(-10)).toBe(0);
    expect(smoother.revealedText()).toBe("abc");
    expect(smoother.revealedLength).toBe(3);
  });

  it("hands back a bounded tail and a bounded lookahead", () => {
    const smoother = fedWith(["one two ", "three four"]);
    smoother.advance(8);
    expect(smoother.revealedTail(3)).toBe("wo ");
    expect(smoother.revealedTail(100)).toBe("one two ");
    expect(smoother.lookahead(5)).toBe("three");
    expect(smoother.lookahead(100)).toBe("three four");
  });

  it("recognises a candidate that extends it, and one that does not", () => {
    const smoother = fedWith(["The run ", "started"]);
    expect(smoother.isPrefixOf("The run started at noon")).toBe(true);
    expect(smoother.isPrefixOf("The run started")).toBe(true);
    // The negative control for the case above: a producer that re-wrote its own
    // history must not read as an append.
    expect(smoother.isPrefixOf("The run failed")).toBe(false);
    expect(smoother.isPrefixOf("The run")).toBe(false);
  });
});

/** One code point, two UTF-16 code units — the shape a code-unit budget can cut. */
const GRINNING_FACE = "😀";

/** Every prefix of `text` that ends on a code-point boundary, shortest first. */
function codePointBoundaryPrefixes(text: string): ReadonlySet<string> {
  const prefixes = new Set<string>();
  let built = "";
  prefixes.add(built);
  for (const character of text) {
    built += character;
    prefixes.add(built);
  }
  return prefixes;
}

describe("the rope smoother — a frame never cuts a character in half", () => {
  it("publishes the whole non-BMP character or stops before it, at every cut offset", () => {
    const source = `ab${GRINNING_FACE}cd`;
    const allowed = codePointBoundaryPrefixes(source);
    for (let budget = 0; budget <= source.length; budget += 1) {
      const smoother = fedWith([source]);
      smoother.advance(budget);
      expect(allowed.has(smoother.revealedText())).toBe(true);
    }
  });

  it("negative control: the code-unit cut at that offset WOULD have split the pair", () => {
    // `slice(0, 3)` is the cut the budget used to make, and it ends on the pair's
    // lead half. The guard's own return value is what says it extended rather than
    // retreated: three units of budget move four, and the character is whole.
    const source = `ab${GRINNING_FACE}cd`;
    expect(codePointBoundaryPrefixes(source).has(source.slice(0, 3))).toBe(false);
    const smoother = fedWith([source]);
    expect(smoother.advance(3)).toBe(4);
    expect(smoother.revealedText()).toBe(`ab${GRINNING_FACE}`);
  });

  it("snaps across a part boundary, where the halves arrived in separate appends", () => {
    // The check walks the parts from the cursor, so a pair split across two appends
    // is the same pair — reading it through a materialised source is what the rope
    // exists to avoid.
    const smoother = fedWith(["ab", GRINNING_FACE.slice(0, 1), `${GRINNING_FACE.slice(1)}cd`]);
    expect(smoother.advance(3)).toBe(4);
    expect(smoother.revealedText()).toBe(`ab${GRINNING_FACE}`);
  });

  it("publishes a producer-split lone surrogate at the source end rather than stalling", () => {
    // The source, not the budget, cut this one. Withholding it would hold the lane
    // on text that may never arrive; publishing it self-heals on the next append.
    const smoother = fedWith([`ab${GRINNING_FACE.slice(0, 1)}`]);
    expect(smoother.advance(100)).toBe(3);
    expect(smoother.isSettled).toBe(true);
    smoother.append(`${GRINNING_FACE.slice(1)}cd`);
    smoother.advance(100);
    expect(smoother.revealedText()).toBe(`ab${GRINNING_FACE}cd`);
  });

  it("negative control: pure ASCII spends its budget exactly, unchanged", () => {
    // The snap must be reachable only by a pair. If it fired on ordinary text the
    // per-frame counts every budget claim rests on would drift by one.
    const smoother = fedWith(["abcdefghij"]);
    expect(smoother.advance(3)).toBe(3);
    expect(smoother.revealedText()).toBe("abc");
    expect(smoother.advance(4)).toBe(4);
    expect(smoother.revealedText()).toBe("abcdefg");
  });
});
