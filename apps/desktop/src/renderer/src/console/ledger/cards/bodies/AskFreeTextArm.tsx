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
// UNCONDITIONAL, WHICH IS THE POINT. One of the two pinned provider mechanisms cannot
// declare a choice set at all, and an oversized set is dropped at the driver's own
// boundary rather than truncated — so an ask with no options is the ordinary case and
// this arm is the only answer path that is always there.

import { useState } from "react";

export interface AskFreeTextArmProps {
  /** Names the field to a reader and keeps two open asks' labels apart. */
  readonly askId: string;
  readonly onAnswer: (response: string) => void;
}

export function AskFreeTextArm(props: AskFreeTextArmProps): React.JSX.Element {
  const [draft, setDraft] = useState("");
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
          setDraft("");
        }
      }}
    >
      <label htmlFor={fieldId}>Answer in your own words</label>
      <textarea
        id={fieldId}
        className="meridian-input-ask__field"
        value={draft}
        rows={2}
        onChange={(event) => {
          setDraft(event.target.value);
        }}
      />
      <button type="submit" className="meridian-input-ask__send" disabled={draft.length === 0}>
        Send answer
      </button>
    </form>
  );
}
