// The glyph vocabulary, held to what a NAME set can be held to.
//
// The three rules are stated in `glyphs.ts` as prose. Since the faces became
// compiled components, rules 1 and 2 are properties of a rendered `<svg>` rather
// than of a string in this module, and they are checked next door in
// `primitives/glyph-faces.test.ts`, which renders every face and reads the
// geometry back off it. What is left here is rule 3, and it has two halves:
//
//   • The set is CLOSED and each name appears once. `GlyphName` is now the
//     array's own members, so exhaustiveness is a compile-time tautology; what a
//     test can still catch is a name added twice, or added in a shape the rest
//     of the set is not written in.
//   • The guard is TOTAL over it and fail-closed off it, because that is the
//     path a wire value takes before a surface indexes the face map.
//
// The scale is checked here too, for the reason it lives here: three steps that
// only mean something in order.

import { describe, expect, it } from "vitest";
import {
  GLYPH_DEFAULT_SIZE,
  GLYPH_NAMES,
  GLYPH_SIZE_CHROME,
  GLYPH_SIZE_DENSE,
  GLYPH_SIZE_ROW,
  GLYPH_STROKE_WIDTH,
  GLYPH_VIEWBOX_SIZE,
  isGlyphName,
} from "./glyphs.js";

describe("the glyph vocabulary — one closed set of names", () => {
  it("names each glyph once and names at least one", () => {
    // The gallery route walks this and the screenshot tier generates a case per
    // entry, so a name repeated here is a picture rendered twice under one
    // heading and a set that is smaller than it reads.
    expect(GLYPH_NAMES.length).toBeGreaterThan(0);
    expect(new Set(GLYPH_NAMES).size).toBe(GLYPH_NAMES.length);
  });

  it("names every glyph in lower kebab case, as an icon specifier is written", () => {
    // Not a style rule: a name is half of `~icons/<collection>/<name>`, and both
    // collections resolve their files and their icon ids in this shape.
    const misnamed = GLYPH_NAMES.filter((name) => !/^[a-z]+(-[a-z]+)*$/.test(name));
    expect(misnamed).toStrictEqual([]);
  });

  it("carries a rewind and a fold, the two marks the ledger's turn controls need", () => {
    // Named rather than left to the sweep above, because the sweep holds over
    // whatever the set happens to contain: it would pass just as cleanly on the
    // day one of these was deleted. These two are what a superseded turn and a
    // compaction boundary are drawn with, so their presence is a claim worth
    // stating once.
    expect(GLYPH_NAMES).toContain("rewind");
    expect(GLYPH_NAMES).toContain("fold");
  });
});

describe("isGlyphName — the fail-closed projection a wire value passes through", () => {
  it("accepts every name in the family", () => {
    const rejected = GLYPH_NAMES.filter((name) => !isGlyphName(name));
    expect(rejected).toStrictEqual([]);
  });

  it("rejects a name the family does not have", () => {
    // The caller renders the unrecognized shape on a false, rather than indexing
    // the face map and drawing nothing.
    expect(isGlyphName("gear")).toBe(false);
    expect(isGlyphName("")).toBe(false);
  });

  it("negative control: rejects an inherited Object key, which a record lookup would accept", () => {
    // This is why the guard reads the ARRAY rather than a record's keys. A wire
    // value of "toString" or "constructor" would otherwise be reported as a
    // glyph and then indexed to a function.
    expect(isGlyphName("toString")).toBe(false);
    expect(isGlyphName("constructor")).toBe(false);
    expect(isGlyphName("__proto__")).toBe(false);
  });
});

describe("the glyph family — the geometry every face is compiled to", () => {
  it("strokes narrowly enough to sit inside its own box", () => {
    expect(GLYPH_STROKE_WIDTH).toBeGreaterThan(0);
    expect(GLYPH_STROKE_WIDTH).toBeLessThan(GLYPH_VIEWBOX_SIZE);
  });

  it("renders at a positive default edge length, no larger than the box", () => {
    expect(GLYPH_DEFAULT_SIZE).toBeGreaterThan(0);
    // Both are edge lengths for the same drawing. A size above the box would
    // upscale the stroke past the weight rule 1 fixes.
    expect(GLYPH_DEFAULT_SIZE).toBeLessThanOrEqual(GLYPH_VIEWBOX_SIZE);
  });
});

describe("the icon scale — three steps, in order, all subordinate to the default", () => {
  // Read as one array rather than as three comparisons, so the ordering claim is made
  // over the whole scale: a fourth step inserted anywhere is covered by the same case
  // without an assertion having to be remembered for it.
  const SCALE = [GLYPH_SIZE_DENSE, GLYPH_SIZE_ROW, GLYPH_SIZE_CHROME];

  it("increases strictly, so no two steps are the same size under two names", () => {
    const ascending = SCALE.every(
      (size, index) => index === 0 || size > (SCALE[index - 1] ?? Number.POSITIVE_INFINITY),
    );
    expect(ascending).toBe(true);
  });

  it("negative control: the same check fails on a scale that repeats or inverts", () => {
    // The shape the eight per-component copies had — two callers at 12 under two
    // names — would pass a `<=` comparison and is exactly what a scale must not be.
    const repeated = [10, 12, 12];
    const inverted = [14, 12, 10];
    for (const candidate of [repeated, inverted]) {
      const ascending = candidate.every(
        (size, index) => index === 0 || size > (candidate[index - 1] ?? Number.POSITIVE_INFINITY),
      );
      expect(ascending).toBe(false);
    }
  });

  it("sits entirely below the standalone default, because every step is subordinate", () => {
    for (const size of SCALE) {
      expect(size).toBeGreaterThan(0);
      expect(size).toBeLessThan(GLYPH_DEFAULT_SIZE);
    }
  });
});
