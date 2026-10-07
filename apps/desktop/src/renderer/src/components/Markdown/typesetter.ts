// KaTeX's lazy chunk: the typesetter, its sheet and its fonts. The sheet is imported here so it
// rides this chunk, and the module settles only once every KaTeX face has loaded, so a formula is
// first laid out in its own fonts and its block's height never changes when they arrive.

import "katex/dist/katex.min.css";

import { ParseError, renderToString } from "katex";

/**
 * KaTeX's markup for one formula: its HTML, with its MathML beside it for assistive technology and
 * copying; `undefined` when the source does not parse. Any other KaTeX failure is thrown.
 */
export function typesetFormula(source: string, isDisplayMode: boolean): string | undefined {
  try {
    return renderToString(source, {
      displayMode: isDisplayMode,
      output: "htmlAndMathml",
      trust: false,
      strict: false,
      // With `throwOnError: false` KaTeX resolves with its own error rendering, which would make
      // the caller's unrenderable arm unreachable; throwing is the only signal of a parse failure.
      throwOnError: true,
    });
  } catch (error) {
    if (error instanceof ParseError) {
      return undefined;
    }
    throw error;
  }
}

// The sheet's faces load before any formula is drawn, rather than on first use by the text.
await Promise.all(
  [...document.fonts].filter((face) => face.family.includes("KaTeX_")).map((face) => face.load()),
);
