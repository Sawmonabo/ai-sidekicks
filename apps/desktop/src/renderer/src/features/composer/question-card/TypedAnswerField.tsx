// The typed answer every question takes, whatever the provider declared: both providers
// always accept typed text, so this is the one answer path that is always there. A component
// because the label-to-field id comes from a hook. A refusal of what was typed reads under it.

import { useId } from "react";

import { TextBox } from "#renderer/components/TextBox/TextBox.js";

/** What the card hands one question's typed field. */
export interface TypedAnswerFieldProps {
  /** The typed text the card holds for this question. */
  readonly draft: string;
  /**
   * Whether the card has closed the field — a delivery in flight or already taken. A boolean,
   * not the reason: the card draws the reason once, below the questions.
   */
  readonly isClosed: boolean;
  /** Why what was typed is refused in place, drawn under the field; absent while it is not. */
  readonly issue?: string | undefined;
  readonly onDraftChange: (draft: string) => void;
}

/** The free-text field under a question, labeled for screen readers. */
export function TypedAnswerField(props: TypedAnswerFieldProps): React.JSX.Element {
  // Minted per mount, never composed from the question: one question can be drawn in two
  // panes, and a shared `id` would make a label click focus the wrong field and leave the
  // other unlabeled to a screen reader.
  const fieldId = useId();
  const issueId = `${fieldId}-issue`;
  return (
    <div className="meridian-input-ask__free-text meridian-form__field">
      <label htmlFor={fieldId} className="meridian-visually-hidden">
        Something else…
      </label>
      <TextBox
        id={fieldId}
        className="meridian-input-ask__field meridian-form__input"
        fieldClassName="meridian-form__text-area"
        placeholder="Something else…"
        value={props.draft}
        rows={2}
        disabled={props.isClosed}
        aria-invalid={props.issue === undefined ? undefined : true}
        aria-describedby={props.issue === undefined ? undefined : issueId}
        onChange={(event) => {
          props.onDraftChange(event.target.value);
        }}
      />
      {props.issue === undefined ? null : (
        <p id={issueId} className="meridian-input-ask__issue">
          {props.issue}
        </p>
      )}
    </div>
  );
}
