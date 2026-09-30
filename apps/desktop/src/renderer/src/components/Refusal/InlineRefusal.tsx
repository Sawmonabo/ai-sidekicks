// The inline shape: one line beside the control that was pressed, with the control still there.
// `refusal-props.ts` declares the grammar and props all three shapes share.

import "./Refusal.css";

import { GLYPH_SIZE_CHROME } from "@renderer/styles/glyphs.js";
import { Glyph } from "../Glyph/Glyph.js";
import { WireFigure } from "../WireFigure/WireFigure.js";
import { formatWireString } from "@renderer/lib/wire-figures.js";
import { type RefusalProps } from "./refusal-props.js";

/** Beside the control that was pressed. Nothing changed; the control stays. */
export function InlineRefusal(props: RefusalProps): React.JSX.Element {
  return (
    <span className="meridian-refusal meridian-refusal--inline" role="status">
      <Glyph name="alert" size={GLYPH_SIZE_CHROME} />
      <WireFigure value={props.code} />
      <span className="meridian-refusal__message">{formatWireString(props.detail)}</span>
      {props.action !== undefined ? (
        <span className="meridian-refusal__action">{props.action}</span>
      ) : null}
    </span>
  );
}
