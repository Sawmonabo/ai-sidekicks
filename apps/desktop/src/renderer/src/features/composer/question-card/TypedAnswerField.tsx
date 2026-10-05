// The typed answer every question takes, whatever the provider declared: both providers
// always accept typed text, so this is the one answer path that is always there. A component
// because the label-to-field id comes from a hook.

import { useId } from "react";

/** What the card hands one question's typed field. */
export interface TypedAnswerFieldProps {
  /** The typed text the card holds for this question. */
  readonly draft: string;
  /**
   * Whether the card has closed the field — a delivery in flight or already taken. A boolean,
   * not the reason: the card draws the reason once, below the questions.
   */
  readonly isClosed: boolean;
  readonly onDraftChange: (draft: string) => void;
}

/** The free-text field under a question, labeled for screen readers. */
export function TypedAnswerField(props: TypedAnswerFieldProps): React.JSX.Element {
  // Minted per mount, never composed from the question: one question can be drawn in two
  // panes, and a shared `id` would make a label click focus the wrong field and leave the
  // other unlabeled to a screen reader.
  const fieldId = useId();
  return (
    <div className="meridian-input-ask__free-text meridian-form__field">
      <label htmlFor={fieldId} className="meridian-visually-hidden">
        Something else…
      </label>
      <textarea
        id={fieldId}
        className="meridian-input-ask__field meridian-form__input"
        placeholder="Something else…"
        value={props.draft}
        rows={2}
        disabled={props.isClosed}
        onChange={(event) => {
          props.onDraftChange(event.target.value);
        }}
      />
    </div>
  );
}
