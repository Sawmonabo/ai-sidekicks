// The typed answer every question takes, whatever the provider declared.
//
// ITS OWN MODULE BECAUSE IT IS THE ONE PART OF THE CARD THAT HOLDS STATE. Everything
// else the card draws is a branch of one render over the question it was handed; this
// holds a draft between keystrokes, so it is a component with an identity and a
// lifetime of its own rather than a render helper — and a `.tsx` module declares one
// component.
//
// THE DRAFT IS DELIBERATELY NOT PERSISTED. It is a half-typed answer to one question,
// and once the question settles the field it belonged to is gone, so keeping it past
// the card is keeping text a reader will never be offered the chance to send. The console's durable writes go through `store/persistence/`
// and its value-class enumeration, and a draft is exactly what that module declines.
//
// AND IT IS NOT DROPPED ON DISPATCH EITHER, which is the half this arm used to get
// wrong. Clearing the field the instant the callback returned threw the user's
// words away before anything knew whether they had reached the daemon, so a refused
// delivery left an empty field, a still-blocked run, and nothing to retry from. The
// draft now survives until the delivery says `accepted` — the one arm that means the
// answer landed — and a refusal leaves the text exactly where it was typed.
//
// UNCONDITIONAL, WHICH IS THE POINT. Both providers always take a typed answer, and a
// question may offer no options at all, so this arm is the only answer path that is
// always there.

import { useEffect, useId, useState } from "react";

import { type AnswerDelivery } from "@renderer/store/session-events/question-reading.js";

export interface TypedAnswerFieldProps {
  /** Where the answer this card last dispatched has got to. */
  readonly delivery: AnswerDelivery;
  /**
   * Whether the card has closed the field — a delivery in flight or already taken.
   *
   * A BOOLEAN AND NOT THE REASON, because the card draws the reason once below the field,
   * and a second rendering of it here would be the same sentence twice on one card. What
   * this arm owes is the affordance.
   */
  readonly isClosed: boolean;
  readonly onAnswer: (response: string) => void;
}

export function TypedAnswerField(props: TypedAnswerFieldProps): React.JSX.Element {
  const [draft, setDraft] = useState("");
  // MINTED PER MOUNT AND NEVER COMPOSED FROM THE QUESTION. One question can be drawn in
  // two panes at once, and an id built from it would give both fields the same `id`, at
  // which point a click on either label focuses whichever the document reached first and
  // the second field is unlabeled to a screen reader. `useId` is the console's own
  // mechanism for exactly this, and it is unique per rendered instance, which is what the
  // DOM requires.
  const fieldId = useId();
  const deliveryStatus = props.delivery.status;
  // THE ONE EFFECT, AND IT IS A TRANSITION RATHER THAN A DERIVATION. The field is
  // cleared when the delivery REACHES `accepted`, which is a moment and not a
  // condition — rendering an empty value on that status would leave the user's
  // text in state, invisible, and back on screen the moment anything moved the arm
  // out of that status.
  useEffect(() => {
    if (deliveryStatus === "accepted") {
      setDraft("");
    }
  }, [deliveryStatus]);
  return (
    <form
      className="meridian-input-ask__free-text"
      onSubmit={(event) => {
        event.preventDefault();
        // BOTH CONDITIONS THE SUBMIT CONTROL IS DISABLED ON, so the guard and the
        // affordance cannot disagree. An empty draft is not an answer and delivering
        // one would settle a real question with nothing in it; a closed arm is a
        // delivery already out or one already taken.
        if (draft.length > 0 && !props.isClosed) {
          props.onAnswer(draft);
        }
      }}
    >
      <label htmlFor={fieldId}>Answer in your own words</label>
      <textarea
        id={fieldId}
        className="meridian-input-ask__field"
        value={draft}
        rows={2}
        disabled={props.isClosed}
        onChange={(event) => {
          setDraft(event.target.value);
        }}
      />
      <button
        type="submit"
        className="meridian-input-ask__send meridian-action-button"
        disabled={draft.length === 0 || props.isClosed}
      >
        Send answer
      </button>
    </form>
  );
}
