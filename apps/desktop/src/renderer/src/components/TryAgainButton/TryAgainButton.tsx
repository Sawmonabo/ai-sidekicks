// The one shape every try-again takes: a faint clickable word at the end of the line it belongs
// to, with no box, no border and no icon.

import "./TryAgainButton.css";

/** The two words a try-again reads, as the line it ends names it. */
export type TryAgainWord = "Try again" | "Retry";

/** Props for `TryAgainButton`. */
export interface TryAgainButtonProps {
  /** `Try again` unless the line's own words say `Retry`. */
  readonly word?: TryAgainWord;
  readonly onPress: () => void;
}

/** A faint word that asks again for what failed on its line. */
export function TryAgainButton(props: TryAgainButtonProps): React.JSX.Element {
  return (
    <button type="button" className="meridian-try-again" onClick={props.onPress}>
      {props.word ?? "Try again"}
    </button>
  );
}
