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
