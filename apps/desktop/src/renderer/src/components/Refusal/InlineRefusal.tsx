// The inline shape: one line beside the control that was pressed, with the control still there.
// Handed a try-again, it draws the strip shape instead: no mark, the refusal's message, or the
// screen's fixed sentence for it, and the faint `Try again` word at the right end of the line. `props.ts` declares the grammar and
// the props every shape shares.

import "./Refusal.css";

import { GLYPH_SIZE_CHROME } from "#renderer/styles/glyphs.js";
import { Glyph } from "../Glyph/Glyph.js";
import { TryAgainButton } from "../TryAgainButton/TryAgainButton.js";
import { formatWireString } from "#renderer/lib/wire/figures.js";
import { type RefusalProps } from "./props.js";

/** Props for `InlineRefusal`. */
export interface InlineRefusalProps extends RefusalProps {
  /** Asks again for what failed; given, the line draws as the strip ending in `Try again`. */
  readonly onTryAgain?: (() => void) | undefined;
}

/**
 * Beside the control that was pressed, with its mark; or, given `onTryAgain`, a page's strip for a
 * failed write or read, with no mark and `Try again` ending the line. Nothing changed either way.
 */
export function InlineRefusal(props: InlineRefusalProps): React.JSX.Element {
  const isStrip = props.onTryAgain !== undefined;
  const shapeClassName = isStrip ? "meridian-refusal--strip" : "meridian-refusal--inline";
  return (
    <span
      className={`meridian-refusal ${shapeClassName}`}
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
