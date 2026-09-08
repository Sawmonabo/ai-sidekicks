// Every face the console can draw, read back off the DOM it renders.
//
// `tokens/glyphs.ts` rule 1 says the family is one geometry and rule 2 says it is
// one vocabulary of parts. Since the faces are compiled — half of them borrowed
// from an icon set drawn at a different box and a different weight — neither
// rule is a property of anything in this tree any more. Both are properties of
// what `vitest/icon-compilation.ts` emitted, and the only honest place to check
// them is on a rendered element.
//
// THE WEIGHT IS CHECKED AS A RATIO, not as a number. A face drawn in a 24-unit
// box needs a wider stroke than one drawn in a 16-unit box to render at the same
// pixel weight, so what "one family, one weight" means is that every face's
// `stroke-width` is the same SHARE of its own `viewBox`. Reading the viewBox back
// off the face is also what makes the check independent of the collection table
// the plugin holds: a set that moved its box fails here rather than shipping a
// family drawn at two weights.
//
// AND THE BODY IS CHECKED FOR SILENCE. All five attributes inherit, so a face
// whose `<path>` kept the stroke it arrived with would draw at that stroke no
// matter what the root says — the root would be right and the picture wrong.
// That is exactly the shape an un-normalized Tabler face has, and it is what the
// negative control plants.

import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import {
  GLYPH_NAMES,
  GLYPH_STROKE_WIDTH,
  GLYPH_VIEWBOX_SIZE,
  type GlyphName,
} from "../../tokens/glyphs.js";
import { GLYPH_FACES } from "./glyph-faces.js";
import { Glyph, type GlyphProps } from "./Glyph.js";

/** The share of its own box every face's stroke must occupy. */
const STROKE_SHARE_OF_BOX = GLYPH_STROKE_WIDTH / GLYPH_VIEWBOX_SIZE;

/**
 * The presentation attributes the family owns.
 *
 * The root must carry all five, and no element below it may carry any: an
 * inherited attribute is overridden by the nearest one that sets it.
 */
const FAMILY_PRESENTATION: Readonly<Record<string, string>> = {
  fill: "none",
  stroke: "currentColor",
  "stroke-linecap": "round",
  "stroke-linejoin": "round",
};

/** The stroke share a face actually renders at, or `undefined` if it declares none. */
function strokeShareOf(face: SVGSVGElement): number | undefined {
  const declaredWidth = face.getAttribute("stroke-width");
  const viewBox =
    face
      .getAttribute("viewBox")
      ?.trim()
      .split(/[\s,]+/) ?? [];
  const boxWidth = Number(viewBox[2]);
  if (
    declaredWidth === null ||
    viewBox.length !== 4 ||
    !Number.isFinite(boxWidth) ||
    boxWidth <= 0
  ) {
    return undefined;
  }
  return Number(declaredWidth) / boxWidth;
}

/** Every way one face departs from the family's geometry, named for a failure. */
function geometryDeparturesOf(label: string, face: SVGSVGElement): readonly string[] {
  const departures: string[] = [];
  for (const [attribute, expected] of Object.entries(FAMILY_PRESENTATION)) {
    const actual = face.getAttribute(attribute);
    if (actual !== expected) {
      departures.push(`${label} declares ${attribute}="${actual ?? ""}", not "${expected}"`);
    }
  }
  const share = strokeShareOf(face);
  if (share === undefined) {
    departures.push(`${label} declares no stroke-width against a readable viewBox`);
  } else if (Math.abs(share - STROKE_SHARE_OF_BOX) > 1e-9) {
    departures.push(
      `${label} strokes at ${String(share)} of its box, not the family's ${String(STROKE_SHARE_OF_BOX)}`,
    );
  }
  for (const drawn of Array.from(face.querySelectorAll("*"))) {
    for (const attribute of [...Object.keys(FAMILY_PRESENTATION), "stroke-width"]) {
      if (drawn.hasAttribute(attribute)) {
        departures.push(`${label} sets ${attribute} on a <${drawn.tagName}>, overriding the root`);
      }
    }
  }
  return departures;
}

