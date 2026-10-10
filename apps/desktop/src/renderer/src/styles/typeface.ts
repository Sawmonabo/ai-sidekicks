// The app's faces, self-hosted: IBM Plex Sans for UI text and IBM Plex Mono for every wire-true
// figure, as variable builds from the foundry's own packages, so the type scale and every
// rendered view do not depend on the host's fonts.
//
// A module and not a stylesheet: a bare package specifier inside CSS `url()` is invisible to the
// compiler and the dead-code check, so the font packages would look unused. The faces install
// through the same seam as the tokens (`app/token-installation.ts`).
//
//   - Every split each package ships, one `@font-face` per split, each carrying the
//     `unicode-range` the package's own stylesheet lists for it, read from that stylesheet rather
//     than copied, so the browser fetches a split only when a page draws one of its characters.
//     A Latin-1 page loads the Latin-1 split alone; an arrow, a check mark or a Greek word loads
//     its split the moment it is drawn. The package stylesheets are not installed themselves: they
//     name the family `IBM Plex … Var` and list `local()` sources.
//   - One variable file per family, style and split: a variable file serves every weight the
//     stylesheets ask for as a real instance. What a Latin-1 page loads is bounded by the
//     initial-fonts budget in `.size-limit.ts`.
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
//
// The `font-family` descriptor is the name the token stack asks for, not the name inside the
// file.

import monoItalicCss from "@ibm/plex-mono-variable/fonts/split/woff2/IBM Plex Mono Var-Italic.css?raw";
import monoItalicCyrillicUrl from "@ibm/plex-mono-variable/fonts/split/woff2/IBM Plex Mono Var-Italic-Cyrillic.woff2?url";
import monoItalicLatin1Url from "@ibm/plex-mono-variable/fonts/split/woff2/IBM Plex Mono Var-Italic-Latin1.woff2?url";
import monoItalicLatin2Url from "@ibm/plex-mono-variable/fonts/split/woff2/IBM Plex Mono Var-Italic-Latin2.woff2?url";
import monoItalicLatin3Url from "@ibm/plex-mono-variable/fonts/split/woff2/IBM Plex Mono Var-Italic-Latin3.woff2?url";
import monoItalicPiUrl from "@ibm/plex-mono-variable/fonts/split/woff2/IBM Plex Mono Var-Italic-Pi.woff2?url";
import monoRomanCss from "@ibm/plex-mono-variable/fonts/split/woff2/IBM Plex Mono Var-Roman.css?raw";
import monoRomanCyrillicUrl from "@ibm/plex-mono-variable/fonts/split/woff2/IBM Plex Mono Var-Roman-Cyrillic.woff2?url";
import monoRomanLatin1Url from "@ibm/plex-mono-variable/fonts/split/woff2/IBM Plex Mono Var-Roman-Latin1.woff2?url";
import monoRomanLatin2Url from "@ibm/plex-mono-variable/fonts/split/woff2/IBM Plex Mono Var-Roman-Latin2.woff2?url";
import monoRomanLatin3Url from "@ibm/plex-mono-variable/fonts/split/woff2/IBM Plex Mono Var-Roman-Latin3.woff2?url";
import monoRomanPiUrl from "@ibm/plex-mono-variable/fonts/split/woff2/IBM Plex Mono Var-Roman-Pi.woff2?url";
import sansItalicCss from "@ibm/plex-sans-variable/fonts/split/woff2/IBM Plex Sans Var-Italic.css?raw";
import sansItalicCyrillicUrl from "@ibm/plex-sans-variable/fonts/split/woff2/IBM Plex Sans Var-Italic-Cyrillic.woff2?url";
import sansItalicGreekUrl from "@ibm/plex-sans-variable/fonts/split/woff2/IBM Plex Sans Var-Italic-Greek.woff2?url";
import sansItalicLatin1Url from "@ibm/plex-sans-variable/fonts/split/woff2/IBM Plex Sans Var-Italic-Latin1.woff2?url";
import sansItalicLatin2Url from "@ibm/plex-sans-variable/fonts/split/woff2/IBM Plex Sans Var-Italic-Latin2.woff2?url";
import sansItalicLatin3Url from "@ibm/plex-sans-variable/fonts/split/woff2/IBM Plex Sans Var-Italic-Latin3.woff2?url";
import sansItalicPiUrl from "@ibm/plex-sans-variable/fonts/split/woff2/IBM Plex Sans Var-Italic-Pi.woff2?url";
import sansRomanCss from "@ibm/plex-sans-variable/fonts/split/woff2/IBM Plex Sans Var-Roman.css?raw";
import sansRomanCyrillicUrl from "@ibm/plex-sans-variable/fonts/split/woff2/IBM Plex Sans Var-Roman-Cyrillic.woff2?url";
import sansRomanGreekUrl from "@ibm/plex-sans-variable/fonts/split/woff2/IBM Plex Sans Var-Roman-Greek.woff2?url";
import sansRomanLatin1Url from "@ibm/plex-sans-variable/fonts/split/woff2/IBM Plex Sans Var-Roman-Latin1.woff2?url";
import sansRomanLatin2Url from "@ibm/plex-sans-variable/fonts/split/woff2/IBM Plex Sans Var-Roman-Latin2.woff2?url";
import sansRomanLatin3Url from "@ibm/plex-sans-variable/fonts/split/woff2/IBM Plex Sans Var-Roman-Latin3.woff2?url";
import sansRomanPiUrl from "@ibm/plex-sans-variable/fonts/split/woff2/IBM Plex Sans Var-Roman-Pi.woff2?url";

