import { describe, expect, it } from "vitest";

import { generateMeridianCss } from "../../tokens/index.js";
import { TYPEFACE_FACES, generateTypefaceCss } from "./typeface.js";

describe("the self-hosted faces", () => {
  // The coupling that matters is between a face's family name and the name the
  // token sheet's stack asks for first: a typo in either leaves the console
  // silently on a system face, which is the exact failure self-hosting was added
  // to end. It is asserted against the GENERATED SHEET rather than against
  // `FONT_STACKS`, because that record is internal to the tokens family — putting
  // it on that family's door for a test would be a door line with no production
  // reader, which the barrel census fails. The sheet is what the document
  // actually gets, so it is also the better witness.
  it("supply every family the token sheet's stacks name first", () => {
    const sheet = generateMeridianCss();
    for (const family of new Set(TYPEFACE_FACES.map((face) => face.family))) {
      expect(sheet).toContain(`"${family}"`);
    }
  });

  it("cover the weights the console's stylesheets ask for, on both families", () => {
    for (const family of new Set(TYPEFACE_FACES.map((face) => face.family))) {
      const weights = TYPEFACE_FACES.filter((face) => face.family === family).map(
        (face) => face.weight,
      );
      expect(weights.sort((first, second) => first - second)).toStrictEqual([400, 500, 600]);
    }
  });

  // Asserted as "the bundler resolved it and it still names a woff2", which is
  // what holds in BOTH modes. The two shapes differ on purpose and neither is
  // wrong: a dev transform serves the file in place under `/@fs/`, and a
  // production build emits a content-hashed copy under the asset directory. A
  // test that demanded the hashed form would be asserting the build mode it
  // happens to run in, which is the tier's environment and not the module's
  // contract.
  it("resolve to a bundler-supplied URL naming the face's own file", () => {
    for (const face of TYPEFACE_FACES) {
      expect(face.url).toMatch(/\.woff2$/);
      const familySegment = face.family.split(" ").join("");
      expect(face.url).toContain(familySegment);
    }
  });

  it("give every face its own file", () => {
    expect(new Set(TYPEFACE_FACES.map((face) => face.url)).size).toBe(TYPEFACE_FACES.length);
  });
});

describe("the generated @font-face block", () => {
  const css = generateTypefaceCss();

  it("declares one face per entry and nothing else", () => {
    expect(css.match(/@font-face/g)).toHaveLength(TYPEFACE_FACES.length);
  });

  it("carries every face's own family, weight, and bytes", () => {
    for (const face of TYPEFACE_FACES) {
      expect(css).toContain(`font-family: "${face.family}";`);
      expect(css).toContain(`font-weight: ${face.weight};`);
      expect(css).toContain(`url("${face.url}") format("woff2")`);
    }
  });

  it("never falls back to a host-installed face", () => {
    // `local()` would hand rendering to whichever Plex the machine has, which is
    // the one thing self-hosting exists to prevent.
    expect(css).not.toContain("local(");
  });

  it("blocks rather than swaps, so no ledger row is laid out twice", () => {
    expect(css.match(/font-display: block;/g)).toHaveLength(TYPEFACE_FACES.length);
    expect(css).not.toContain("font-display: swap");
  });

  it("bounds every face to the subset it actually contains", () => {
    expect(css.match(/unicode-range: /g)).toHaveLength(TYPEFACE_FACES.length);
    expect(css).toContain("U+0020-007E");
  });

  it("is deterministic", () => {
    expect(generateTypefaceCss()).toBe(css);
  });
});
