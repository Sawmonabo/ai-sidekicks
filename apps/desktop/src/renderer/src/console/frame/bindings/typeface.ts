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
// FIVE DECISIONS ARE ENCODED BELOW, each a choice against a plausible alternative.
//
//   1. **One VARIABLE file per family and style, and the Latin-1 split of each.**
//      The four files below are 68 988 B and 80 188 B for the sans, 32 576 B and
//      38 688 B for the mono — 220 440 B for the whole type foundation — against
//      the complete builds, which carry every subset. A variable file is what
//      serves the weights: the console's stylesheets ask for 400, 500, 600 and
//      `palette/palette.css` asks for 640, and each of those is a real instance
//      rather than the nearest of three static cuts. Each FAMILY carries its own
//      `unicode-range`, copied from that package's own stylesheets for its splits,
//      so a codepoint outside it is not rendered wrong — it falls through to the
//      next family in the stack, which is exactly what the descriptor is for. The
//      two families' ranges are NOT the same string and are not shared: the sans
//      splits cover `U+0000` and `U+000D` and the mono splits do not, so one
//      constant for both would claim coverage of two files from the contents of
//      one.
//
//   2. **Both styles, because a synthesized oblique is not the face.** Eleven
//      rules across six stylesheets set `font-style: italic`, and both families
//      are reached — the ANSI and diff surfaces in mono, the markdown and chrome
//      surfaces in sans. A family that declared only its upright face would not
//      lose those runs: the browser would SLANT the upright outlines and paint a
//      faux italic, a shear of the wrong drawing rather than the italic the
//      foundry cut — whose own letterforms and spacing would then never reach the
//      page. Rule 4 names the faces, and a transform of a face is not one. The
//      bytes are the reason this looks expensive and is not: a browser fetches an
//      `@font-face` file only when a run actually matches that rule, so the two
//      italic files are on disk and in the budget and are requested by no session
//      that renders no italic — they are not on the first paint. They are counted by
//      `renderer-initial-fonts`, because a ceiling that bounded only what a
//      particular session fetched would bound nothing.
//
//   3. **No `local()` in any `src`.** The foundry's own stylesheets lead with
//      `local("IBM Plex Sans Var Regular")`, which hands the rendering to whatever
//      Plex the host has installed — a different version, a different subset, a
//      different set of features. A console whose faces depend on the machine is a
//      console whose screenshot tier compares two different documents. The emitted
//      bytes are the only ones admitted.
//
//   4. **`font-display: block`, not `swap`.** These files are served from the
//      renderer scheme off local disk, so the block period is measured in
//      milliseconds and no operator sees it. `swap` would trade that invisible
//      wait for a visible reflow — every ledger row, gutter, and mono figure laid
//      out in a fallback metric and then relaid — which is the one motion the
//      design language does not sanction, because nobody asked for it.
//
//   5. **The declared axis ranges are READ from the files, not chosen.** Each
//      `font-weight` below is the file's own `wght` range and each `font-stretch`
//      its own `wdth` range, cross-read two ways and agreeing: the package's own
//      stylesheet for that split, and the `fvar` table inside the `woff2` itself
//      (measured 2026-09-09 — sans `wght 100–700` plus `wdth 85–100`, mono `wght
//      100–700` and no width axis at all, and both styles of a family publishing
//      the same axes). A descriptor range NARROWS what the browser will synthesize
//      from the file, so a guessed range is a face the console asked for and
//      silently did not get; the mono faces therefore carry no `font-stretch`
//      descriptor, because the files carry no axis to bound.
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
//   A family's two Latin-1 splits publish the SAME `unicode-range`, which is read
//   out of the two packages rather than assumed. Both foundry stylesheets were
//   compared block for block on 2026-09-09 and the Roman and Italic Latin-1
//   entries agree character for character within each family — which is why one
//   constant per family is a single reading of one subset decision and not two
//   copies of one string. A future split whose italic diverged would be caught by
//   the same comparison, which is why the ranges are recopied on any version bump
//   rather than carried forward.

import monoItalicLatin1Url from "@ibm/plex-mono-variable/fonts/split/woff2/IBM Plex Mono Var-Italic-Latin1.woff2?url";
import monoRomanLatin1Url from "@ibm/plex-mono-variable/fonts/split/woff2/IBM Plex Mono Var-Roman-Latin1.woff2?url";
import sansItalicLatin1Url from "@ibm/plex-sans-variable/fonts/split/woff2/IBM Plex Sans Var-Italic-Latin1.woff2?url";
import sansRomanLatin1Url from "@ibm/plex-sans-variable/fonts/split/woff2/IBM Plex Sans Var-Roman-Latin1.woff2?url";

/**
 * The Latin-1 coverage of the SANS splits, verbatim from that package's own
 * stylesheets for them.
 *
 * Copied rather than derived: it is the publisher's description of which
 * codepoints these files actually contain, so re-deriving it would be inventing a
 * claim about bytes we did not subset. One constant serves both styles because the
 * package publishes one range for both, which the header records as read rather
 * than assumed.
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
 * The Latin-1 coverage of the MONO splits, verbatim from that package's own
 * stylesheets for them.
 *
 * The same string as the sans range minus its first two entries — the mono splits
 * carry neither `U+0000` nor `U+000D`. Written out rather than derived from its
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

/** The `font-style` a face is selected for; the two the foundry cuts and no third. */
type TypefaceStyle = "normal" | "italic";

/** One self-hosted face: a family, a style, the axes its file carries, and those bytes. */
interface TypefaceFace {
  /** The family name the `FONT_STACKS` entry in `tokens/typography.ts` names first. */
  readonly family: string;
  /** Which cut this file is, and therefore which runs it is selected for. */
  readonly style: TypefaceStyle;
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
 * it: a fifth face added here is covered without a second roster being edited.
 */
export const TYPEFACE_FACES: readonly TypefaceFace[] = [
  {
    family: "IBM Plex Sans",
    style: "normal",
    weightRange: "100 700",
    stretchRange: "85% 100%",
    unicodeRange: SANS_LATIN1_UNICODE_RANGE,
    url: sansRomanLatin1Url,
  },
  {
    family: "IBM Plex Sans",
    style: "italic",
    weightRange: "100 700",
    stretchRange: "85% 100%",
    unicodeRange: SANS_LATIN1_UNICODE_RANGE,
    url: sansItalicLatin1Url,
  },
  {
    family: "IBM Plex Mono",
    style: "normal",
    weightRange: "100 700",
    stretchRange: null,
    unicodeRange: MONO_LATIN1_UNICODE_RANGE,
    url: monoRomanLatin1Url,
  },
  {
    family: "IBM Plex Mono",
    style: "italic",
    weightRange: "100 700",
    stretchRange: null,
    unicodeRange: MONO_LATIN1_UNICODE_RANGE,
    url: monoItalicLatin1Url,
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
      `  font-style: ${face.style};`,
      `  font-weight: ${face.weightRange};`,
      ...(face.stretchRange === null ? [] : [`  font-stretch: ${face.stretchRange};`]),
      "  font-display: block;",
      `  src: url("${face.url}") format("woff2");`,
      `  unicode-range: ${face.unicodeRange};`,
      "}",
    ].join("\n"),
  ).join("\n\n");
}
