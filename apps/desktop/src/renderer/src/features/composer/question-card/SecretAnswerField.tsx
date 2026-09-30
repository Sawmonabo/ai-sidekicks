// The one masked field a secret question draws, in place of option rows and the typed
// field.
//
// MASKED AND NEVER REMEMBERED. The value is shown as dots, the browser is told not to
// offer or keep it, and it lives only in the card's drafts until the daemon takes it.

/** What the card hands a secret question's field. */
export interface SecretAnswerFieldProps {
  /** The question the field answers, which is also its accessible name. */
  readonly questionText: string;
  readonly value: string;
  /** Whether the card has closed the field — a delivery in flight or already taken. */
  readonly isClosed: boolean;
  readonly onValueChange: (value: string) => void;
}

/** A secret question's masked answer field. */
export function SecretAnswerField(props: SecretAnswerFieldProps): React.JSX.Element {
  return (
    <input
      type="password"
      className="meridian-input-ask__field"
      aria-label={props.questionText}
      autoComplete="off"
      spellCheck={false}
      value={props.value}
      disabled={props.isClosed}
      onChange={(event) => {
        props.onValueChange(event.target.value);
      }}
    />
  );
}
