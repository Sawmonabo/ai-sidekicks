// The app's faces, self-hosted: IBM Plex Sans for UI text and IBM Plex Mono for every wire-true
// figure, as variable builds from the foundry's own packages, so the type scale and every
// screenshot do not depend on the host's fonts.
//
// A module and not a stylesheet: a bare package specifier inside CSS `url()` is invisible to the
// compiler and the dead-code check, so the font packages would look unused. The faces install
// through the same seam as the tokens (`app/token-installation.ts`).
//
//   - One variable file per family and style, Latin-1 split: a variable file serves every weight
//     the stylesheets ask for as a real instance. The bytes are bounded by the
//     `renderer-initial-fonts` row in `tests/budget/budgets.json`.
//   - Both styles, because a family declaring only its upright face renders italics as a
//     synthesized oblique. A browser fetches the italic files only when a run matches them.
//   - No `local()` in any `src`: it would hand rendering to whatever Plex the host has.
//   - `font-display: block`, not `swap`: the files come off local disk, so the block period is
//     invisible, while `swap` would reflow every row and figure.
//   - The declared axis ranges are each file's own `wght` and `wdth` ranges, read from the file; a
//     guessed range narrows what the browser synthesizes. The mono files have no width axis.
//   - No OpenType feature is declared. Every digit in both families measures 600/1000 em, so
//     figures are tabular by construction; `font-variant-numeric: tabular-nums` covers the
//     fallback faces.
//   - The Pi split is not shipped, so the arrows `lib/chord-format.ts` draws fall to the host face:
//     declaring it would pass the font budget.
//   - No `unicode-range`: the browser falls back one character at a time by each file's own glyph
//     table, so a codepoint outside the Latin-1 split takes the next face in the stack.
//
// The `font-family` descriptor is the name the token stack asks for, not the name inside the
// file.

import monoItalicLatin1Url from "@ibm/plex-mono-variable/fonts/split/woff2/IBM Plex Mono Var-Italic-Latin1.woff2?url";
import monoRomanLatin1Url from "@ibm/plex-mono-variable/fonts/split/woff2/IBM Plex Mono Var-Roman-Latin1.woff2?url";
import sansItalicLatin1Url from "@ibm/plex-sans-variable/fonts/split/woff2/IBM Plex Sans Var-Italic-Latin1.woff2?url";
import sansRomanLatin1Url from "@ibm/plex-sans-variable/fonts/split/woff2/IBM Plex Sans Var-Roman-Latin1.woff2?url";

/** The `font-style` a face is selected for; the two the foundry cuts and no third. */
type TypefaceStyle = "normal" | "italic";

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
  /** The emitted asset URL, resolved by the bundler from the package path. */
  readonly url: string;
}

/**
 * Every face the app ships, in declaration order. Exported so tiers can assert the set
 * rather than re-list it.
 */
export const TYPEFACE_FACES: readonly TypefaceFace[] = [
  {
    family: "IBM Plex Sans",
    style: "normal",
    weightRange: "100 700",
    stretchRange: "85% 100%",
    url: sansRomanLatin1Url,
  },
  {
    family: "IBM Plex Sans",
    style: "italic",
    weightRange: "100 700",
    stretchRange: "85% 100%",
    url: sansItalicLatin1Url,
  },
  {
    family: "IBM Plex Mono",
    style: "normal",
    weightRange: "100 700",
    stretchRange: null,
    url: monoRomanLatin1Url,
  },
  {
    family: "IBM Plex Mono",
    style: "italic",
    weightRange: "100 700",
    stretchRange: null,
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
      "  font-display: block;",
      `  src: url("${face.url}") format("woff2");`,
      "}",
    ].join("\n"),
  ).join("\n\n");
}
