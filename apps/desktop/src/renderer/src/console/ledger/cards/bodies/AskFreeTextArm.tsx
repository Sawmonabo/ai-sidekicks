// The answer arm every ask carries, whatever the provider declared.
//
// ITS OWN MODULE BECAUSE IT IS THE ONE PART OF THE CARD THAT HOLDS STATE. Everything
// else the card draws is a branch of one render over the ask it was handed; this
// holds a draft between keystrokes, so it is a component with an identity and a
// lifetime of its own rather than a render helper — and a `.tsx` module declares one
// component.
//
// THE DRAFT IS DELIBERATELY NOT PERSISTED. It is a half-typed answer to a question
// whose deadline the daemon stamped, so keeping it past the row is keeping text a
// reader will never be offered the chance to send: the ask settles and the field it
// belonged to is gone. The console's durable writes go through its persistence family
// and its value-class enumeration, and a draft is exactly what that family declines.
//
// AND IT IS NOT DROPPED ON DISPATCH EITHER, which is the half this arm used to get
// wrong. Clearing the field the instant the callback returned threw the user's
// words away before anything knew whether they had reached the driver, so a refused
// delivery left an empty field, a still-blocked run, and nothing to retry from. The
// draft now survives until the delivery says `accepted` — the one arm that means the
// answer landed — and a refusal leaves the text exactly where it was typed.
//
// UNCONDITIONAL, WHICH IS THE POINT. One of the two pinned provider mechanisms cannot
// declare a choice set at all, and an oversized set is dropped at the driver's own
// boundary rather than truncated — so an ask with no options is the ordinary case and
// this arm is the only answer path that is always there.

import { useEffect, useId, useState } from "react";

import { type DriverAskDelivery } from "./input-ask.js";

export interface AskFreeTextArmProps {
  /** Where the answer this card last dispatched has got to. */
  readonly delivery: DriverAskDelivery;
  /**
   * Whether the card has closed both arms — a delivery in flight or already taken, or
   * a supervisor that is not serving.
   *
   * A BOOLEAN AND NOT THE BLOCK, because the card draws the reason once above both
   * arms: an option group and this field are shut by one condition, and a second
   * rendering of it here would be the same sentence twice on one card. What this arm
   * owes is the affordance.
   */
  readonly isClosed: boolean;
  readonly onAnswer: (response: string) => void;
}

export function AskFreeTextArm(props: AskFreeTextArmProps): React.JSX.Element {
  const [draft, setDraft] = useState("");
  // MINTED PER MOUNT AND NEVER COMPOSED FROM THE ASK. `askId` is the PROVIDER's,
  // minted per provider session, so two runs blocked at once legitimately raise the
  // same one — and an id built from it gave both fields the same `id`, at which point
  // a click on either label focuses whichever the document reached first and the second
  // ask's field is unlabelled to a screen reader. A composite over `(runId, askId)`
  // would fix that pair and not the general one: nothing stops one ask from being
  // rendered in two panes at once. `useId` is the console's own mechanism for exactly
  // this, and it is unique per rendered instance, which is what the DOM requires.
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
        // one would settle a real ask with nothing in it; a closed arm is a delivery
        // already out, one already taken, or a runtime that is not serving.
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
        className="meridian-input-ask__send"
        disabled={draft.length === 0 || props.isClosed}
      >
        Send answer
      </button>
    </form>
  );
}
