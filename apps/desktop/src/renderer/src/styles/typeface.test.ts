import { describe, expect, it } from "vitest";

import { generateMeridianCss } from "./generate-css.js";
import { TYPEFACE_FACES, generateTypefaceCss } from "./typeface.js";

describe("the self-hosted faces", () => {
  // A face's family name must match the name the token sheet's stack asks for first: a typo in
  // either leaves the console silently on a system face. Asserted against the generated sheet,
  // the document's actual input. It also catches a face declared under `IBM Plex Sans Var`, the
  // files' internal name, which would load and be asked for by nothing.
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

  // Seven rules across five stylesheets ask for `font-style: italic`, and both families are
  // reached. A family declaring only its upright face gets a synthesized oblique, a slant of the
  // wrong drawing, and nothing else in this file would notice the omission.
  it("declare a real italic for every family, never a synthesized oblique", () => {
    for (const family of new Set(TYPEFACE_FACES.map((face) => face.family))) {
      const styles = TYPEFACE_FACES.filter((face) => face.family === family).map(
        (face) => face.style,
      );
      expect(styles, `${family} declares no real italic`).toContain("italic");
      expect(styles, `${family} declares no upright face`).toContain("normal");
    }
  });

  // Under static instances the 640 that `layout/CommandPalette/command-palette.css` asks for
  // resolved to the nearest declared face. Asserted against the console's own extremes, so a
  // range that stopped covering it cannot reintroduce that silently.
  it("declare a weight range that covers every weight the console asks for", () => {
    for (const face of TYPEFACE_FACES) {
      const [lowestWeight, highestWeight] = face.weightRange
        .split(" ")
        .map((bound) => Number.parseInt(bound, 10));
      expect(lowestWeight).toBeLessThanOrEqual(400);
      expect(highestWeight).toBeGreaterThanOrEqual(640);
    }
  });

  // Asserts the bundler resolved the URL and it still names a woff2, which holds in both modes: a
  // dev transform serves the file in place under `/@fs/` and a production build emits a hashed
  // copy. Demanding the hashed form would assert the tier's build mode, not the module's contract.
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

  // `font-style` decides whether an italic run gets the italic file or a slant of the upright
  // one, so it is emitted per face. A block whose style did not match its file would load real
  // italic outlines that no italic run selects.
  it("declares each face under the style its own file carries", () => {
    for (const style of ["normal", "italic"]) {
      expect(css.match(new RegExp(`font-style: ${style};`, "g")) ?? []).toHaveLength(
        TYPEFACE_FACES.filter((face) => face.style === style).length,
      );
    }
    // Read block by block: the right count in the wrong block would serve the italic file to
    // upright text.
    const blocks = css.split("@font-face").filter((block) => block.includes("src:"));
    expect(blocks).toHaveLength(TYPEFACE_FACES.length);
    for (const face of TYPEFACE_FACES) {
      const blockOfFace = blocks.find((block) => block.includes(`url("${face.url}")`));
      expect(blockOfFace, `no block declares ${face.url}`).toBeDefined();
      expect(blockOfFace).toContain(`font-style: ${face.style};`);
      expect(blockOfFace).toContain(`font-family: "${face.family}";`);
    }
  });

  // A `font-stretch` descriptor narrows what the browser takes from the file, so declaring one
  // over a file with no width axis claims bytes that are not there. Only the sans build carries
  // `wdth`, asserted from the roster so the sheet and the roster cannot disagree.
  it("bounds the width axis only where the file carries one", () => {
    const stretchDeclarations = css.match(/font-stretch: /g) ?? [];
    expect(stretchDeclarations).toHaveLength(
      TYPEFACE_FACES.filter((face) => face.stretchRange !== null).length,
    );
    expect(css).toContain("font-stretch: 85% 100%;");
  });

  // The slashed zero is the mono signature and a property of the mono face. As a descriptor it is
  // scoped by construction; on `body` it would inherit onto every user name, repo path and
  // branch. Asserted per block, since the right count in the wrong block is the failure.
  it("puts the slashed zero on the mono face, and on no sans one", () => {
    const blocks = css.split("@font-face").filter((block) => block.includes("src:"));
    for (const face of TYPEFACE_FACES) {
      const blockOfFace = blocks.find((block) => block.includes(`url("${face.url}")`));
      expect(blockOfFace, `no block declares ${face.url}`).toBeDefined();
      if (face.featureSettings === null) {
        expect(
          blockOfFace,
          `${face.family} ${face.style} sets features it declares none of`,
        ).not.toContain("font-feature-settings");
        continue;
      }
      expect(blockOfFace).toContain(`font-feature-settings: ${face.featureSettings};`);
    }
    // The roster carries the scoping too, so a later face cannot pick up the signature by
    // copying a neighboring entry: exactly the mono family declares it.
    const familiesCarryingFeatures = new Set(
      TYPEFACE_FACES.filter((face) => face.featureSettings !== null).map((face) => face.family),
    );
    expect([...familiesCarryingFeatures]).toStrictEqual(["IBM Plex Mono"]);
    expect(css.match(/font-feature-settings: /g) ?? []).toHaveLength(
      TYPEFACE_FACES.filter((face) => face.featureSettings !== null).length,
    );
  });

  // `tnum` is absent: neither family carries `tnum` or `pnum` in `GSUB` or `GPOS` and every digit
  // measures 600/1000 em, so a `"tnum" 1` would be a feature declared against a face that offers
  // none.
  it("claims only the feature the faces actually carry", () => {
    expect(css).not.toContain("tnum");
  });

  it("never falls back to a host-installed face", () => {
    // `local()` would hand rendering to whichever Plex the machine has, which self-hosting exists
    // to prevent.
    expect(css).not.toContain("local(");
  });

  it("blocks rather than swaps, so no transcript row is laid out twice", () => {
    expect(css.match(/font-display: block;/g)).toHaveLength(TYPEFACE_FACES.length);
    expect(css).not.toContain("font-display: swap");
  });

  // Each face bounds itself to the codepoints its own split carries, and the families differ (the
  // sans files cover `U+0000` and `U+000D`, the mono files do not). One shared range would
  // over-claim for one of them. Within a family the two styles publish one range, so the roster
  // is asserted family-wise: two distinct ranges over four faces, never four.
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
