// The card shape: a block in the transcript, once the refusal is part of the session's history.
// It has no live region of its own, because the feed announces its own rows.

import "./Refusal.css";

import { GLYPH_SIZE_CHROME } from "#renderer/styles/glyphs.js";
import { Glyph } from "../Glyph/Glyph.js";
import { formatWireString } from "#renderer/lib/wire/figures.js";
import { type RefusalProps } from "./props.js";
import { RefusalWords } from "./RefusalWords.js";

/** A refusal as a block in the transcript: a registered code's words, then the message. */
export function RefusalCard(props: RefusalProps): React.JSX.Element {
  return (
    <div className="meridian-refusal meridian-refusal--card" data-refusal-code={props.code}>
      <div className="meridian-refusal__head">
        <Glyph name="alert" size={GLYPH_SIZE_CHROME} />
        <div className="meridian-refusal__body">
          <RefusalWords code={props.code} reason={props.reason} />
          <p className="meridian-refusal__message">{formatWireString(props.detail)}</p>
        </div>
      </div>
      {props.action !== undefined ? (
        <div className="meridian-refusal__action">{props.action}</div>
      ) : null}
    </div>
  );
}
