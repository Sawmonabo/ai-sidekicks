// The inline shape: one line beside the control that was pressed, with the control still there.
// Handed a try-again, it draws the strip shape instead: no mark, the refusal's message, or the
// screen's fixed sentence for it, and the faint `Try again` word at the right end of the line.
// `props.ts` declares the grammar and the props every shape shares.
//
// Not a live region: the line mounts already holding its words, which most screen readers never
// announce, so it speaks them once through the app's announcer, on the assertive lane kept for
// refusals. A wrapper must not add a live role, or the sentence is read twice.

import "./Refusal.css";

import { GLYPH_SIZE_CHROME } from "#renderer/styles/glyphs.js";
import { Glyph } from "../Glyph/Glyph.js";
import { TryAgainButton } from "../TryAgainButton/TryAgainButton.js";
import { formatWireString } from "#renderer/lib/wire/figures.js";
import { useAnnounceWhenShown } from "#renderer/hooks/announce/useAnnounceWhenShown.js";
import { type RefusalProps } from "./props.js";

/** Props for `InlineRefusal`. */
export interface InlineRefusalProps extends RefusalProps {
  /** Asks again for what failed; given, the line draws as the strip ending in `Try again`. */
  readonly onTryAgain?: (() => void) | undefined;
  /**
   * What a screen reader is told, where the caller draws more words beside the line (a remedy
   * sentence). Defaults to the refusal's own sentence; the action and `Try again` are never read
   * out.
   */
  readonly announcement?: string;
  /**
   * The attempt this refusal answers, for a retry that can end in the same words: a new value says
   * them again. Keep its identity across renders (the refusal the retry replaces).
   */
  readonly attempt?: unknown;
}

/**
 * Beside the control that was pressed, with its mark; or, given `onTryAgain`, a page's strip for a
 * failed write or read, with no mark and `Try again` ending the line. Nothing changed either way.
 */
export function InlineRefusal(props: InlineRefusalProps): React.JSX.Element {
  const detail = formatWireString(props.detail);
  useAnnounceWhenShown(props.announcement ?? detail, "assertive", props.attempt);
  const isStrip = props.onTryAgain !== undefined;
  const shapeClassName = isStrip ? "meridian-refusal--strip" : "meridian-refusal--inline";
  return (
    <span className={`meridian-refusal ${shapeClassName}`} data-refusal-code={props.code}>
      {isStrip ? null : <Glyph name="alert" size={GLYPH_SIZE_CHROME} />}
      <span className="meridian-refusal__message">{detail}</span>
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
