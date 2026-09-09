// The console's faces, self-hosted.
//
// `Spec-023 §Console Design (Meridian)` sets UI text in a humanist grotesque and
// every wire-true figure in mono, and both that rule and `§Console Libraries` name
// IBM Plex Sans and IBM Plex Mono, VARIABLE builds, from the foundry's own
// packages. Until this module existed the two families were named in
// `tokens/typography.ts` and nowhere loaded, so the console rendered in whichever
// face the host happened to carry — which makes the type scale, the ledger's fixed
// gutter, and every screenshot reference a property of the operator's machine
// rather than of the design.
//
// WHY THIS IS A MODULE AND NOT A STYLESHEET. It was a `.css` file first, and a
// `.css` file cannot state this dependency in a way any tool can read: a bare
// package specifier inside `url()` is a bundler convention, not CSS resolution, so
// Vite rewrote it correctly and `structure:dead-code` reported both font packages
// as unused — which under this package's rules means they are deleted, not
// exempted. Declaring the faces here makes the dependency real to every reader at
// once: the compiler resolves the specifier, the bundler emits the file, and the
// dead-code gate sees a used package. It also matches what the console already
// does one directory over — `token-installation.ts` builds the Meridian sheet at
// mount rather than committing one — so the faces install through the same seam
// the tokens do rather than through a second mechanism.
//
// FOUR DECISIONS ARE ENCODED BELOW, each a choice against a plausible alternative.
//
//   1. **One VARIABLE file per family, and the Roman Latin-1 split of it.** The two
//      files below are 68 988 B and 32 576 B — 101 564 B for the whole type
//      foundation — against the complete Roman builds, which carry every subset. A
//      variable file is what serves the weights: the console's stylesheets ask for
//      400, 500, 600 and `palette/palette.css` asks for 640, and each of those is a
//      real instance rather than the nearest of three static cuts. Each face
//      carries its OWN `unicode-range`, copied from that package's own stylesheet
//      for that split, so a codepoint outside it is not rendered wrong — it falls
//      through to the next family in the stack, which is exactly what the
//      descriptor is for. The two ranges are NOT the same string and are not
//      shared: the sans split covers `U+0000` and `U+000D` and the mono split does
//      not, so one constant for both would claim coverage of two files from the
//      contents of one.
//
//   2. **No `local()` in any `src`.** The foundry's own stylesheets lead with
//      `local("IBM Plex Sans Var Regular")`, which hands the rendering to whatever
//      Plex the host has installed — a different version, a different subset, a
//      different set of features. A console whose faces depend on the machine is a
//      console whose screenshot tier compares two different documents. The emitted
//      bytes are the only ones admitted.
//
//   3. **`font-display: block`, not `swap`.** These files are served from the
//      renderer scheme off local disk, so the block period is measured in
//      milliseconds and no operator sees it. `swap` would trade that invisible
//      wait for a visible reflow — every ledger row, gutter, and mono figure laid
//      out in a fallback metric and then relaid — which is the one motion the
//      design language does not sanction, because nobody asked for it.
//
//   4. **The declared axis ranges are READ from the files, not chosen.** Each
//      `font-weight` below is the file's own `wght` range and each `font-stretch`
//      its own `wdth` range, cross-read two ways and agreeing: the package's own
//      stylesheet for that split, and the `fvar` table inside the `woff2` itself
//      (measured 2026-09-09 — sans `wght 100–700` plus `wdth 85–100`, mono `wght
//      100–700` and no width axis at all). A descriptor range NARROWS what the
//      browser will synthesize from the file, so a guessed range is a face the
//      console asked for and silently did not get; the mono face therefore carries
//      no `font-stretch` descriptor, because the file carries no axis to bound.
//
// TWO FACTS ABOUT THIS SET, RECORDED BECAUSE THEY ARE EASY TO ASSUME WRONGLY.
//
//   The `font-family` DESCRIPTOR is the name the token stack asks for, and it is
//   not the name inside the file. These builds are called `IBM Plex Sans Var` and
//   `IBM Plex Mono Var` internally; a `@font-face` descriptor names the face for
//   CSS lookup and is free to differ, so `tokens/typography.ts` keeps asking for
//   `"IBM Plex Sans"` and `"IBM Plex Mono"` — the design's own statement of what
//   the console is set in — and these rules are what supplies them.
//
//   No ITALIC face is declared, and the console does use italic — eleven rules
//   across seven stylesheets, on both families. Those runs are therefore
//   synthesized by the browser from the upright face, which is what shipped before
//   this module existed and what every committed screenshot reference was minted
//   under. It is not free to fix: the two Italic Latin-1 splits are 80 188 B and
//   38 688 B, so declaring them takes this set from 101 564 B to 219 440 B against
//   a `renderer-initial-fonts` ceiling of 112 000 B. Raising a budget to buy real
//   italics is a decision for the amendment that owns that ceiling, not for this
//   module; what this module owes is that the omission is stated rather than
//   discovered.

