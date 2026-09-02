// The edit-and-resend editor's slot — reserved, not stubbed.
//
// THE AFFORDANCE IS SPLIT ACROSS TWO OWNERS, AND THIS IS THE COMPOSER'S HALF. The
// pencil that opens it lives in the footer of a participant `user.message` row and
// belongs to the family that builds the ledger. The BODY it opens — the inline
// editor and the confirm that dispatches the existing `rollback` intervention
// carrying `replacementSend` — is authored by the run-controls plan, not here. What
// this file owns is the seat that body mounts into and the three facts such a seat
// has to answer.
//
// WHY THERE IS NO STUB EDITOR BEHIND IT. A textarea and a confirm button would be
// four lines and would be the worst thing in this directory: the confirm would
// either do nothing, or invent an eligibility rule the daemon owns. The affordance
// is a fail-closed projection of a daemon predicate, never a second source of
// eligibility truth, so the console renders the seat's absence rather than a
// control that looks live.
//
// GOVERNANCE IDS LIVE IN THIS COMMENT AND NOT IN THE VALUE. Every member of the
// contract below is a string a program holds at runtime, and the repository keeps
// plan, spec, and task ids out of runtime strings — so the prose names the owning
// work and a reader who needs the identifier reads it here: the body is Plan-004's
// task T4.8, handed to this console under the obligation that pairs with it.

import { Nothing } from "../../../console/primitives/index.js";
import type { OwnerSlotContract, OwnerSlotProps } from "../../../console/seats/index.js";

/** The three facts this seat answers. Developer-facing; never rendered. */
export const EDIT_RESEND_SLOT_CONTRACT: OwnerSlotContract = {
  owningTask: "the queue-and-intervention plan's edit-and-resend affordance",
  mountObligation:
    "the composer supplies the inline editor's placement inside the row it was opened from, its accessible framing, and the draft it is seeded with; the body owns the eligibility predicate it projects, the confirm, and the intervention it dispatches",
  deleteShellIn: "the PR that mounts the edit-and-resend body into this seat",
};

/**
 * One plan-owned seat, rendered the composer's own way.
 *
 * There is deliberately no shared owner-slot component in the console — the empty
 * state, the placement, and the grouping are each the mounting family's decision.
 */
export function EditResendSlot(props: OwnerSlotProps<React.ReactNode>): React.JSX.Element {
  if (props.body !== undefined) {
    return <div className="meridian-composer__edit-resend">{props.body}</div>;
  }
  return (
    <div className="meridian-composer__edit-resend">
      <Nothing
        kind="not-checked"
        title="Correcting a sent message has not been built yet."
        detail="The editor rewinds the run to the message it replaces, so it arrives with the control that performs that rewind rather than with a box that only looks like one."
      />
    </div>
  );
}
