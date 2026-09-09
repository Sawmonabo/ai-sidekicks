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

  it("ship one variable file per family and style, and no per-weight cuts", () => {
    expect(TYPEFACE_FACES.map((face) => `${face.family} ${face.style}`)).toStrictEqual([
      "IBM Plex Sans normal",
      "IBM Plex Sans italic",
      "IBM Plex Mono normal",
      "IBM Plex Mono italic",
    ]);
  });

  // Eleven rules across six stylesheets ask for `font-style: italic`, and both
  // families are reached. A family that declares only its upright face does not
  // lose those runs — the browser SYNTHESIZES an oblique by slanting the upright
  // outlines, which is a transform of the wrong drawing rather than the italic the
  // foundry cut, and `Spec-023 §Console Design (Meridian)` rule 4 names the faces
  // and not a slant of them. This is the assertion that keeps the omission from
  // being invisible: a family present with one style is a family whose italic runs
  // are faux, and nothing else in this file would notice.
  it("declare a real italic for every family, never a synthesized oblique", () => {
    for (const family of new Set(TYPEFACE_FACES.map((face) => face.family))) {
      const styles = TYPEFACE_FACES.filter((face) => face.family === family).map(
        (face) => face.style,
      );
      expect(styles, `${family} declares no real italic`).toContain("italic");
      expect(styles, `${family} declares no upright face`).toContain("normal");
    }
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

  // `font-style` is the descriptor that decides whether an italic run gets the
  // italic FILE or a slant of the upright one, so it is emitted per face rather
  // than written once into the generator. A block whose style did not match its
  // file's would load real italic outlines and then never be selected for an
  // italic run, which reads on screen exactly like the omission it replaced.
  it("declares each face under the style its own file carries", () => {
    for (const style of ["normal", "italic"]) {
      expect(css.match(new RegExp(`font-style: ${style};`, "g")) ?? []).toHaveLength(
        TYPEFACE_FACES.filter((face) => face.style === style).length,
      );
    }
    // Read block by block, because a style declared in the right COUNT and the
    // wrong block is the failure this is for: the sheet would carry one of each
    // and still serve the italic file to upright text.
    const blocks = css.split("@font-face").filter((block) => block.includes("src:"));
    expect(blocks).toHaveLength(TYPEFACE_FACES.length);
    for (const face of TYPEFACE_FACES) {
      const blockOfFace = blocks.find((block) => block.includes(`url("${face.url}")`));
      expect(blockOfFace, `no block declares ${face.url}`).toBeDefined();
      expect(blockOfFace).toContain(`font-style: ${face.style};`);
      expect(blockOfFace).toContain(`font-family: "${face.family}";`);
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
  // FAMILIES do not carry the same set — the sans files cover `U+0000` and `U+000D`
  // and the mono files do not. One range shared across families would over-claim for
  // one of them, which is a glyph rendered from the wrong file rather than fallen
  // through. Within a family the two styles DO publish one range, which is read out
  // of the packages rather than assumed, so the roster is asserted family-wise: two
  // distinct ranges over four faces, and never four.
  it("bounds every face to the subset it actually contains", () => {
    expect(css.match(/unicode-range: /g)).toHaveLength(TYPEFACE_FACES.length);
    for (const face of TYPEFACE_FACES) {
      expect(css).toContain(`unicode-range: ${face.unicodeRange};`);
    }
    const familyCount = new Set(TYPEFACE_FACES.map((face) => face.family)).size;
    expect(new Set(TYPEFACE_FACES.map((face) => face.unicodeRange)).size).toBe(familyCount);
    for (const family of new Set(TYPEFACE_FACES.map((face) => face.family))) {
      const rangesOfFamily = TYPEFACE_FACES.filter((face) => face.family === family).map(
        (face) => face.unicodeRange,
      );
      expect(new Set(rangesOfFamily).size, `${family} bounds its styles differently`).toBe(1);
    }
  });

  it("is deterministic", () => {
    expect(generateTypefaceCss()).toBe(css);
  });
});
