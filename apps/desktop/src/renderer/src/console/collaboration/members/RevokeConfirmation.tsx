import { ConfirmationDialog } from "../../primitives/index.js";
import {
  MEMBERSHIP_ACTION_NOTES,
  MEMBERSHIP_ROLE_NOTES,
  type MembershipRow,
} from "./members-model.js";

/**
 * Revoking, and what it costs, stated before it happens.
 *
 * An alert dialog rather than a menu item: it traps focus, it has no default
 * dismissal on outside press, and its description is the consequence sentence for
 * THIS row's role. A role whose revocation the contract gives no named cost gets
 * the plain sentence rather than an invented one.
 *
 * THE PARTS ARE `primitives/ConfirmationDialog.tsx`'S AND THE WORDS ARE THIS FILE'S.
 * The settings family was composing the same eight Base UI parts for its own
 * confirming acts and neither family could import the other's — view families are
 * siblings — so the composition moved down to the layer both already import. What is
 * left here is what is genuinely this row's: which role's cost the sentence names,
 * that the trigger is a members row-action rather than a page action, and that
 * revoking is a destructive act.
 */
export function RevokeConfirmation(props: {
  readonly row: MembershipRow;
  /** Some row's change is in flight, so this row's confirmation cannot be opened. */
  readonly isAnyPending: boolean;
  readonly onConfirm: () => void;
}): React.JSX.Element {
  const cost =
    props.row.role === undefined ? undefined : MEMBERSHIP_ROLE_NOTES[props.row.role].revocationCost;
  return (
    <ConfirmationDialog
      triggerLabel={MEMBERSHIP_ACTION_NOTES.revoke.label}
      triggerAriaLabel={`Revoke the membership of ${props.row.participantId}`}
      triggerClassName="meridian-members__revoke"
      isDisabled={props.isAnyPending}
      title="Revoke this membership?"
      description={cost ?? "The membership ends. Nothing else about the session changes."}
      keepLabel="Keep it"
      confirmLabel="Revoke"
      tone="destructive"
      onConfirm={props.onConfirm}
    />
  );
}
