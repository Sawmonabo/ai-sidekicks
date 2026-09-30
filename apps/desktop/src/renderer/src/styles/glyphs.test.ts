// The glyph vocabulary, held to what a name set can be held to. The faces are compiled
// components, so their geometry is checked in `components/Glyph/glyph-icons.test.ts`, which
// renders every face and reads the geometry back. Here: each name appears once, the guard is
// total over the set and fail-closed off it (the path a wire value takes before a view indexes
// the face map), and the size scale is in order.

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
    // The gallery route and the screenshot tier walk this, so a repeated name renders a picture
    // twice under one heading and makes the set smaller than it reads.
    expect(GLYPH_NAMES.length).toBeGreaterThan(0);
    expect(new Set(GLYPH_NAMES).size).toBe(GLYPH_NAMES.length);
  });

  it("names every glyph in lower kebab case, as an icon specifier is written", () => {
    // A name is half of `~icons/<collection>/<name>`, and both collections resolve their files and
    // icon ids in this shape.
    const misnamed = GLYPH_NAMES.filter((name) => !/^[a-z]+(-[a-z]+)*$/.test(name));
    expect(misnamed).toStrictEqual([]);
  });

  it("carries a rewind and a fold, the two marks the transcript's turn controls need", () => {
    // Named because the sweep above holds over whatever the set contains and would pass the day
    // one of these was deleted. They draw a superseded turn and a compaction boundary.
    expect(GLYPH_NAMES).toContain("rewind");
    expect(GLYPH_NAMES).toContain("fold");
  });
});

describe("isGlyphName — the fail-closed projection a wire value passes through", () => {
  it("accepts every name in the set", () => {
    const rejected = GLYPH_NAMES.filter((name) => !isGlyphName(name));
    expect(rejected).toStrictEqual([]);
  });

  it("rejects a name the set does not have", () => {
    // The caller renders the unrecognized shape on false, not an index into the face map.
    expect(isGlyphName("gear")).toBe(false);
    expect(isGlyphName("")).toBe(false);
  });

  it("negative control: rejects an inherited Object key, which a record lookup would accept", () => {
    // Why the guard reads the array rather than a record's keys: "toString" or "constructor"
    // would otherwise pass as a glyph and index to a function.
    expect(isGlyphName("toString")).toBe(false);
    expect(isGlyphName("constructor")).toBe(false);
    expect(isGlyphName("__proto__")).toBe(false);
  });
});

describe("the glyph set — the geometry every face is compiled to", () => {
  it("strokes narrowly enough to sit inside its own box", () => {
    expect(GLYPH_STROKE_WIDTH).toBeGreaterThan(0);
    expect(GLYPH_STROKE_WIDTH).toBeLessThan(GLYPH_VIEWBOX_SIZE);
  });

  it("renders at a positive default edge length, no larger than the box", () => {
    expect(GLYPH_DEFAULT_SIZE).toBeGreaterThan(0);
    // A size above the box would upscale the stroke past the one weight the geometry fixes.
    expect(GLYPH_DEFAULT_SIZE).toBeLessThanOrEqual(GLYPH_VIEWBOX_SIZE);
  });
});

describe("the icon scale — three steps, in order, all subordinate to the default", () => {
  // One array, so the ordering claim covers the whole scale and a fourth step is covered without
  // an assertion having to be remembered for it.
  const SCALE = [GLYPH_SIZE_DENSE, GLYPH_SIZE_ROW, GLYPH_SIZE_CHROME];

  it("increases strictly, so no two steps are the same size under two names", () => {
    const ascending = SCALE.every(
      (size, index) => index === 0 || size > (SCALE[index - 1] ?? Number.POSITIVE_INFINITY),
    );
    expect(ascending).toBe(true);
  });

  it("negative control: the same check fails on a scale that repeats or inverts", () => {
    // Two callers at 12 under two names would pass a `<=` comparison and is what a scale must
    // not be.
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
