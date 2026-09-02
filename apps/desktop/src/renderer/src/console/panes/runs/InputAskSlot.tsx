// The run row's hole for the input-ask card.
//
// `Spec-023 §Console Design (Meridian)` names the input-ask card as a surface the
// timeline family owns: the `driver_ask.*` family is fully specified daemon-side
// and a provider blocking on a structured question must have somewhere on screen to
// be answered. This pane is where a run that is blocked on input is LISTED, so this
// is where the card is mounted — and the card itself is authored by the plan that
// owns it.
//
// `console/workspace/seats/owner-slot.ts` says why this is a type and not a
// component: a slot is rendered by the family that mounts it, in that family's own
// layout, with that family's own empty-state treatment. What is shared is the
// declaration of the three facts a slot has to answer, and this file answers them.
//
// THE SHELL IS `not-checked`, NOT `empty`. "There is no question waiting" is a real
// answer this row will give once the card exists, and it is a different sentence
// from "the console has not asked". Rendering the former before the card exists
// would synthesise a state the daemon never served.

import { Nothing } from "../../primitives/index.js";
import { type OwnerSlotContract, type OwnerSlotProps } from "../../workspace/index.js";

/**
 * Who owns the body, what this pane owes it, and where the shell dies.
 *
 * Developer-facing and never rendered — every member is prose that names
 * governance work, and the console's runtime strings carry no governance ids.
 */
export const INPUT_ASK_SLOT_CONTRACT: OwnerSlotContract = {
  owningTask: "Plan-013 — the timeline family's input-ask card (the `driver_ask.*` surface)",
  mountObligation:
    "The run row supplies the run id and the daemon-reported run state, and mounts the body only while that state is `waiting_for_input`. The answer travels the already-registered `driver.respondToRequest`; this pane neither composes nor forwards it.",
  deleteShellIn:
    "The task that authors the input-ask card deletes this shell rather than leaving it beside the body.",
};

/** What the run row hands the card. */
export interface InputAskSlotBodyProps {
  readonly runId: string;
}

export interface InputAskSlotProps extends OwnerSlotProps<
  (props: InputAskSlotBodyProps) => React.ReactNode
> {
  readonly runId: string;
}

/**
 * Mount the card, or state that the surface is reserved.
 *
 * The shell is deliberately not a placeholder that looks like a broken feature: it
 * names the FEATURE that is absent and says what will land there, which is what the
 * five kinds of nothing exist to make possible.
 */
export function InputAskSlot(props: InputAskSlotProps): React.JSX.Element {
  if (props.body !== undefined) {
    return <div className="meridian-run-row__ask">{props.body({ runId: props.runId })}</div>;
  }
  return (
    <div className="meridian-run-row__ask">
      <Nothing
        kind="not-checked"
        placement="inline"
        title="This run is waiting on an answer."
        detail="The card that carries the provider's question and the reply field is built by the surface that owns structured asks. Until it lands, this row says the run is blocked rather than showing a question it cannot render."
      />
    </div>
  );
}
