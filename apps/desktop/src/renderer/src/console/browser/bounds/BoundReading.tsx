// What this window actually measured for one bound, or the honest absence.
//
// Its own module for `BoundRow.tsx`'s reason, and it is the half that carries rule
// 8: an unmeasured ceiling renders `not-checked` rather than a zero, because nobody
// metering a bound and a bound sitting at zero are different facts and only one of
// them is a reading.

import type { BrowserBoundMeasure } from "./browser-bounds.js";
import { Glyph, Nothing } from "../../primitives/index.js";
import { GLYPH_SIZE_ROW } from "../../tokens/index.js";
import { exactFigureTitle, scaleScalarFigure } from "./bound-figures.js";

export function BoundReading(props: {
  readonly measure: BrowserBoundMeasure;
  readonly reading: number | undefined;
}): React.JSX.Element {
  if (props.reading === undefined || props.measure.kind !== "scalar") {
    return (
      <Nothing
        kind="not-checked"
        placement="inline"
        title="Not measured"
        detail="Nothing in this window meters this ceiling yet, so the console does not report a figure for it. That is not the same as reporting zero."
      />
    );
  }
  const isTripped = props.reading >= props.measure.value;
  const className = isTripped
    ? "meridian-browser-bounds__reading meridian-browser-bounds__reading--tripped"
    : "meridian-browser-bounds__reading";
  return (
    <span className={className} title={exactFigureTitle(props.reading, props.measure.unit)}>
      {isTripped ? <Glyph name="alert" size={GLYPH_SIZE_ROW} /> : null}
      {scaleScalarFigure(props.reading, props.measure.unit)}
      {isTripped ? <span>at the ceiling</span> : null}
    </span>
  );
}
