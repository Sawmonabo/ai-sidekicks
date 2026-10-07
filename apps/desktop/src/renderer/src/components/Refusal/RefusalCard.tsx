// The card shape: a block in place of what could not be shown, with the code's words over the
// message. Not a live region: the card speaks through the app's announcer, on the assertive lane
// kept for refusals; the action is not read out.

import "./Refusal.css";

import { GLYPH_SIZE_CHROME } from "#renderer/styles/glyphs.js";
import { Glyph } from "../Glyph/Glyph.js";
import { formatWireString } from "#renderer/lib/wire/figures.js";
import { refusalSentence } from "#renderer/lib/code-words.js";
import { useAnnounceWhenShown } from "#renderer/hooks/announce/useAnnounceWhenShown.js";
import { type RefusalProps } from "./props.js";
import { RefusalWords } from "./RefusalWords.js";

/** Props for `RefusalCard`. */
export interface RefusalCardProps extends RefusalProps {
  /** Words the caller draws in the action region (a remedy sentence), read out after the card's. */
  readonly remedyWords?: string | undefined;
  /**
   * The attempt this refusal answers, for a retry that can end in the same words: a new value says
   * them again. Keep its identity across renders (the refusal the retry replaces).
   */
  readonly attempt?: unknown;
}

/** A refusal as a block: a registered code's words, then the message. */
export function RefusalCard(props: RefusalCardProps): React.JSX.Element {
  const detail = formatWireString(props.detail);
  const sentence = refusalSentence(props.code, props.reason, detail);
  useAnnounceWhenShown(
    props.remedyWords === undefined ? sentence : `${sentence} ${props.remedyWords}`,
    "assertive",
    { attempt: props.attempt },
  );
  return (
    <div className="meridian-refusal meridian-refusal--card" data-refusal-code={props.code}>
      <div className="meridian-refusal__head">
        <Glyph name="alert" size={GLYPH_SIZE_CHROME} />
        <div className="meridian-refusal__body">
          <RefusalWords code={props.code} reason={props.reason} />
          <p className="meridian-refusal__message">{detail}</p>
        </div>
      </div>
      {props.action !== undefined ? (
        <div className="meridian-refusal__action">{props.action}</div>
      ) : null}
    </div>
  );
}
