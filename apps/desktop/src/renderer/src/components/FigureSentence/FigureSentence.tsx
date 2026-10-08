// A sentence that carries figures in its words, drawn inline with each figure in the class its
// origin calls for.

import { DerivedFigure } from "#renderer/components/DerivedFigure/DerivedFigure.js";
import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import type { FigureSentencePart } from "#renderer/lib/figure-sentence.js";

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