/** The `font-style` a face is selected for; the two the foundry cuts and no third. */
type TypefaceStyle = "normal" | "italic";

/** One self-hosted split: a family, a style, the axes its file carries, its characters, its bytes. */
interface TypefaceFace {
  /** The family name the `FONT_STACKS` entry in `styles/typography.ts` names first. */
  readonly family: string;
  /** Which cut this file is, and therefore which runs it is selected for. */
  readonly style: TypefaceStyle;
  /** The file's own `wght` range, as a `font-weight` descriptor value. */
  readonly weightRange: string;
  /** The file's own `wdth` range, or `null` where the file carries no width axis. */
  readonly stretchRange: string | null;
  /** The characters this split holds, as the package's own stylesheet lists them. */
  readonly unicodeRange: string;
  /** The same characters as inclusive code point ranges. */
  readonly codePointRanges: readonly CodePointRange[];
  /** The emitted asset URL, resolved by the bundler from the package path. */
  readonly url: string;
}

/**
 * Every split the app ships, in declaration order. Throws at load when a package stylesheet names
 * a split no import here resolves, or an import names a split its stylesheet does not list.
 */
export const TYPEFACE_FACES: readonly TypefaceFace[] = [
  ...facesOf({
    family: "IBM Plex Sans",
    style: "normal",
    weightRange: "100 700",
    stretchRange: "85% 100%",
    packageCss: sansRomanCss,
    urlByFileName: {
      "IBM Plex Sans Var-Roman-Cyrillic.woff2": sansRomanCyrillicUrl,
      "IBM Plex Sans Var-Roman-Greek.woff2": sansRomanGreekUrl,
      "IBM Plex Sans Var-Roman-Latin1.woff2": sansRomanLatin1Url,
      "IBM Plex Sans Var-Roman-Latin2.woff2": sansRomanLatin2Url,
      "IBM Plex Sans Var-Roman-Latin3.woff2": sansRomanLatin3Url,
      "IBM Plex Sans Var-Roman-Pi.woff2": sansRomanPiUrl,
    },
  }),
  ...facesOf({
    family: "IBM Plex Sans",
    style: "italic",
    weightRange: "100 700",
    stretchRange: "85% 100%",
    packageCss: sansItalicCss,
    urlByFileName: {
      "IBM Plex Sans Var-Italic-Cyrillic.woff2": sansItalicCyrillicUrl,
      "IBM Plex Sans Var-Italic-Greek.woff2": sansItalicGreekUrl,
      "IBM Plex Sans Var-Italic-Latin1.woff2": sansItalicLatin1Url,
      "IBM Plex Sans Var-Italic-Latin2.woff2": sansItalicLatin2Url,
      "IBM Plex Sans Var-Italic-Latin3.woff2": sansItalicLatin3Url,
      "IBM Plex Sans Var-Italic-Pi.woff2": sansItalicPiUrl,
    },
  }),
  ...facesOf({
    family: "IBM Plex Mono",
    style: "normal",
    weightRange: "100 700",
    stretchRange: null,
    packageCss: monoRomanCss,
    urlByFileName: {
      "IBM Plex Mono Var-Roman-Cyrillic.woff2": monoRomanCyrillicUrl,
      "IBM Plex Mono Var-Roman-Latin1.woff2": monoRomanLatin1Url,
      "IBM Plex Mono Var-Roman-Latin2.woff2": monoRomanLatin2Url,
      "IBM Plex Mono Var-Roman-Latin3.woff2": monoRomanLatin3Url,
      "IBM Plex Mono Var-Roman-Pi.woff2": monoRomanPiUrl,
    },
  }),
  ...facesOf({
    family: "IBM Plex Mono",
    style: "italic",
    weightRange: "100 700",
    stretchRange: null,
    packageCss: monoItalicCss,
    urlByFileName: {
      "IBM Plex Mono Var-Italic-Cyrillic.woff2": monoItalicCyrillicUrl,
      "IBM Plex Mono Var-Italic-Latin1.woff2": monoItalicLatin1Url,
      "IBM Plex Mono Var-Italic-Latin2.woff2": monoItalicLatin2Url,
      "IBM Plex Mono Var-Italic-Latin3.woff2": monoItalicLatin3Url,
      "IBM Plex Mono Var-Italic-Pi.woff2": monoItalicPiUrl,
    },
  }),
];

