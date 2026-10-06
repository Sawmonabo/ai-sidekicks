// The inline shape: one line beside the control that was pressed, with the control still there.
// Handed a try-again, it draws as a page's strip instead: no mark, the daemon's words, and the
// faint `Try again` word at the right end of the line. `props.ts` declares the grammar and props
// all three shapes share.

import "./Refusal.css";

import { GLYPH_SIZE_CHROME } from "#renderer/styles/glyphs.js";
import { Glyph } from "../Glyph/Glyph.js";
import { TryAgainButton } from "../TryAgainButton/TryAgainButton.js";
import { formatWireString } from "#renderer/lib/wire/figures.js";
import { type RefusalProps } from "./props.js";

/** Props for `InlineRefusal`. */
export interface InlineRefusalProps extends RefusalProps {
  /** Asks again for what failed; given, the line draws as the page's strip ending in `Try again`. */
  readonly onTryAgain?: (() => void) | undefined;
}

/** Beside the control that was pressed. Nothing changed; the control stays. */
export function InlineRefusal(props: InlineRefusalProps): React.JSX.Element {
  const isStrip = props.onTryAgain !== undefined;
  return (
    <span
      className={`meridian-refusal ${isStrip ? "meridian-refusal--strip" : "meridian-refusal--inline"}`}
      role="status"
      data-refusal-code={props.code}
    >
      {isStrip ? null : <Glyph name="alert" size={GLYPH_SIZE_CHROME} />}
      <span className="meridian-refusal__message">{formatWireString(props.detail)}</span>
      {props.action !== undefined ? (
        <span className="meridian-refusal__action">{props.action}</span>
      ) : null}
      {props.onTryAgain === undefined ? null : (
        <span className="meridian-refusal__try-again">
          <TryAgainButton onPress={props.onTryAgain} />
        </span>
      )}
    </span>
  );
}
