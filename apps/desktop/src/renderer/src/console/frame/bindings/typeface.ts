// The console's faces, self-hosted.
//
// `Spec-023 §Console Design (Meridian)` sets UI text in a humanist grotesque and
// every wire-true figure in mono, and `§Console Libraries` names IBM Plex Sans and
// IBM Plex Mono from the foundry's own packages. Until this module existed the two
// families were named in `tokens/palette.ts` and nowhere loaded, so the console
// rendered in whichever face the host happened to carry — which makes the type
// scale, the ledger's fixed gutter, and every screenshot reference a property of
// the operator's machine rather than of the design.
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
//   1. **The subset is Latin-1, not the complete face.** The complete `woff2`
//      builds are 61-70 kB EACH; the six below are 20, 21, 22, 17, 17, and 17 kB,
//      so the whole type foundation costs about 114 kB against roughly 400 kB for
//      the same six complete faces. Each face carries the foundry's own
//      `unicode-range` for that subset, so a codepoint outside it is not rendered
//      wrong — it falls through to the next family in the stack, which is exactly
//      what the descriptor is for.
//
//   2. **No `local()` in any `src`.** The foundry's own stylesheets lead with
//      `local("IBM Plex Sans")`, which hands the rendering to whatever Plex the
//      host has installed — a different version, a different subset, a different
//      set of features. A console whose faces depend on the machine is a console
//      whose screenshot tier compares two different documents. The emitted bytes
//      are the only ones admitted.
//
//   3. **`font-display: block`, not `swap`.** These files are served from the
//      renderer scheme off local disk, so the block period is measured in
//      milliseconds and no operator sees it. `swap` would trade that invisible
//      wait for a visible reflow — every ledger row, gutter, and mono figure laid
//      out in a fallback metric and then relaid — which is the one motion the
//      design language does not sanction, because nobody asked for it.
//
//   4. **Three weights per family, and no italics.** The console's own stylesheets
//      ask for 400, 500, and 600 and for no italic anywhere; a face declared and
//      never used is bytes on the initial document for nothing.
//      `palette/palette.css` asks for 640, which resolves to the 600 face — a
//      weight only a variable build could serve, and the foundry packages at these
//      pins publish static instances only.

import monoRegularUrl from "@ibm/plex-mono/fonts/split/woff2/IBMPlexMono-Regular-Latin1.woff2?url";
import monoMediumUrl from "@ibm/plex-mono/fonts/split/woff2/IBMPlexMono-Medium-Latin1.woff2?url";
import monoSemiBoldUrl from "@ibm/plex-mono/fonts/split/woff2/IBMPlexMono-SemiBold-Latin1.woff2?url";
import sansRegularUrl from "@ibm/plex-sans/fonts/split/woff2/IBMPlexSans-Regular-Latin1.woff2?url";
import sansMediumUrl from "@ibm/plex-sans/fonts/split/woff2/IBMPlexSans-Medium-Latin1.woff2?url";
import sansSemiBoldUrl from "@ibm/plex-sans/fonts/split/woff2/IBMPlexSans-SemiBold-Latin1.woff2?url";

/**
 * The Latin-1 subset's coverage, verbatim from the foundry package's own
 * stylesheet for that subset.
 *
 * Copied rather than derived, and stated once rather than per face: it is the
 * publisher's description of which codepoints these six files actually contain,
 * so re-deriving it would be inventing a claim about bytes we did not subset.
 */
const LATIN1_UNICODE_RANGE = [
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

/** One self-hosted face: a family, a weight, and the bytes that carry it. */
interface TypefaceFace {
  /** The family name the `FONT_STACKS` entry in `tokens/palette.ts` names first. */
  readonly family: string;
  /** The single weight this file is an instance of. */
  readonly weight: number;
  /** The emitted asset URL, resolved by the bundler from the package path. */
  readonly url: string;
}

/**
 * Every face the console ships, in the order they are declared to the document.
 *
 * Exported so the console's own tiers can assert the set rather than re-listing
 * it: a seventh face added here is covered without a second roster being edited.
 */
export const TYPEFACE_FACES: readonly TypefaceFace[] = [
  { family: "IBM Plex Sans", weight: 400, url: sansRegularUrl },
  { family: "IBM Plex Sans", weight: 500, url: sansMediumUrl },
  { family: "IBM Plex Sans", weight: 600, url: sansSemiBoldUrl },
  { family: "IBM Plex Mono", weight: 400, url: monoRegularUrl },
  { family: "IBM Plex Mono", weight: 500, url: monoMediumUrl },
  { family: "IBM Plex Mono", weight: 600, url: monoSemiBoldUrl },
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
      `  font-weight: ${face.weight};`,
      "  font-display: block;",
      `  src: url("${face.url}") format("woff2");`,
      `  unicode-range: ${LATIN1_UNICODE_RANGE};`,
      "}",
    ].join("\n"),
  ).join("\n\n");
}