/**
 * Whether IBM Plex Mono's own splits draw a code point, so it takes the face's one advance rather
 * than a fallback face's.
 */
export function isDrawnInPlexMono(codePoint: number): boolean {
  return TYPEFACE_FACES.some(
    (face) =>
      face.family === "IBM Plex Mono" &&
      face.style === "normal" &&
      face.codePointRanges.some(([first, last]) => first <= codePoint && codePoint <= last),
  );
}

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
      `  unicode-range: ${face.unicodeRange};`,
      "}",
    ].join("\n"),
  ).join("\n\n");
}

/** An inclusive range of code points, first and last. */
type CodePointRange = readonly [number, number];

/** One family and style's splits, with the package stylesheet that lists their ranges. */
interface PackageFaceSheet {
  readonly family: string;
  readonly style: TypefaceStyle;
  readonly weightRange: string;
  readonly stretchRange: string | null;
  /** The package's own stylesheet for this family and style, verbatim. */
  readonly packageCss: string;
  /** Each split's emitted URL, by the file name the package stylesheet gives it. */
  readonly urlByFileName: Readonly<Record<string, string>>;
}

/** The splits one package stylesheet lists, each with the range it gives that split. */
function facesOf(sheet: PackageFaceSheet): TypefaceFace[] {
  const faces: TypefaceFace[] = [];
  const unlisted = new Set(Object.keys(sheet.urlByFileName));
  for (const rule of sheet.packageCss.split("@font-face").slice(1)) {
    // The split's own file comes after the rule's `local()` sources; the range runs to the end of
    // its declaration, or of the rule where it is the last one.
    const fileName = /url\("([^"]+\.woff2)"\)/u.exec(rule)?.[1];
    const unicodeRange = /unicode-range:([^;}]+)/u.exec(rule)?.[1]?.trim();
    const url = fileName === undefined ? undefined : sheet.urlByFileName[fileName];
    if (fileName === undefined || unicodeRange === undefined || url === undefined) {
      throw new Error(
        `The ${sheet.family} ${sheet.style} package stylesheet lists a face with no ` +
          `file, no range or no import here: ${rule.slice(0, 200)}`,
      );
    }
    unlisted.delete(fileName);
    faces.push({
      family: sheet.family,
      style: sheet.style,
      weightRange: sheet.weightRange,
      stretchRange: sheet.stretchRange,
      unicodeRange,
      codePointRanges: codePointRangesOf(unicodeRange),
      url,
    });
  }
  if (unlisted.size > 0) {
    throw new Error(
      `The ${sheet.family} ${sheet.style} package stylesheet lists no range for ` +
        [...unlisted].join(", "),
    );
  }
  return faces;
}

/** A `unicode-range` value as code point ranges. Throws on a wildcard, which no package uses. */
function codePointRangesOf(unicodeRange: string): CodePointRange[] {
  return unicodeRange.split(",").map((part) => {
    const match = /^U\+([0-9A-F]+)(?:-([0-9A-F]+))?$/iu.exec(part.trim());
    if (match?.[1] === undefined) {
      throw new Error(`A package stylesheet lists a range this module cannot read: ${part}`);
    }
    const first = Number.parseInt(match[1], 16);
    return [first, match[2] === undefined ? first : Number.parseInt(match[2], 16)];
  });
}