import monoRomanLatin1Url from "@ibm/plex-mono-variable/fonts/split/woff2/IBM Plex Mono Var-Roman-Latin1.woff2?url";
import sansRomanLatin1Url from "@ibm/plex-sans-variable/fonts/split/woff2/IBM Plex Sans Var-Roman-Latin1.woff2?url";

/**
 * The Latin-1 coverage of the SANS split, verbatim from that package's own
 * stylesheet for it.
 *
 * Copied rather than derived: it is the publisher's description of which
 * codepoints this file actually contains, so re-deriving it would be inventing a
 * claim about bytes we did not subset.
 */
const SANS_LATIN1_UNICODE_RANGE = [
  "U+0000",
  "U+000D",
  "U+0020-007E",
  "U+00A0-00FF",
  "U+0131",
  "U+0152-0153",
  "U+02C6",
  "U+02DA",
  "U+02DC",
  "U+2013-2014",
  "U+2018-201A",
  "U+201C-201E",
  "U+2020-2022",
  "U+2026",
  "U+2030",
  "U+2039-203A",
  "U+2044",
  "U+20AC",
  "U+2122",
  "U+2212",
  "U+FB01-FB02",
].join(", ");

/**
 * The Latin-1 coverage of the MONO split, verbatim from that package's own
 * stylesheet for it.
 *
 * The same string as the sans range minus its first two entries — the mono split
 * carries neither `U+0000` nor `U+000D`. Written out rather than derived from its
 * sibling by slicing, because the relationship between two publishers' subset
 * decisions is a coincidence of these two versions and not a rule either package
 * states; a future split that diverges elsewhere would silently inherit the wrong
 * head.
 */
const MONO_LATIN1_UNICODE_RANGE = [
  "U+0020-007E",
  "U+00A0-00FF",
  "U+0131",
  "U+0152-0153",
  "U+02C6",
  "U+02DA",
  "U+02DC",
  "U+2013-2014",
  "U+2018-201A",
  "U+201C-201E",
  "U+2020-2022",
  "U+2026",
  "U+2030",
  "U+2039-203A",
  "U+2044",
  "U+20AC",
  "U+2122",
  "U+2212",
  "U+FB01-FB02",
].join(", ");

/** One self-hosted face: a family, the axes its file carries, and those bytes. */
interface TypefaceFace {
  /** The family name the `FONT_STACKS` entry in `tokens/typography.ts` names first. */
  readonly family: string;
  /** The file's own `wght` range, as a `font-weight` descriptor value. */
  readonly weightRange: string;
  /** The file's own `wdth` range, or `null` where the file carries no width axis. */
  readonly stretchRange: string | null;
  /** The codepoints this split contains, as the publisher describes them. */
  readonly unicodeRange: string;
  /** The emitted asset URL, resolved by the bundler from the package path. */
  readonly url: string;
}

/**
 * Every face the console ships, in the order they are declared to the document.
 *
 * Exported so the console's own tiers can assert the set rather than re-listing
 * it: a third face added here is covered without a second roster being edited.
 */
export const TYPEFACE_FACES: readonly TypefaceFace[] = [
  {
    family: "IBM Plex Sans",
    weightRange: "100 700",
    stretchRange: "85% 100%",
    unicodeRange: SANS_LATIN1_UNICODE_RANGE,
    url: sansRomanLatin1Url,
  },
  {
    family: "IBM Plex Mono",
    weightRange: "100 700",
    stretchRange: null,
    unicodeRange: MONO_LATIN1_UNICODE_RANGE,
    url: monoRomanLatin1Url,
  },
];

/**
 * The `@font-face` block, as CSS text.
 *
 * Deterministic — same inputs, same bytes — so a tier can compare it rather than
 * pattern-match it, exactly as the token sheet's generator is.
 */
export function generateTypefaceCss(): string {
  return TYPEFACE_FACES.map((face) =>
    [
      "@font-face {",
      `  font-family: "${face.family}";`,
      "  font-style: normal;",
      `  font-weight: ${face.weightRange};`,
      ...(face.stretchRange === null ? [] : [`  font-stretch: ${face.stretchRange};`]),
      "  font-display: block;",
      `  src: url("${face.url}") format("woff2");`,
      `  unicode-range: ${face.unicodeRange};`,
      "}",
    ].join("\n"),
  ).join("\n\n");
}
