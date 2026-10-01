// The console's faces, self-hosted: IBM Plex Sans for UI text and IBM Plex Mono for every
// wire-true figure, as variable builds from the foundry's own packages. Without loaded faces the
// console renders in whichever face the host carries, which would make the type scale, the
// transcript's fixed gutter and every screenshot reference a property of the person's machine.
//
// This is a module and not a stylesheet: a bare package specifier inside CSS `url()` is a bundler
// convention no tool reads as a dependency, so the font packages would look unused. Declaring the
// faces here lets the compiler resolve the specifier, the bundler emit the file and the
// dead-code check see a used package. The faces install through the same seam as the tokens
// (`app/token-installation.ts`).
//
// Seven decisions are encoded below, each against a plausible alternative.
//
//   1. **One variable file per family and style, Latin-1 split.** The four files are 68 988 B and
//      80 188 B for the sans and 32 576 B and 38 688 B for the mono, 220 440 B in all, against
//      complete builds that carry every subset. A variable file serves the weights the
//      stylesheets ask for (400, 500, 600, and 640 in
//      `layout/CommandPalette/command-palette.css`) as real instances, not the nearest of three
//      static cuts. Each family carries its own
//      `unicode-range`, copied from that package's stylesheets, so a codepoint outside it falls
//      through to the next family in the stack. The ranges differ (the sans splits cover `U+0000`
//      and `U+000D`, the mono splits do not), so one shared constant would claim coverage of two
//      files from the contents of one.
//
//   2. **Both styles, because a synthesized oblique is not the face.** Seven rules across five
//      stylesheets set `font-style: italic`. Mono italic is reached once: the ANSI body
//      (`features/transcript/rows/ansi/ansi.css`, `.meridian-ansi--italic` under a body that sets
//      the mono token). Everything else is sans: the three diff italics
//      (`features/repos/diff/components/diff.css`), the tool row's absent name
//      (`features/transcript/rows/rows.css`), the markdown image's alt text
//      (`features/transcript/rows/markdown/markdown.css`) and the pane's absent crumb
//      (`components/PaneFrame/PaneFrame.css`). A family declaring only its upright face would get
//      a sheared faux italic, not the foundry's. The italic files cost nothing on first paint,
//      since a browser fetches an `@font-face` file only when a run matches it, but
//      `renderer-initial-fonts` counts them, because a ceiling bounding only what one session
//      fetched would bound nothing.
//
//   3. **No `local()` in any `src`.** The foundry's stylesheets lead with
//      `local("IBM Plex Sans Var Regular")`, which hands rendering to whatever Plex the host has
//      (another version, subset or feature set), so the screenshot tier would compare different
//      documents. Only the emitted bytes are admitted.
//
//   4. **`font-display: block`, not `swap`.** The files are served from the renderer scheme off
//      local disk, so the block period is milliseconds and invisible. `swap` would trade it for a
//      visible reflow of every transcript row, gutter and mono figure, a motion the design does
//      not sanction.
//
//   5. **The declared axis ranges are read from the files, not chosen.** Each `font-weight` is the
//      file's own `wght` range and each `font-stretch` its own `wdth` range, agreeing between the
//      package's stylesheet and the `fvar` table in the `woff2`: sans `wght 100–700` plus
//      `wdth 85–100`, mono `wght 100–700` with no width axis, both styles of a family
//      publishing the same axes. A descriptor range narrows what the browser synthesizes from
//      the file, so a guessed range is a face the console asked for and did not get. The mono
//      faces carry no `font-stretch` descriptor because their files have no axis to bound.
//
//   6. **The slashed zero rides the mono face, not the tree.** Mono is the signature that a
//      number came from the wire, so the `zero` feature belongs to IBM Plex Mono. On `body` it
//      could not hold the scoping: `font-feature-settings` inherits, so a root declaration would
//      slash the zero on every user name, repo path and branch name, and CSS Fonts 4 gives the
//      property precedence over the features `font-variant-*` computes, so no descendant could
//      narrow it. As an `@font-face` descriptor it sets the face's initial features and applies
//      wherever the face is selected. Chromium honors the descriptor from 140, and Electron 44
//      runs Chromium 152. `tnum` is deliberately not declared (see `typography.ts`).
//
//   7. **The Pi split is not shipped, so five glyphs the console draws fall to the host face.**
//      The console declares Latin-1 only, and the arrows `lib/chord-format.ts` renders on
//      keybinding rows and palette entries (`U+2190`-`U+2193` and `U+21A9`) sit in the foundry's
//      Pi split, which both packages publish. A chord row therefore paints its arrows from the
//      host beside Plex text, the class of thing decision 2 refuses for italics. It is admitted
//      because the smallest Pi files are 22 488 B (mono Roman) and 23 900 B (sans Roman), and one
//      takes the four faces from 220 440 B to 242 928 B against a 232 000 B ceiling. A wider
//      `renderer-initial-fonts` ceiling makes the Pi splits declarable, and this decision says
//      which files to add. The remaining keycap glyphs (`U+2318` `U+2325` `U+2303` `U+21E7`
//      `U+232B` `U+2326` `U+238B` `U+21E5`) are covered by no split's `unicode-range` in either
//      package, so they fall through under any ceiling.
//
// Two facts worth recording. The `font-family` descriptor is the name the token stack asks for,
// not the name inside the file (`IBM Plex Sans Var`, `IBM Plex Mono Var`), so `typography.ts`
// keeps asking for `"IBM Plex Sans"` and `"IBM Plex Mono"` and these rules supply them. And a
// family's two Latin-1 splits publish the same `unicode-range` (the Roman and Italic entries
// agree character for character in both packages), so one constant per family is one reading of
// one subset decision. Recopy the ranges on any version bump, which would catch a divergence.

