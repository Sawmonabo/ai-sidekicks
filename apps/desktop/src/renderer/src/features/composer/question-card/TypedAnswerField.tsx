// The typed answer every question takes, whatever the provider declared.
//
// ITS OWN COMPONENT FOR ITS FIELD ID. The label and the field are tied by an id minted
// per mount, and minting one is a hook, so this is a component rather than a render
// helper. The draft it shows is the card's: the card holds every question's answer so
// that all of them go back together in one call.
//
// UNCONDITIONAL, WHICH IS THE POINT. Both providers always take a typed answer, and a
// question may offer no options at all, so this field is the one answer path that is
// always there.

import { useId } from "react";

export interface TypedAnswerFieldProps {
  /** The typed text the card holds for this question. */
  readonly draft: string;
  /**
   * Whether the card has closed the field — a delivery in flight or already taken.
   *
   * A BOOLEAN AND NOT THE REASON, because the card draws the reason once below the
   * questions, and a second rendering of it here would be the same sentence twice on one
   * card. What this field owes is the affordance.
   */
  readonly isClosed: boolean;
  readonly onDraftChange: (draft: string) => void;
}

export function TypedAnswerField(props: TypedAnswerFieldProps): React.JSX.Element {
  // MINTED PER MOUNT AND NEVER COMPOSED FROM THE QUESTION. One question can be drawn in
  // two panes at once, and an id built from it would give both fields the same `id`, at
  // which point a click on either label focuses whichever the document reached first and
  // the second field is unlabeled to a screen reader. `useId` is unique per rendered
  // instance, which is what the DOM requires.
  const fieldId = useId();
  return (
    <div className="meridian-input-ask__free-text">
      <label htmlFor={fieldId}>Something else…</label>
      <textarea
        id={fieldId}
        className="meridian-input-ask__field"
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
