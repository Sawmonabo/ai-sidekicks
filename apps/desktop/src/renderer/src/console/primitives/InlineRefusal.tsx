// The inline shape: beside the control that was pressed.
//
// `refusal-contract.ts` states the grammar all three shapes obey and declares the
// props they share; this module decides only what "nothing changed" looks like —
// one line beside the control, with the control still there.

import { Glyph } from "./Glyph.js";
import { REFUSAL_GLYPH_SIZE, type RefusalProps } from "./refusal-contract.js";
import { WireFigure } from "./WireFigure.js";
import { formatWireString } from "./wire-figures.js";

/** Beside the control that was pressed. Nothing changed; the control stays. */
export function InlineRefusal(props: RefusalProps): React.JSX.Element {
  return (
    <span className="meridian-refusal meridian-refusal--inline" role="status">
      <Glyph name="alert" size={REFUSAL_GLYPH_SIZE} />
      <WireFigure value={props.code} />
      <span className="meridian-refusal__message">{formatWireString(props.detail)}</span>
      {props.action !== undefined ? (
        <span className="meridian-refusal__action">{props.action}</span>
      ) : null}
    </span>
  );
}
