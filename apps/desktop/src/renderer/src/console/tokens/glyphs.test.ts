// The glyph family, held to the three rules that make it a family.
//
// The rules are stated in `glyphs.ts` as prose, and prose is exactly what a pasted
// path from another icon set passes. Two of the three are checkable from the data
// alone and are checked here:
//
//   • Rule 1 / rule 2 — one `d` string per glyph, no groups, no fills, no per-glyph
//     rendering options. A value carrying markup, an attribute, or a style is a
//     glyph that has brought its own rendering, and `Glyph.tsx` would either drop it
//     or draw something the family did not author.
//   • Rule 3 — a closed name set. `GlyphName` is now the record's keys, so
//     exhaustiveness is a compile-time tautology; what is left to check is that
//     `GLYPH_NAMES` really is those keys in their declared order, because the
//     gallery and the per-glyph screenshot cases are generated from it.
//
// What is NOT checked is the geometry inside a path. Bounding a path properly means
// parsing relative commands and arc flags, and a half-parser that read arc flags as
// coordinates would report failures that are not there. The entry point — the
// opening absolute moveto — is read instead, and the case says so.

import { describe, expect, it } from "vitest";
import {
  GLYPH_DEFAULT_SIZE,
  GLYPH_NAMES,
  GLYPH_PATHS,
  GLYPH_SIZE_CHROME,
  GLYPH_SIZE_DENSE,
  GLYPH_SIZE_ROW,
  GLYPH_STROKE_WIDTH,
  GLYPH_VIEWBOX_SIZE,
  isGlyphName,
} from "./glyphs.js";

/**
 * Everything an SVG path may contain: command letters, numbers, and separators.
 *
 * Anything else means the value stopped being a bare `d` string — markup, an
 * attribute, a `url(...)` paint reference, a style declaration.
 */
const PATH_CHARACTERS = /^[MmLlHhVvCcSsQqTtAaZz0-9.,+\-\s]+$/;

/** The opening absolute moveto's coordinate pair, which every path starts with. */
function openingPoint(path: string): { x: number; y: number } | undefined {
  const opening = /^M\s*(-?[\d.]+)[\s,]+(-?[\d.]+)/.exec(path);
  const x = opening?.[1];
  const y = opening?.[2];
  if (x === undefined || y === undefined) {
    return undefined;
  }
  return { x: Number(x), y: Number(y) };
}

describe("the glyph family — GLYPH_NAMES is the record, not a second list", () => {
  it("is exactly the record's keys, in declaration order", () => {
    // The gallery route walks this and the screenshot tier generates a case per
    // entry, so a name missing here is a glyph nothing ever renders in a test.
    expect(GLYPH_NAMES).toStrictEqual(Object.keys(GLYPH_PATHS));
  });

  it("names each glyph once and names at least one", () => {
    expect(GLYPH_NAMES.length).toBeGreaterThan(0);
    expect(new Set(GLYPH_NAMES).size).toBe(GLYPH_NAMES.length);
  });

  it("names every glyph in lower kebab case, as the record's keys are written", () => {
    const misnamed = GLYPH_NAMES.filter((name) => !/^[a-z]+(-[a-z]+)*$/.test(name));
    expect(misnamed).toStrictEqual([]);
  });

  it("draws each glyph once, so no two names render the same picture", () => {
    // Rule 3's other half. A closed name set says nothing about the DRAWINGS
    // behind it, and the way a family loses a member is a paste: a new name added
    // beside an existing path, which type-checks, renders, and passes every case
    // above while putting one picture behind two meanings. The two names then
    // drift apart in copy and stay identical on screen.
    const pathsByName = new Map<string, string[]>();
    for (const name of GLYPH_NAMES) {
      const sharing = pathsByName.get(GLYPH_PATHS[name]) ?? [];
      sharing.push(name);
      pathsByName.set(GLYPH_PATHS[name], sharing);
    }
    const shared = [...pathsByName.values()].filter((names) => names.length > 1);

    expect(shared).toStrictEqual([]);
  });

  it("negative control: reports two names that DO share one path", () => {
    // Without this the check above would hold over any grouping at all, including
    // one that keyed on the name and could never report a collision.
    const duplicated: Record<string, string> = {
      timeline: GLYPH_PATHS.timeline,
      ledger: GLYPH_PATHS.timeline,
    };
    const pathsByName = new Map<string, string[]>();
    for (const [name, path] of Object.entries(duplicated)) {
      const sharing = pathsByName.get(path) ?? [];
      sharing.push(name);
      pathsByName.set(path, sharing);
    }

    expect([...pathsByName.values()].filter((names) => names.length > 1)).toStrictEqual([
      ["timeline", "ledger"],
    ]);
  });
});

