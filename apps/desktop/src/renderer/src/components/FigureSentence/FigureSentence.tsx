// A sentence that carries figures in its words, each drawn in the class its origin calls for, and
// the same sentence as one string for an announcement.

import { DerivedFigure } from "#renderer/components/DerivedFigure/DerivedFigure.js";
import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";

/**
 * One stretch of a sentence: words, a figure the wire sent, drawn as a wire figure, or a figure
 * the app made, such as a count of what the wire sent, drawn as the app's own.
 */
export type FigureSentencePart = string | { readonly wire: string } | { readonly derived: string };

/** A sentence's words and figures as one string, for an announcement or a test. */
export function figureSentenceText(parts: readonly FigureSentencePart[]): string {
  return parts
    .map((part) => (typeof part === "string" ? part : "wire" in part ? part.wire : part.derived))
    .join("");
}

/** A sentence drawn inline, with each figure in its own figure class. */
export function FigureSentence(props: {
  readonly parts: readonly FigureSentencePart[];
}): React.JSX.Element {
  return (
    <>
      {props.parts.map((part, index) =>
        typeof part === "string" ? (
          part
        ) : "wire" in part ? (
          <WireFigure key={index} value={part.wire} />
        ) : (
          <DerivedFigure key={index} text={part.derived} />
        ),
      )}
    </>
  );
}
