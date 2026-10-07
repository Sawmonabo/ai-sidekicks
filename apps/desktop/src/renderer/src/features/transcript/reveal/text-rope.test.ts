// The rope's claim that matters: the cursor only moves forward, across part boundaries and never
// past the source.

import { describe, expect, it } from "vitest";

import { RevealTextRope } from "./text-rope.js";

function fedWith(parts: readonly string[]): RevealTextRope {
  const rope = new RevealTextRope("lane-1");
  for (const part of parts) {
    rope.append(part);
  }
  return rope;
}

describe("the reveal text rope", () => {
  it("reveals across part boundaries and never past the source", () => {
    const rope = fedWith(["abc", "de", "fghi"]);
    expect(rope.advance(4)).toBe(4);
    expect(rope.revealedText()).toBe("abcd");
    expect(rope.advance(100)).toBe(5);
    expect(rope.revealedText()).toBe("abcdefghi");
    expect(rope.isSettled).toBe(true);

    // One append long enough that the rope keeps it as several parts of its own: every
    // character still arrives once and in order, at every stop.
    const numbered = Array.from(
      { length: 1_000 },
      (_, index) => `${String(index).padStart(4, "0")} `,
    );
    const longSource = numbered.join("");
    const longRope = fedWith([longSource]);
    while (!longRope.isSettled) {
      longRope.advance(777);
      expect(longSource.startsWith(longRope.revealedText())).toBe(true);
      expect(longRope.isPrefixOf(longSource)).toBe(true);
    }
    expect(longRope.revealedText()).toBe(longSource);
  });

  it("never moves the cursor backwards, and never reveals on a negative budget", () => {
    const rope = fedWith(["abcdef"]);
    rope.advance(3);
    expect(rope.advance(-10)).toBe(0);
    expect(rope.revealedText()).toBe("abc");
    expect(rope.revealedLength).toBe(3);
  });

  it("hands back a bounded tail and a bounded lookahead", () => {
    const rope = fedWith(["one two ", "three four"]);
    rope.advance(8);
    expect(rope.revealedTail(3)).toBe("wo ");
    expect(rope.revealedTail(100)).toBe("one two ");
    expect(rope.lookahead(5)).toBe("three");
    expect(rope.lookahead(100)).toBe("three four");
  });

  it("recognizes a candidate that extends it, and one that does not", () => {
    const rope = fedWith(["The run ", "started"]);
    expect(rope.isPrefixOf("The run started at noon")).toBe(true);
    expect(rope.isPrefixOf("The run started")).toBe(true);
    // The negative control for the case above: a producer that re-wrote its own
    // history must not read as an append.
    expect(rope.isPrefixOf("The run failed")).toBe(false);
    expect(rope.isPrefixOf("The run")).toBe(false);
  });

  it("still recognizes its source once the cursor has passed parts and stands inside one", () => {
    // Passed parts are dropped, so the revealed prefix, the part under the cursor and the part
    // after it carry the comparison; each refused candidate differs in one of the three.
    const rope = fedWith(["The run ", "started ", "at noon"]);
    rope.advance(11);
    expect(rope.isPrefixOf("The run started at noon, and ended")).toBe(true);
    expect(rope.isPrefixOf("The ran started at noon, and ended")).toBe(false);
    expect(rope.isPrefixOf("The run starved at noon, and ended")).toBe(false);
    expect(rope.isPrefixOf("The run started at dusk, and ended")).toBe(false);
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

describe("the reveal text rope — a frame never cuts a character in half", () => {
  it("publishes the whole non-BMP character or stops before it, at every cut offset", () => {
    const source = `ab${GRINNING_FACE}cd`;
    const allowed = codePointBoundaryPrefixes(source);
    for (let budget = 0; budget <= source.length; budget += 1) {
      const rope = fedWith([source]);
      rope.advance(budget);
      expect(allowed.has(rope.revealedText())).toBe(true);
    }
  });

  it("snaps across a part boundary, where the halves arrived in separate appends", () => {
    // The check walks the parts from the cursor, so a pair split across two appends
    // is the same pair — reading it through a materialized source is what the rope
    // exists to avoid.
    const rope = fedWith(["ab", GRINNING_FACE.slice(0, 1), `${GRINNING_FACE.slice(1)}cd`]);
    expect(rope.advance(3)).toBe(4);
    expect(rope.revealedText()).toBe(`ab${GRINNING_FACE}`);
  });

  it("publishes a producer-split lone surrogate at the source end rather than stalling", () => {
    // The source, not the budget, cut this one. Withholding it would hold the lane
    // on text that may never arrive; publishing it self-heals on the next append.
    const rope = fedWith([`ab${GRINNING_FACE.slice(0, 1)}`]);
    expect(rope.advance(100)).toBe(3);
    expect(rope.isSettled).toBe(true);
    rope.append(`${GRINNING_FACE.slice(1)}cd`);
    rope.advance(100);
    expect(rope.revealedText()).toBe(`ab${GRINNING_FACE}cd`);
  });
});
