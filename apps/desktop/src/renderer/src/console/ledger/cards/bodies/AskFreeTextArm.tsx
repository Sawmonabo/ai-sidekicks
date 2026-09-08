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
// wrong. Clearing the field the instant the callback returned threw the participant's
// words away before anything knew whether they had reached the driver, so a refused
// delivery left an empty field, a still-blocked run, and nothing to retry from. The
// draft now survives until the delivery says `accepted` — the one arm that means the
// answer landed — and a refusal leaves the text exactly where it was typed.
//
// UNCONDITIONAL, WHICH IS THE POINT. One of the two pinned provider mechanisms cannot
// declare a choice set at all, and an oversized set is dropped at the driver's own
// boundary rather than truncated — so an ask with no options is the ordinary case and
// this arm is the only answer path that is always there.

import { useEffect, useState } from "react";

import { type DriverAskDelivery } from "./input-ask.js";

export interface AskFreeTextArmProps {
  /** Names the field to a reader and keeps two open asks' labels apart. */
  readonly askId: string;
  /** Where the answer this card last dispatched has got to. */
  readonly delivery: DriverAskDelivery;
  readonly onAnswer: (response: string) => void;
}

export function AskFreeTextArm(props: AskFreeTextArmProps): React.JSX.Element {
  const [draft, setDraft] = useState("");
  const deliveryStatus = props.delivery.status;
  // THE ONE EFFECT, AND IT IS A TRANSITION RATHER THAN A DERIVATION. The field is
  // cleared when the delivery REACHES `accepted`, which is a moment and not a
  // condition — rendering an empty value on that status would leave the participant's
  // text in state, invisible, and back on screen the moment anything moved the arm
  // out of that status.
  useEffect(() => {
    if (deliveryStatus === "accepted") {
      setDraft("");
    }
  }, [deliveryStatus]);
  // The two statuses in which this arm has nothing further to send: one answer is on
  // the wire, or one has already reached the driver. `refused` is deliberately not
  // among them — that is the state a retry is offered from.
  const isSettling = deliveryStatus === "delivering" || deliveryStatus === "accepted";
  const fieldId = `meridian-input-ask-${props.askId}`;
  return (
    <form
      className="meridian-input-ask__free-text"
      onSubmit={(event) => {
        event.preventDefault();
        // An empty draft is not an answer, and delivering one would settle a real
        // ask with nothing in it. The submit control is disabled on the same
        // condition, so the guard and the affordance cannot disagree.
        if (draft.length > 0) {
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
        disabled={isSettling}
        onChange={(event) => {
          setDraft(event.target.value);
        }}
      />
      <button
        type="submit"
        className="meridian-input-ask__send"
        disabled={draft.length === 0 || isSettling}
      >
        Send answer
      </button>
    </form>
  );
}
