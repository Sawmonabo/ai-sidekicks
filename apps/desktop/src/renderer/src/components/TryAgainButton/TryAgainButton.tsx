// The one shape every try-again takes: a faint clickable word at the end of the line it belongs
// to, with no box, no border and no icon. A reading asked again on a person's press takes it too.

/** The words a try-again reads, as the line it ends names it. */
export type TryAgainWord = "Try again" | "Retry" | "Check again" | "Sign in again";

/** Props for `TryAgainButton`. */
export interface TryAgainButtonProps {
  /** `Try again` unless the line's own words name another. */
  readonly word?: TryAgainWord;
  readonly onPress: () => void;
}

/** A faint word that asks again for what its line failed or read. */
export function TryAgainButton(props: TryAgainButtonProps): React.JSX.Element {
  return (
    <button type="button" className="meridian-clickable-word" onClick={props.onPress}>
      {props.word ?? "Try again"}
    </button>
  );
}
