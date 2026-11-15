// The inline shape: one line beside the control that was pressed, with the control still there.
// The line reads a code the service registered as its words, since the service's sentence can
// name an id, and a refusal the app wrote as its own sentence. Handed a try-again, it draws the
// strip shape instead: no mark, the screen's own sentence for the failed read or write, and the
// faint `Try again` word at the right end of the line.
// `props.ts` declares the grammar and the props every shape shares.
//
// Not a live region: the line speaks through the app's announcer, on the assertive lane kept for
// refusals. A wrapper must not add a live role, or the sentence is read twice.

import "./Refusal.css";

import { GLYPH_SIZE_CHROME } from "#renderer/styles/glyphs.js";
import { Glyph } from "../Glyph/Glyph.js";
import { TryAgainButton } from "../TryAgainButton/TryAgainButton.js";
import { refusalCause } from "#renderer/lib/code-words.js";
import { formatWireString } from "#renderer/lib/wire/figures.js";
import { useAnnounceWhenChanged } from "#renderer/hooks/announce/useAnnounceWhenChanged.js";
import { type RefusalProps } from "./props.js";

/** Props for `InlineRefusal`. */
export interface InlineRefusalProps extends RefusalProps {
  /** Asks again for what failed; given, the line draws as the strip ending in `Try again`. */
  readonly onTryAgain?: (() => void) | undefined;
  /**
   * Words the caller draws beside the line (a remedy sentence), read out after the refusal's own.
   * The action and `Try again` are never read out.
   */
  readonly remedyWords?: string | undefined;
  /**
   * The attempt this refusal answers, for a retry that can end in the same words: a new value says
   * them again. Keep its identity across renders (the refusal the retry replaces).
   */
  readonly attempt?: unknown;
  /**
   * The refusal was already standing when the person arrived (an outcome a stream replayed): it is
   * drawn but not said until it changes.
   */
  readonly isStanding?: boolean | undefined;
}

/**
 * Beside the control that was pressed, with its mark and the code's words; or, given `onTryAgain`,
 * a page's strip for a failed write or read, with no mark, `detail` as the caller worded it, and
 * `Try again` ending the line. Nothing changed either way.
 */
export function InlineRefusal(props: InlineRefusalProps): React.JSX.Element {
  const isStrip = props.onTryAgain !== undefined;
  const detail = formatWireString(props.detail);
  const words = isStrip ? detail : refusalCause(props.code, props.reason, detail);
  useAnnounceWhenChanged(
    props.remedyWords === undefined ? words : `${words} ${props.remedyWords}`,
    "assertive",
    { attempt: props.attempt, isStanding: props.isStanding },
  );
  const shapeClassName = isStrip ? "meridian-refusal--strip" : "meridian-refusal--inline";
  return (
    <span className={`meridian-refusal ${shapeClassName}`} data-refusal-code={props.code}>
      {isStrip ? null : <Glyph name="alert" size={GLYPH_SIZE_CHROME} />}
      <span className="meridian-refusal__message">{words}</span>
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