import monoItalicLatin1Url from "@ibm/plex-mono-variable/fonts/split/woff2/IBM Plex Mono Var-Italic-Latin1.woff2?url";
import monoRomanLatin1Url from "@ibm/plex-mono-variable/fonts/split/woff2/IBM Plex Mono Var-Roman-Latin1.woff2?url";
import sansItalicLatin1Url from "@ibm/plex-sans-variable/fonts/split/woff2/IBM Plex Sans Var-Italic-Latin1.woff2?url";
import sansRomanLatin1Url from "@ibm/plex-sans-variable/fonts/split/woff2/IBM Plex Sans Var-Roman-Latin1.woff2?url";

/**
 * The Latin-1 coverage of the sans splits, verbatim from that package's stylesheets. Copied
 * rather than derived: it is the publisher's description of the codepoints the files contain.
 * One constant serves both styles because the package publishes one range for both.
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
 * The Latin-1 coverage of the mono splits, verbatim from that package's stylesheets: the sans
 * range minus `U+0000` and `U+000D`. Written out rather than sliced from its sibling, because
 * that relationship is a coincidence of these versions and not a rule either package states.
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

/**
 * The features the mono faces are declared with: the slashed zero and nothing else. `zero` is a
 * real substitution (both variable builds carry it in `GSUB`) and belongs to mono alone. `tnum`
 * is absent because neither family carries `tnum` or `pnum` in `GSUB` or `GPOS`, and every digit
 * measures 600/1000 em, so there are no proportional figures to switch away from.
 */
const MONO_FEATURE_SETTINGS = '"zero" 1';

/** One self-hosted face: a family, a style, the axes its file carries, and those bytes. */
interface TypefaceFace {
  /** The family name the `FONT_STACKS` entry in `styles/typography.ts` names first. */
  readonly family: string;
  /** Which cut this file is, and therefore which runs it is selected for. */
  readonly style: TypefaceStyle;
  /** The file's own `wght` range, as a `font-weight` descriptor value. */
  readonly weightRange: string;
  /** The file's own `wdth` range, or `null` where the file carries no width axis. */
  readonly stretchRange: string | null;
  /** The codepoints this split contains, as the publisher describes them. */
  readonly unicodeRange: string;
  /** The face's own initial OpenType features, or `null`; a descriptor, so scoped to the face. */
  readonly featureSettings: string | null;
  /** The emitted asset URL, resolved by the bundler from the package path. */
  readonly url: string;
}

/**
 * Every face the console ships, in declaration order. Exported so tiers can assert the set
 * rather than re-list it.
 */
export const TYPEFACE_FACES: readonly TypefaceFace[] = [
  {
    family: "IBM Plex Sans",
    style: "normal",
    weightRange: "100 700",
    stretchRange: "85% 100%",
    unicodeRange: SANS_LATIN1_UNICODE_RANGE,
    featureSettings: null,
    url: sansRomanLatin1Url,
  },
  {
    family: "IBM Plex Sans",
    style: "italic",
    weightRange: "100 700",
    stretchRange: "85% 100%",
    unicodeRange: SANS_LATIN1_UNICODE_RANGE,
    featureSettings: null,
    url: sansItalicLatin1Url,
  },
  {
    family: "IBM Plex Mono",
    style: "normal",
    weightRange: "100 700",
    stretchRange: null,
    unicodeRange: MONO_LATIN1_UNICODE_RANGE,
    featureSettings: MONO_FEATURE_SETTINGS,
    url: monoRomanLatin1Url,
  },
  {
    family: "IBM Plex Mono",
    style: "italic",
    weightRange: "100 700",
    stretchRange: null,
    unicodeRange: MONO_LATIN1_UNICODE_RANGE,
    featureSettings: MONO_FEATURE_SETTINGS,
    url: monoItalicLatin1Url,
  },
];

/** The `@font-face` block as CSS text. Deterministic, so a tier can compare it. */
export function generateTypefaceCss(): string {
  return TYPEFACE_FACES.map((face) =>
    [
      "@font-face {",
      `  font-family: "${face.family}";`,
      `  font-style: ${face.style};`,
      `  font-weight: ${face.weightRange};`,
      ...(face.stretchRange === null ? [] : [`  font-stretch: ${face.stretchRange};`]),
      ...(face.featureSettings === null
        ? []
        : [`  font-feature-settings: ${face.featureSettings};`]),
      "  font-display: block;",
      `  src: url("${face.url}") format("woff2");`,
      `  unicode-range: ${face.unicodeRange};`,
      "}",
    ].join("\n"),
  ).join("\n\n");
}
