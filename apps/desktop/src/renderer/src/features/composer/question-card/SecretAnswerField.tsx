// The masked field a secret question draws in place of option rows and the typed field.
// The browser is told not to offer or keep the value, which lives only in the card's drafts.

/** What the card hands a secret question's field. */
export interface SecretAnswerFieldProps {
  /** The question the field answers, which is also its accessible name. */
  readonly questionText: string;
  readonly value: string;
  readonly onValueChange: (value: string) => void;
}

/** A secret question's masked answer field. */
export function SecretAnswerField(props: SecretAnswerFieldProps): React.JSX.Element {
  return (
    <input
      type="password"
      className="meridian-input-ask__field meridian-form__input"
      aria-label={props.questionText}
      autoComplete="off"
      spellCheck={false}
      value={props.value}
      onChange={(event) => {
        props.onValueChange(event.target.value);
      }}
    />
  );
}
