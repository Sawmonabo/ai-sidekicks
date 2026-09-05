// The card shape: in the ledger, because the refusal is now part of what happened.
//
// `refusal-contract.ts` states the grammar all three shapes obey and declares the
// props they share; this module decides only what a refusal looks like once it has
// joined the session's history — a block in the feed rather than a line beside a
// control, and no live region of its own, because the feed announces its own rows.

import { GLYPH_SIZE_CHROME } from "../tokens/index.js";
import { Glyph } from "./Glyph.js";
import { type RefusalProps } from "./refusal-contract.js";
import { WireFigure } from "./WireFigure.js";
import { formatWireString } from "./wire-figures.js";

/** In the ledger, when the refusal is now part of what happened. */
export function RefusalCard(props: RefusalProps): React.JSX.Element {
  return (
    <div className="meridian-refusal meridian-refusal--card">
      <div className="meridian-refusal__head">
        <Glyph name="alert" size={GLYPH_SIZE_CHROME} />
        <WireFigure value={props.code} />
      </div>
      <p className="meridian-refusal__message">{formatWireString(props.detail)}</p>
      {props.action !== undefined ? (
        <div className="meridian-refusal__action">{props.action}</div>
      ) : null}
    </div>
  );
}
