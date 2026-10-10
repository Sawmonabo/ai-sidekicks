// The rope's claims that matter: the cursor only moves forward, across chunk boundaries and never
// past the source, and a read of the revealed text through the rope returns exactly the
// characters revealed, wherever a range falls against the chunks.

import { describe, expect, it } from "vitest";

import { REVEAL_TEXT_CHUNK_CHARACTERS } from "./caps.js";
import { RevealTextRope } from "./text-rope.js";

function fedWith(appends: readonly string[]): RevealTextRope {
  const rope = new RevealTextRope("lane-1");
  for (const text of appends) {
    rope.append(text);
  }
  return rope;
}

describe("the reveal text rope", () => {
  it("reveals across appends and chunk edges, and never past the source", () => {
    const rope = fedWith(["abc", "de", "fghi"]);
    expect(rope.advance(4)).toBe(4);
    expect(rope.slice(0)).toBe("abcd");
    expect(rope.advance(100)).toBe(5);
    expect(rope.slice(0)).toBe("abcdefghi");
    expect(rope.isSettled).toBe(true);

    // One append long enough that the rope keeps it as several chunks of its own: every
    // character still arrives once and in order, at every stop.
    const numbered = Array.from(
      { length: 1_000 },
      (_, index) => `${String(index).padStart(4, "0")} `,
    );
    const longSource = numbered.join("");
    const longRope = fedWith([longSource]);
    while (!longRope.isSettled) {
      longRope.advance(777);
      expect(longSource.startsWith(longRope.slice(0))).toBe(true);
      expect(longRope.isPrefixOf(longSource)).toBe(true);
    }
    expect(longRope.slice(0)).toBe(longSource);
  });

  it("never moves the cursor backwards, and never reveals on a negative budget", () => {
    const rope = fedWith(["abcdef"]);
    rope.advance(3);
    expect(rope.advance(-10)).toBe(0);
    expect(rope.slice(0)).toBe("abc");
    expect(rope.length).toBe(3);
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

  it("still recognizes its source once the cursor stands inside it", () => {
    // Each refused candidate differs in a different place: before the cursor, just past it, and
    // in the last append.
    const rope = fedWith(["The run ", "started ", "at noon"]);
    rope.advance(11);
    expect(rope.isPrefixOf("The run started at noon, and ended")).toBe(true);
    expect(rope.isPrefixOf("The ran started at noon, and ended")).toBe(false);
    expect(rope.isPrefixOf("The run starved at noon, and ended")).toBe(false);
    expect(rope.isPrefixOf("The run started at dusk, and ended")).toBe(false);
  });
});

describe("the reveal text rope — reading across chunk boundaries", () => {
  it("reads every range exactly, with no character lost or repeated at a chunk edge", () => {
    // Appends of odd sizes, so the last chunk is refilled across appends and the edges fall
    // inside appends rather than between them.
    const source = Array.from({ length: 2_000 }, (_, index) => `${String(index)}|`).join("");
    expect(source.length).toBeGreaterThan(REVEAL_TEXT_CHUNK_CHARACTERS * 3);
    const rope = new RevealTextRope("lane-1");
    for (let start = 0; start < source.length; start += 337) {
      rope.append(source.slice(start, start + 337));
    }
    const revealedLength = REVEAL_TEXT_CHUNK_CHARACTERS * 3 - 5;
    rope.advance(revealedLength);
    const revealed = source.slice(0, revealedLength);

    expect(rope.slice(0)).toBe(revealed);
    expect(rope.chunks().join("")).toBe(revealed);
    for (const edge of [REVEAL_TEXT_CHUNK_CHARACTERS, REVEAL_TEXT_CHUNK_CHARACTERS * 2]) {
      for (const [start, end] of [
        [edge - 1, edge + 1],
        [edge, edge + 3],
        [edge - 3, edge],
        [edge - 2, edge + REVEAL_TEXT_CHUNK_CHARACTERS + 2],
      ] as const) {
        expect(rope.slice(start, end)).toBe(revealed.slice(start, end));
      }
      expect(rope.indexOf("|", edge - 2)).toBe(revealed.indexOf("|", edge - 2));
    }
    // Nothing past the cursor is read, even inside the chunk the cursor stands in.
    expect(rope.slice(revealedLength - 2, revealedLength + 10)).toBe(revealed.slice(-2));
    expect(rope.indexOf("|", revealedLength)).toBe(-1);
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
      expect(allowed.has(rope.slice(0))).toBe(true);
    }
  });

  it("snaps across a chunk edge, where the halves arrived in separate appends", () => {
    // The leading half ends one chunk and the trailing half opens the next, so the check reads
    // the pair from two chunks, as it does a pair split across two appends.
    const opening = "a".repeat(REVEAL_TEXT_CHUNK_CHARACTERS - 1);
    const rope = fedWith([opening, GRINNING_FACE.slice(0, 1), `${GRINNING_FACE.slice(1)}cd`]);
    expect(rope.advance(REVEAL_TEXT_CHUNK_CHARACTERS)).toBe(REVEAL_TEXT_CHUNK_CHARACTERS + 1);
    expect(rope.slice(0)).toBe(`${opening}${GRINNING_FACE}`);
  });

  it("publishes a producer-split lone surrogate at the source end rather than stalling", () => {
    // The source, not the budget, cut this one. Withholding it would hold the lane
    // on text that may never arrive; publishing it self-heals on the next append.
    const rope = fedWith([`ab${GRINNING_FACE.slice(0, 1)}`]);
    expect(rope.advance(100)).toBe(3);
    expect(rope.isSettled).toBe(true);
    rope.append(`${GRINNING_FACE.slice(1)}cd`);
    rope.advance(100);
    expect(rope.slice(0)).toBe(`ab${GRINNING_FACE}cd`);
  });
});