describe("the glyph family — one d string per glyph", () => {
  for (const name of GLYPH_NAMES) {
    it(`${name} is a bare path that starts at an absolute moveto`, () => {
      const path = GLYPH_PATHS[name];
      expect(path.length).toBeGreaterThan(0);
      expect(path.startsWith("M")).toBe(true);
      expect(PATH_CHARACTERS.test(path), path).toBe(true);
    });

    it(`${name} enters the drawing inside the ${String(GLYPH_VIEWBOX_SIZE)}-unit box`, () => {
      // The opening point only, deliberately: see the header. A path whose FIRST
      // point is outside the box is drawn for a different viewBox entirely.
      const point = openingPoint(GLYPH_PATHS[name]);
      expect(point).toBeDefined();
      expect(point?.x).toBeGreaterThanOrEqual(0);
      expect(point?.x).toBeLessThanOrEqual(GLYPH_VIEWBOX_SIZE);
      expect(point?.y).toBeGreaterThanOrEqual(0);
      expect(point?.y).toBeLessThanOrEqual(GLYPH_VIEWBOX_SIZE);
    });
  }

  it("negative control: the same checks reject a glyph that brought its own rendering", () => {
    // Without this, a permissive pattern — or one that matched the empty string —
    // would pass every case above over any value at all.
    expect(PATH_CHARACTERS.test('M0 0h4" fill="currentColor')).toBe(false);
    expect(PATH_CHARACTERS.test('<path d="M0 0h4"/>')).toBe(false);
    expect(PATH_CHARACTERS.test("M0 0 url(#gradient)")).toBe(false);
    expect(openingPoint("h4v4")).toBeUndefined();
  });
});

describe("the glyph family — the two marks the ledger's turn controls need", () => {
  it("carries a rewind and a fold, each drawn as its own path", () => {
    // Named rather than left to the sweep above, because the sweep holds over
    // whatever the record happens to contain: it would pass just as cleanly on the
    // day one of these was deleted. These two are what a superseded turn and a
    // compaction boundary are drawn with, so their presence is a claim worth
    // stating once.
    expect(GLYPH_NAMES).toContain("rewind");
    expect(GLYPH_NAMES).toContain("fold");
    expect(GLYPH_PATHS.rewind).not.toBe(GLYPH_PATHS.fold);
  });
});

describe("isGlyphName — the fail-closed projection a wire value passes through", () => {
  it("accepts every name in the family", () => {
    const rejected = GLYPH_NAMES.filter((name) => !isGlyphName(name));
    expect(rejected).toStrictEqual([]);
  });

  it("rejects a name the family does not have", () => {
    // The caller renders the unrecognized shape on a false, rather than indexing
    // the record and drawing an empty box.
    expect(isGlyphName("gear")).toBe(false);
    expect(isGlyphName("")).toBe(false);
  });

  it("negative control: rejects an inherited Object key, which `in` would accept", () => {
    // This is why the guard reads `hasOwnProperty` rather than `value in
    // GLYPH_PATHS`. A wire value of "toString" or "constructor" would otherwise be
    // reported as a glyph and then indexed to a function.
    expect(isGlyphName("toString")).toBe(false);
    expect(isGlyphName("constructor")).toBe(false);
    expect(isGlyphName("__proto__")).toBe(false);
  });
});

describe("the glyph family — the geometry every glyph shares", () => {
  it("strokes narrowly enough to sit inside its own box", () => {
    expect(GLYPH_STROKE_WIDTH).toBeGreaterThan(0);
    expect(GLYPH_STROKE_WIDTH).toBeLessThan(GLYPH_VIEWBOX_SIZE);
  });

  it("renders at a positive default edge length", () => {
    expect(GLYPH_DEFAULT_SIZE).toBeGreaterThan(0);
  });

  it("draws chrome smaller than the default, and both inside the box", () => {
    // The two sizes are a RATIO rather than two preferences, which is the whole
    // reason they live in one module: a chrome mark reads quiet against a kind mark
    // only while it is the smaller of the pair. Pinned as an ordering rather than as
    // the numbers, so re-scaling the family moves both and fails neither.
    expect(GLYPH_SIZE_CHROME).toBeGreaterThan(0);
    expect(GLYPH_SIZE_CHROME).toBeLessThan(GLYPH_DEFAULT_SIZE);
    // Both are edge lengths for the same 16-unit path data. A size above the box
    // would upscale the stroke past the weight rule 1 fixes.
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