/** The one `<svg>` a `Glyph` renders, or a failure that says which name had none. */
function renderFace(name: GlyphName, size: number, title?: string): SVGSVGElement {
  // Composed conditionally rather than passed as `title: undefined`, because
  // `exactOptionalPropertyTypes` makes an absent prop and a present undefined
  // one two different things — and the component's whole accessibility rule
  // turns on which of the two it was given.
  const props: GlyphProps = title === undefined ? { name, size } : { name, size, title };
  const { container } = render(createElement(Glyph, props));
  const face = container.querySelector("svg");
  if (face === null) {
    throw new Error(`the glyph "${name}" rendered no <svg>`);
  }
  return face;
}

afterEach(() => {
  cleanup();
});

describe("the glyph faces — the map is total over the name set", () => {
  it("draws every name and names every drawing", () => {
    // The `Record<GlyphName, …>` type already makes a missing row a compile
    // error. What it cannot say is that a row holds a component rather than
    // `undefined`, which is what an icon specifier that resolved to nothing
    // would leave behind.
    const undrawn = GLYPH_NAMES.filter((name) => GLYPH_FACES[name] === undefined);
    expect(undrawn).toStrictEqual([]);
    expect(Object.keys(GLYPH_FACES).sort()).toStrictEqual([...GLYPH_NAMES].sort());
  });

  it("draws from both collections, so neither half of the pairing is empty", () => {
    // `Spec-023 §Console Design (Meridian)` asks for a borrowed single-stroke set
    // AND our own signature glyphs in the same collection. Read as the two BOXES
    // rather than as a count of distinct components: the geometry below is
    // imposed on both collections, so it would pass just as cleanly on a build
    // that resolved only one of them — and the box is the one thing the two do
    // not share.
    const boxes = new Set(
      GLYPH_NAMES.map((name) => renderFace(name, GLYPH_VIEWBOX_SIZE).getAttribute("viewBox")),
    );
    expect(boxes).toContain(`0 0 ${String(GLYPH_VIEWBOX_SIZE)} ${String(GLYPH_VIEWBOX_SIZE)}`);
    expect(boxes).toContain("0 0 24 24");
  });
});

describe("the glyph faces — one geometry, whichever collection a face came from", () => {
  for (const name of GLYPH_NAMES) {
    it(`${name} renders at the family's stroke share with a silent body`, () => {
      expect(geometryDeparturesOf(name, renderFace(name, GLYPH_VIEWBOX_SIZE))).toStrictEqual([]);
    });
  }

  it("negative control: reports a face that kept the weight its icon set drew it at", () => {
    // Exactly the shape an un-normalized Tabler face has — a 24-unit box with the
    // set's own 2-unit stroke on the drawing element — which is what the compile
    // step exists to remove. Without this the sweep above would hold over any
    // reading at all, including one that found no attributes to compare.
    const raw = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    raw.setAttribute("viewBox", "0 0 24 24");
    const drawn = document.createElementNS("http://www.w3.org/2000/svg", "path");
    drawn.setAttribute("fill", "none");
    drawn.setAttribute("stroke", "currentColor");
    drawn.setAttribute("stroke-width", "2");
    raw.append(drawn);

    const departures = geometryDeparturesOf("planted", raw);
    expect(departures).toContain('planted declares fill="", not "none"');
    expect(departures).toContain("planted declares no stroke-width against a readable viewBox");
    expect(departures).toContain("planted sets stroke on a <path>, overriding the root");
    expect(departures).toContain("planted sets stroke-width on a <path>, overriding the root");
  });
});

describe("Glyph — the size and the accessible name the caller decides", () => {
  it("renders at the size it is given, square", () => {
    const face = renderFace("run", 12);
    expect(face.getAttribute("width")).toBe("12");
    expect(face.getAttribute("height")).toBe("12");
  });

  it("is hidden from assistive technology when adjacent text already names it", () => {
    const face = renderFace("check", 16);
    expect(face.getAttribute("aria-hidden")).toBe("true");
    expect(face.getAttribute("role")).toBeNull();
    expect(face.getAttribute("aria-label")).toBeNull();
  });

  it("becomes an image carrying its title when the title is the control's only name", () => {
    const face = renderFace("close", 16, "Close the pane");
    expect(face.getAttribute("role")).toBe("img");
    expect(face.getAttribute("aria-label")).toBe("Close the pane");
    expect(face.getAttribute("aria-hidden")).toBeNull();
  });

  it("carries the family's class, so one stylesheet reaches every glyph", () => {
    expect(renderFace("plus", 16).getAttribute("class")).toBe("meridian-glyph");
  });
});
