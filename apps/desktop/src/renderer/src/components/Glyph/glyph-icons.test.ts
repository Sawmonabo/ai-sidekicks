// Every face, read back off the rendered DOM: the faces are compiled from two icon sets, so
// geometry is a property of the compiled output. Weight is checked as the stroke's share of
// its own viewBox, and each face body must set none of the inherited stroke attributes.

import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import {
  GLYPH_NAMES,
  GLYPH_STROKE_WIDTH,
  GLYPH_VIEWBOX_SIZE,
  type GlyphName,
} from "@renderer/styles/glyphs.js";
import { GLYPH_ICONS } from "./glyph-icons.js";
import { Glyph, type GlyphProps } from "./Glyph.js";

/** The share of its own box every face's stroke must occupy. */
const STROKE_SHARE_OF_BOX = GLYPH_STROKE_WIDTH / GLYPH_VIEWBOX_SIZE;

/** Presentation attributes the root must carry and no element below it may override. */
const GLYPH_SET_PRESENTATION: Readonly<Record<string, string>> = {
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

/** Every way one face departs from the set's geometry, named for a failure. */
function geometryDeparturesOf(label: string, face: SVGSVGElement): readonly string[] {
  const departures: string[] = [];
  for (const [attribute, expected] of Object.entries(GLYPH_SET_PRESENTATION)) {
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
      `${label} strokes at ${String(share)} of its box, not the set's ${String(STROKE_SHARE_OF_BOX)}`,
    );
  }
  for (const drawn of Array.from(face.querySelectorAll("*"))) {
    for (const attribute of [...Object.keys(GLYPH_SET_PRESENTATION), "stroke-width"]) {
      if (drawn.hasAttribute(attribute)) {
        departures.push(`${label} sets ${attribute} on a <${drawn.tagName}>, overriding the root`);
      }
    }
  }
  return departures;
}

/** The one `<svg>` a `Glyph` renders, or a failure that says which name had none. */
function renderFace(name: GlyphName, size: number, title?: string): SVGSVGElement {
  // `exactOptionalPropertyTypes` distinguishes an absent `title` from an undefined one.
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
    // The type rejects a missing row; this catches a specifier that resolved to nothing.
    const undrawn = GLYPH_NAMES.filter((name) => GLYPH_ICONS[name] === undefined);
    expect(undrawn).toStrictEqual([]);
    expect(Object.keys(GLYPH_ICONS).sort()).toStrictEqual([...GLYPH_NAMES].sort());
  });

  it("draws from both collections, so neither half of the pairing is empty", () => {
    // The geometry check would pass if only one collection resolved; the viewBox is what
    // the two collections do not share.
    const boxes = new Set(
      GLYPH_NAMES.map((name) => renderFace(name, GLYPH_VIEWBOX_SIZE).getAttribute("viewBox")),
    );
    expect(boxes).toContain(`0 0 ${String(GLYPH_VIEWBOX_SIZE)} ${String(GLYPH_VIEWBOX_SIZE)}`);
    expect(boxes).toContain("0 0 24 24");
  });
});

describe("the glyph faces — one geometry, whichever collection a face came from", () => {
  for (const name of GLYPH_NAMES) {
    it(`${name} renders at the set's stroke share with a silent body`, () => {
      expect(geometryDeparturesOf(name, renderFace(name, GLYPH_VIEWBOX_SIZE))).toStrictEqual([]);
    });
  }

  it("negative control: reports a face that kept the weight its icon set drew it at", () => {
    // An un-normalized Tabler face: a 24-unit box with its own 2-unit stroke on the path.
    // Without it the sweep above would hold even if it compared no attributes.
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

  it("carries the set's class, so one stylesheet reaches every glyph", () => {
    expect(renderFace("plus", 16).getAttribute("class")).toBe("meridian-glyph");
  });
});
