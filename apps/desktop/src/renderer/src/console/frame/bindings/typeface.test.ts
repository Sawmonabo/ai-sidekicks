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
  // actually gets, so it is also the better witness. It is also the assertion that
  // catches the descriptor the variable builds make easy to get wrong: these files
  // are named `IBM Plex Sans Var` internally, and a face declared under that name
  // would load and be asked for by nothing.
  it("supply every family the token sheet's stacks name first", () => {
    const sheet = generateMeridianCss();
    for (const family of new Set(TYPEFACE_FACES.map((face) => face.family))) {
      expect(sheet).toContain(`"${family}"`);
    }
  });

  it("ship one variable file per family and no per-weight cuts", () => {
    expect(TYPEFACE_FACES.map((face) => face.family)).toStrictEqual([
      "IBM Plex Sans",
      "IBM Plex Mono",
    ]);
  });

  // The whole point of the variable build over the six static cuts it replaced:
  // 640 is a weight `palette/palette.css` asks for, and under static instances it
  // resolved to the nearest declared face. A range that stopped covering it would
  // reintroduce that silently, so the console's own extremes are asserted against
  // the declared range rather than the range being asserted against itself.
  it("declare a weight range that covers every weight the console asks for", () => {
    for (const face of TYPEFACE_FACES) {
      const [lowestWeight, highestWeight] = face.weightRange
        .split(" ")
        .map((bound) => Number.parseInt(bound, 10));
      expect(lowestWeight).toBeLessThanOrEqual(400);
      expect(highestWeight).toBeGreaterThanOrEqual(640);
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
      expect(decodeURIComponent(face.url).split(" ").join("")).toContain(familySegment);
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

  it("carries every face's own family, axes, and bytes", () => {
    for (const face of TYPEFACE_FACES) {
      expect(css).toContain(`font-family: "${face.family}";`);
      expect(css).toContain(`font-weight: ${face.weightRange};`);
      expect(css).toContain(`url("${face.url}") format("woff2")`);
    }
  });

  // A `font-stretch` descriptor NARROWS what the browser will take from the file,
  // so declaring one over a file with no width axis is a claim about bytes that
  // are not there. Only the sans build carries `wdth`, so only the sans rule may
  // carry the descriptor — asserted from the face's own record so the sheet and
  // the roster cannot disagree about which file has an axis.
  it("bounds the width axis only where the file carries one", () => {
    const stretchDeclarations = css.match(/font-stretch: /g) ?? [];
    expect(stretchDeclarations).toHaveLength(
      TYPEFACE_FACES.filter((face) => face.stretchRange !== null).length,
    );
    expect(css).toContain("font-stretch: 85% 100%;");
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

  // Each face bounds itself to the codepoints its OWN split carries, and the two
  // splits do not carry the same set — the sans file covers `U+0000` and `U+000D`
  // and the mono file does not. One shared range would over-claim for one of them,
  // which is a glyph rendered from the wrong file rather than fallen through.
  it("bounds every face to the subset it actually contains", () => {
    expect(css.match(/unicode-range: /g)).toHaveLength(TYPEFACE_FACES.length);
    for (const face of TYPEFACE_FACES) {
      expect(css).toContain(`unicode-range: ${face.unicodeRange};`);
    }
    expect(new Set(TYPEFACE_FACES.map((face) => face.unicodeRange)).size).toBe(
      TYPEFACE_FACES.length,
    );
  });

  it("is deterministic", () => {
    expect(generateTypefaceCss()).toBe(css);
  });
});
